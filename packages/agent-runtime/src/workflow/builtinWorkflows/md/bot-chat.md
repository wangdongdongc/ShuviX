---
shuvix: workflow v1
shuvix-builtin: true
name: bot-chat
description: The pipeline a bot runs in a chat session — decide whether to speak, then answer.
shuvix-workflow-concurrency: parallel
shuvix-workflow-limits:
  maxAgents: 4
  maxDurationSec: 2400
shuvix-workflow-vars:
  gateWindow: 8
  taskWindow: 20
  gateTimeoutSec: 60
  taskTimeoutSec: 1800
  recheckStale: true
shuvix-workflow-input:
  type: object
  required: [bot, agents, session, message]
  properties:
    bot: { type: object, required: [name, displayName, description, file] }
    agents:
      type: object
      required: [intent, task]
      properties:
        intent:
          type: string
          description: Decides whether the bot speaks, and how — one call, no tools, structured verdict
        task:
          type: string
          description: Does the work when the gate says so — its own tools, the bot's profile on its system prompt
        recheck:
          type: string
          description: Optional; re-judges a queued request after the bot already replied to something else (defaults to intent)
    session: { type: object, required: [id, directed, members] }
    message: { type: object, required: [id, text] }
    window: { type: array }
---

## What this is

Every bot in a chat session runs this file, once per message, per bot. It is the whole of
what a bot does, in order: decide whether to speak, settle who the message belongs to, and
answer.

A bot is a binding, not an agent: its md names this pipeline and fills the pipeline's
**slots** with agent definitions (`shuvix-bot-pipeline: {workflow: bot-chat, agents: {intent: …, task: …}}`). The bot md's
body — its persona and what it has learned — is not in any prompt below. The host appends
it, fenced, to the system prompt of every agent this run dispatches, the way project context
is appended. Keeping that body current is the task agent's own job, with its own file tools;
there is no separate notes stage.

There is no `shuvix-workflow-on` here: no trigger leads to this file. A bot points at it
(`shuvix-bot-pipeline.workflow: bot-chat`) and the session invokes it. `parallel` is deliberate:
run-level re-entry gets out of the way entirely, and one-thing-at-a-time is provided by
`turn()`, which serialises _this bot in this session_ — never the file, which many bots and
many sessions share at the same moment.

There is also no key saying "only a bot may call this" — the invocation path is not an
admission check. What makes this file a bot pipeline is simply that its script uses `say`,
`turn`, which only the bot caller assembles into the script API. Start it from
somewhere that does not and it fails on the first of those names, the way any script fails
on an undefined function.

## The pipeline

Everything is read off `input.*`. The script scope holds the base API plus whatever the
caller assembled (`say` / `turn`) — it does **not** flatten `input`, so a bare
`message` or `agents` would be a ReferenceError. Flattening happens only in the render scope
of a `md prompt=` block.

**Optional context is a nested prompt, never a bare placeholder.** The template language is
one thing wide — `{{path}}`, no conditions, no loops — and a line vanishes only when it holds
nothing but placeholders. So a heading that should disappear along with its value has to live
_inside_ that value: each optional section is its own `md prompt=` block, and the script turns
it into one string that is either whole or empty.

