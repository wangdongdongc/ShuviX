---
shuvix: workflow v1
shuvix-builtin: true
name: bot-chat
description: The pipeline a bot runs in a chat session — decide whether to speak, answer, then quietly bring its notes up to date.
shuvix-workflow-concurrency: parallel
shuvix-workflow-limits:
  maxAgents: 4
  maxDurationSec: 2400
shuvix-workflow-vars:
  gateWindow: 8
  taskWindow: 20
  gateTimeoutSec: 60
  taskTimeoutSec: 1800
  notesTimeoutSec: 300
  notesWindow: 60
  notesBudget: 2000
  recheckStale: true
shuvix-workflow-input:
  type: object
  required: [occasion, bot, agents, session]
  properties:
    occasion: { enum: [message, notes] }
    bot: { type: object, required: [name, displayName, description, file] }
    agents: { type: object, required: [intent, task, notes] }
    session: { type: object, required: [id, arbitrated, directed, members] }
    message: { type: object, required: [id, text] }
    window: { type: array }
    notes: { type: string }
    since: { type: array }
---

## What this is

Every bot in a chat session runs this file, once per message, per bot. It is the whole of
what a bot does, in order: decide whether to speak, settle who the message belongs to,
answer, and — later, off the critical path — bring its own notes up to date.

There is no `shuvix-workflow-on` here: no trigger leads to this file. A bot points at it
(`shuvix-bot-pipeline: bot-chat`) and the session invokes it. `parallel` is deliberate:
run-level re-entry gets out of the way entirely, and one-thing-at-a-time is provided by
`turn()`, which serialises _this bot in this session_ — never the file, which many bots and
many sessions share at the same moment.

There is also no key saying "only a bot may call this" — the invocation path is not an
admission check. What makes this file a bot pipeline is simply that its script uses `say`,
`claim` and `turn`, which only the bot caller assembles into the script API. Start it from
somewhere that does not and it fails on the first of those names, the way any script fails
on an undefined function.

> **Status (M5′).** The gate is real. The task stage is not: a `task` verdict still takes the
> turn and still says something, but what it says is a placeholder — M8′ replaces that one
> branch. The notes occasion is M9′.

## The pipeline

Everything is read off `input.*`. The script scope holds the base API plus whatever the
caller assembled (`say` / `claim` / `turn`) — it does **not** flatten `input`, so a bare
`message` or `agents` would be a ReferenceError. Flattening happens only in the render scope
of a `md prompt=` block.

**Optional context is a nested prompt, never a bare placeholder.** The template language is
one thing wide — `{{path}}`, no conditions, no loops — and a line vanishes only when it holds
nothing but placeholders. So a heading that should disappear along with its value has to live
_inside_ that value: each optional section is its own `md prompt=` block, and the script turns
it into one string that is either whole or empty.