```js workflow
// ── The material. Prompts are prose and live in the blocks below; the script only picks.
const recent = (input.window || []).slice(-vars.gateWindow)
const otherLines = (input.session.others || []).map(function (o) {
  return '- ' + o.displayName + ': ' + o.description
})

// A message that named this bot — or that answers its own clarify — is addressed to it:
// silence is not on the table and `ignore` is not on the contract. Every other message goes
// through the normal gate, where this bot decides for itself whether it has anything to say.
const solo = input.session.directed

const othersBlock = otherLines.length ? prompt('others', { others: otherLines }) : ''
const windowBlock = recent.length ? prompt('window', { window: recent }) : ''
const addressed = solo ? prompt('addressed') : ''

// 1 ── The gate. One call, no tools, a minute of wall clock. The bot's own profile — persona
//      and memory — is not in this prompt: the host appends it to the system prompt of every
//      agent this run dispatches, the gate included.
let intent = null
let failure = null
try {
  intent = await run(
    input.agents.intent,
    prompt('gate', {
      othersBlock: othersBlock,
      windowBlock: windowBlock,
      addressed: addressed
    }),
    {
      schema: solo ? schemas.intentSolo : schemas.intent,
      // Narrows whatever the profile declares down to nothing. The builtin gate declares no
      // tools already; this line is what keeps a user's own override of it from growing any.
      tools: [],
      timeoutSec: vars.gateTimeoutSec
    }
  )
} catch (e) {
  const code = e && e.code
  // Being torn down is not evidence that the gate is broken: a faster bot won this message,
  // or the session was stopped. Yielding is the correct outcome and it costs nothing.
  if (code === 'step_aborted') return { outcome: 'aborted' }
  if (code !== 'next_not_called' && code !== 'step_timeout') throw e
  failure = code === 'step_timeout' ? 'timeout' : 'broken'
  log('gate ' + failure + ': ' + String((e && e.message) || e))
}

// 2 ── A broken contract or a timeout is a **fault, not a verdict**, and every bot answers
//      for its own ending: say so. Silence is reserved for one thing only — the gate deciding
//      this message was not for this bot.
if (!intent) {
  await say(prompt(failure === 'timeout' ? 'gateTimeout' : 'gateBroken'), { error: true })
  return { gate: failure, outcome: 'gate-' + failure }
}

// 3 ── The gate judged this message is not for this bot. That is the one silence a bot is
//      allowed: no message, no notice, just a line in the run journal.
if (intent.decision === 'ignore') {
  return { gate: 'ok', outcome: 'ignored' }
}

// 4 ── Anything answerable in one line is answered here — don't open a task for it.
if (intent.decision !== 'task') {
  const line = typeof intent.reply === 'string' ? intent.reply.trim() : ''
  if (!line) {
    // It said it would speak and then wrote nothing. Same class of fault as never calling
    // `next` — and it already committed to answering.
    await say(prompt('gateBroken'), { error: true })
    return { gate: 'broken', outcome: 'gate-broken' }
  }
  await say(line, { decision: intent.decision })
  return { gate: 'ok', outcome: intent.decision }
}

// 5 ── Take this bot's turn in this session: one job at a time, in arrival order.
return await turn(async function (slot) {
  if (slot.superseded.length) log('merged ' + slot.superseded.join(','))

  // Queued behind our own reply: that reply may already have covered this one.
  if (vars.recheckStale && slot.selfReplied) {
    const second = await recheck(slot, windowBlock)
    if (second && second.verdict === 'skip') {
      const line = typeof second.reply === 'string' ? second.reply.trim() : ''
      // Always one line out loud — a skip that says nothing is indistinguishable from a
      // dropped message.
      await say(line || prompt('recheckSkipped'), { decision: 'reply' })
      return { gate: 'ok', outcome: 'recheck-skipped', queuedMs: slot.queuedMs }
    }
  }

  // 6 ── The work itself. `input.agents.task` is whichever agent md the bot put in that slot:
  //      its own body is the system prompt, its own `shuvix-tools` the tool list, and the
  //      bot's profile rides along on the system prompt. There is deliberately no `tools`
  //      option here — narrowing it would overrule what that agent md said about itself, and
  //      unlike the gate (a shared builtin) this slot was chosen for exactly this job.
  const objective = (intent.task && intent.task.objective) || intent.reason
  const boundaries = (intent.task && intent.task.boundaries) || ''
  const taskLines = (input.window || []).slice(-vars.taskWindow)
  // Handles, not bytes (the script's own input is written to the run journal verbatim).
  // Nothing in the prompt announces them: whatever the host manages to fetch arrives as a
  // real user message in context, and a sentence claiming "2 images are above" would be a
  // lie on exactly the runs where the fetch failed.
  const attached = (input.message && input.message.attachments) || []

  let reply = null
  try {
    reply = await run(
      input.agents.task,
      prompt('task', {
        objective: objective,
        boundariesBlock: boundaries ? prompt('boundaries', { boundaries: boundaries }) : '',
        windowBlock: taskLines.length ? prompt('window', { window: taskLines }) : '',
        sinceBlock: slot.since && slot.since.length ? prompt('since', { since: slot.since }) : ''
      }),
      {
        schema: schemas.reply,
        timeoutSec: vars.taskTimeoutSec,
        // Whatever the user attached to the message. These are opaque handles, not bytes:
        // the script's own input is written into the run journal verbatim, so images travel
        // by reference and the host fetches them at dispatch.
        attach: attached
      }
    )
  } catch (e) {
    const code = e && e.code
    // Someone stopped the session, or this run lost its place. Saying so would be noise.
    if (code === 'step_aborted') return { gate: 'ok', outcome: 'aborted', queuedMs: slot.queuedMs }

    // It did the work and then wrote prose instead of filling in the contract. Someone is
    // waiting for an answer, and an answer with no shape beats no answer at all — so the
    // first line becomes the conclusion and the rest becomes the explanation.
    // A task agent that does not exist is a configuration mistake, not a run that broke:
    // retrying will never fix it, and "it broke partway through" sends the reader looking at
    // the wrong thing.
    if (code === 'unknown_agent') {
      await say(prompt('taskNoAgent', { agent: String(input.agents.task) }), { error: true })
      return { gate: 'ok', outcome: 'task-no-agent', queuedMs: slot.queuedMs }
    }

    const prose = ((e && e.finalText) || '').trim()
    if (code === 'next_not_called' && prose) {
      await say(wrapProse(prose), { decision: 'task' })
      return { gate: 'ok', outcome: 'task-unshaped', queuedMs: slot.queuedMs }
    }

    // Nothing usable came back. The failure has to be said out loud — silence here is
    // indistinguishable from a dropped message, and this bot already took the turn.
    await say(prompt(code === 'step_timeout' ? 'taskTimeout' : 'taskFailed'), { error: true })
    return {
      gate: 'ok',
      outcome: code === 'step_timeout' ? 'task-timeout' : 'task-failed',
      queuedMs: slot.queuedMs
    }
  }

  await say(reply, { decision: 'task' })
  return { gate: 'ok', outcome: 'task', queuedMs: slot.queuedMs, superseded: slot.superseded }
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** Prose with no shape → the least shape a reply is allowed to have. The first line carries
 *  the conclusion often enough to be worth promoting to one; a leading `#` is markdown
 *  furniture rather than a headline, so it goes. The last resort matters more than it looks:
 *  a `wrapProse` that returns an empty headline would make `say` throw **inside the
 *  degradation path**, turning "answer with no shape" into "no answer". */