```js workflow
if (input.occasion === 'notes') {
  // M9′: the notes occasion. The notes stage edits the bot's own markdown in place —
  // nothing comes back here, and a failure changes nothing.
  return { outcome: 'notes-skipped' }
}

// ── The material. Prompts are prose and live in the blocks below; the script only picks.
const recent = (input.window || []).slice(-vars.gateWindow)
const notes = trimNotes(input.notes, vars.notesBudget)
const otherLines = (input.session.others || []).map(function (o) {
  return '- ' + o.displayName + ': ' + o.description
})

// A message that named this bot — or that answers its own clarify — is addressed to it,
// exactly like a one-on-one session: silence is not on the table and `ignore` is not on the
// contract. `arbitrated` stays a separate question: it asks whether anyone else could still
// pick this message up, which is what the degrade path below turns on.
const solo = !input.session.arbitrated || input.session.directed

const notesBlock = notes ? prompt('notes', { notes: notes }) : ''
const othersBlock = otherLines.length ? prompt('others', { others: otherLines }) : ''
const windowBlock = recent.length ? prompt('window', { window: recent }) : ''
const addressed = solo ? prompt('addressed') : ''

// 1 ── The gate. One call, no tools, a minute of wall clock.
let intent = null
let failure = null
try {
  intent = await run(
    input.agents.intent,
    prompt('gate', {
      notesBlock: notesBlock,
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

// 2 ── A broken contract or a timeout is a **fault, not a verdict**. With other bots around,
//      step aside and let one of them answer. Alone, say so: in a one-on-one session silence
//      and a broken bot look exactly alike.
if (!intent) {
  if (input.session.arbitrated) return { gate: failure, outcome: 'gate-' + failure }
  await say(prompt(failure === 'timeout' ? 'gateTimeout' : 'gateBroken'), { error: true })
  return { gate: failure, outcome: 'gate-' + failure }
}

// 3 ── Whose message is this? The host joins here. With one bot, or when this bot was named,
//      it degenerates to a constant: no waiting, no grace window.
const verdict = await claim(intent)
if (!verdict.won) return { gate: 'ok', outcome: 'yielded', to: verdict.winner }

// 4 ── Anything answerable in one line is answered here — don't open a task for it.
if (intent.decision !== 'task') {
  const line = typeof intent.reply === 'string' ? intent.reply.trim() : ''
  if (!line) {
    // It said it would speak and then wrote nothing. Same class of fault as never calling
    // `next` — and past the claim there is nobody left to cover for us.
    await say(prompt('gateBroken'), { error: true })
    return { gate: 'broken', outcome: 'gate-broken' }
  }
  await say(line, { decision: intent.decision })
  return { gate: 'ok', outcome: intent.decision, memorable: !!intent.memorable }
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

  // M8′ replaces this branch with the real task stage. Until then the verdict is honoured as
  // far as it can be: the turn is taken, and the session is told what is missing.
  const objective = (intent.task && intent.task.objective) || intent.reason
  await say(prompt('taskPending', { objective: objective }), { error: true })
  return {
    gate: 'ok',
    outcome: 'task-pending',
    queuedMs: slot.queuedMs,
    superseded: slot.superseded
  }
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** Cut the notes to budget, then back off to the last paragraph break — a slice that lands
 *  mid-sentence or mid-heading reads to the model as a fact that stops halfway. */
function trimNotes(text, budget) {
  const s = typeof text === 'string' ? text : ''
  if (s.length <= budget) return s
  const cut = s.slice(0, budget)
  const at = cut.lastIndexOf('\n\n')
  return (at > budget / 2 ? cut.slice(0, at) : cut.replace(/\n[^\n]*$/, '')) + '\n\n…'
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
  "required": ["decision", "relevance", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify", "ignore"],
      "description": "reply = you can answer fully right now with no tools; task = it needs work; clarify = one question unblocks you; ignore = plainly meant for another bot"
    },
    "relevance": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9,
      "description": "How squarely this message falls in YOUR remit — not how eager you are. One bot wins the message on this number."
    },
    "reason": { "type": "string", "maxLength": 200 },
    "reply": { "type": "string", "description": "The reply itself, for decision reply or clarify" },
    "task": {
      "type": "object",
      "properties": {
        "objective": { "type": "string" },
        "boundaries": { "type": "string" }
      }
    },
    "memorable": {
      "type": "boolean",
      "description": "This message carries a durable preference, correction or fact — set it even when you are only replying"
    }
  }
}
```

```json schema=intentSolo
{
  "type": "object",
  "required": ["decision", "relevance", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify"],
      "description": "This message was addressed to you, so answering is not optional. reply = answer now; task = it needs work; clarify = ask the one question that unblocks you."
    },
    "relevance": { "type": "integer", "minimum": 0, "maximum": 9 },
    "reason": { "type": "string", "maxLength": 200 },
    "reply": { "type": "string" },
    "task": {
      "type": "object",
      "properties": {
        "objective": { "type": "string" },
        "boundaries": { "type": "string" }
      }
    },
    "memorable": { "type": "boolean" }
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

{{notesBlock}}

{{othersBlock}}

{{addressed}}

{{windowBlock}}

## The new message

{{message.text}}
```

```md prompt=notes
## What this bot remembers

{{notes}}
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

```md prompt=taskPending
That one needs real work, and the stage that does the work is not connected yet. What I
understood the goal to be: {{objective}}
```