function wrapProse(text) {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && !stripHeading(lines[i])) i++
  const first = stripHeading(lines[i] || '')
  if (!first) return { headline: text.trim().slice(0, 200) }
  const rest = lines
    .slice(i + 1)
    .join('\n')
    .trim()
  return rest ? { headline: first, body: rest } : { headline: first }
}

function stripHeading(line) {
  return String(line || '')
    .replace(/^#+\s*/, '')
    .trim()
}

/** The dequeue re-check. Failing it means proceeding: the queued request was going to be done
 *  anyway, and the check only ever saves a repeat. */
async function recheck(slot, windowBlock) {
  const sinceLines = (slot.since || []).slice(-vars.gateWindow)
  try {
    return await run(
      input.agents.recheck || input.agents.intent,
      prompt('recheck', {
        windowBlock: windowBlock,
        sinceBlock: sinceLines.length ? prompt('since', { since: sinceLines }) : ''
      }),
      { schema: schemas.recheck, tools: [], timeoutSec: vars.gateTimeoutSec }
    )
  } catch (e) {
    if (e && e.code === 'step_aborted') throw e
    log('recheck skipped: ' + String((e && e.code) || (e && e.message) || e))
    return null
  }
}
```

Anything that throws here ends the run, and the session says so in the chat — failures are
never silent. Silence is reserved for one thing only: the gate deciding a message was not
for this bot.

## Contracts

Each stage that returns data ends by calling `next` with an object shaped by one of these
blocks (the instruction to do so is added at dispatch, along with the schema itself). The
gate is offered `ignore` only when another bot could pick the message up: in a one-on-one
session, silence is indistinguishable from a broken bot.

```json schema=intent
{
  "type": "object",
  "required": ["decision", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify", "ignore"],
      "description": "reply = you can answer fully right now with no tools; task = it needs work; clarify = one question unblocks you; ignore = plainly meant for another bot"
    },
    "reason": { "type": "string", "maxLength": 200 },
    "reply": { "type": "string", "description": "The reply itself, for decision reply or clarify" },
    "task": {
      "type": "object",
      "properties": {
        "objective": { "type": "string" },
        "boundaries": { "type": "string" }
      }
    }
  }
}
```

```json schema=intentSolo
{
  "type": "object",
  "required": ["decision", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify"],
      "description": "This message was addressed to you, so answering is not optional. reply = answer now; task = it needs work; clarify = ask the one question that unblocks you."
    },
    "reason": { "type": "string", "maxLength": 200 },
    "reply": { "type": "string" },
    "task": {
      "type": "object",
      "properties": {
        "objective": { "type": "string" },
        "boundaries": { "type": "string" }
      }
    }
  }
}
```

```json schema=recheck
{
  "type": "object",
  "required": ["verdict"],
  "properties": {
    "verdict": {
      "enum": ["proceed", "skip"],
      "description": "proceed = the queued request still needs doing; skip = your own later reply already covers it"
    },
    "reply": { "type": "string", "description": "One line to close it out when skipping" }
  }
}
```

```json schema=reply
{
  "type": "object",
  "required": ["headline"],
  "properties": {
    "headline": { "type": "string", "description": "The answer in one sentence, first" },
    "body": {
      "type": "string",
      "description": "Markdown prose, when the answer really is an explanation"
    },
    "points": { "type": "array", "items": { "type": "string" } },
    "table": {
      "type": "object",
      "required": ["columns", "rows"],
      "properties": {
        "columns": { "type": "array", "items": { "type": "string" } },
        "rows": { "type": "array", "items": { "type": "array", "items": { "type": "string" } } }
      }
    },
    "status": { "enum": ["ok", "warn", "error"] },
    "followups": { "type": "array", "items": { "type": "string" } }
  }
}
```

## Prompts

The gate's own words. All of it is editable prose: copy this file to
`~/.shuvix/workflows/bot-chat.md` and it is yours.

```md prompt=gate
A message has just arrived in a chat session. Decide, on this bot's behalf, what to do with
it.

## The bot you speak for

{{bot.displayName}} — {{bot.description}}

{{othersBlock}}

{{addressed}}

{{windowBlock}}

## The new message

{{message.text}}
```

```md prompt=others
## The other bots in this session

{{others}}

These bots see this message too. One plainly aimed at one of them is theirs, not yours.
```

```md prompt=addressed
This message is addressed to this bot — it was named, or it answers a question this bot just
asked. Answering is not optional, and `ignore` is not on the contract.
```

```md prompt=window
## Recent conversation

{{window}}
```

```md prompt=recheck
This request was queued while the bot was busy, and the bot has replied to something else in
the meantime. Decide whether the queued request still needs doing.

## The bot you speak for

{{bot.displayName}} — {{bot.description}}

{{windowBlock}}

## The queued message

{{message.text}}

{{sinceBlock}}
```

```md prompt=since
## What happened while it waited

{{since}}
```

```md prompt=recheckSkipped
Already covered by my last reply — nothing further from me on that one.
```

```md prompt=gateBroken
I could not work out how to answer that — the part of me that decides what to do came back in
a shape I could not read. Ask again, or put it a different way.
```

```md prompt=gateTimeout
I spent too long deciding how to answer that and gave up. Ask again if it still matters.
```

```md prompt=task
You are answering a message in a chat session, on this bot's behalf. Do the work, then answer.

## The bot you speak for

{{bot.displayName}} — {{bot.description}}

{{windowBlock}}

## The message

{{message.text}}

{{sinceBlock}}

## What you decided this needs

{{objective}}

{{boundariesBlock}}

## Answering

Lead with the conclusion — that one sentence is what the reader sees first and often all they
read. Then choose the shape the content already has, rather than the shape that looks
thorough: an explanation is prose and belongs in `body`; a set of parallel facts is a list;
rows and columns are a table. Splitting a paragraph into three half-sentences to make it look
like a list costs the reader the argument that held them together.

Say what you actually did and what you did not. If you could not finish, say so in the
conclusion — a hedged answer that reads like a finished one is worse than an admitted gap.
```

```md prompt=boundaries
### Stay inside

{{boundaries}}
```

```md prompt=taskNoAgent
I was set up to hand that kind of work to `{{agent}}`, and there is no such agent. That is a
configuration problem on my side — asking again won't help until it is fixed.
```

```md prompt=taskTimeout
I worked on that for as long as I'm allowed and didn't finish. Ask again if it still matters —
narrowing it down will help.
```

```md prompt=taskFailed
I took that on and it broke partway through. Nothing was finished, so don't count on anything
from me on that one.
```
