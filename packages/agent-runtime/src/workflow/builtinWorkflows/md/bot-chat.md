---
shuvix: workflow v1
shuvix-builtin: true
name: bot-chat
shuvix-displayName: Bot Chat Pipeline
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
    session: { type: object, required: [id] }
    message: { type: object, required: [id, text] }
    window: { type: array }
---

## What this is

The bot bound to a chat session runs this file once per message. It is the whole of what a
bot does, in order: decide what the message needs, then answer.

A bot is a binding, not an agent: its md names this pipeline and fills the pipeline's
**slots** with agent definitions (`shuvix-bot-pipeline: {workflow: bot-chat, agents: {intent: …, task: …}}`). The bot md's
body — its persona and what it has learned — is not in any prompt below. The host appends
it, fenced, to the system prompt of every agent this run dispatches, the way project context
is appended. Keeping that body current is the task agent's own job, with its own file tools;
there is no separate notes stage.

There is no `shuvix-workflow-on` here: no trigger leads to this file. A bot points at it
(`shuvix-bot-pipeline.workflow: bot-chat`) and the session invokes it. `parallel` is deliberate:
run-level re-entry gets out of the way entirely, and one-thing-at-a-time is provided by
`turn()`, which serialises _this session_ — never the file, which many sessions share at the
same moment.

There is also no key saying "only a bot may call this" — the invocation path is not an
admission check. What makes this file a bot pipeline is simply that its script uses `say`
and `turn`, which only the bot caller assembles into the script API. Start it from
somewhere that does not and it fails on the first of those names, the way any script fails
on an undefined function.

## The pipeline

The script is the flowchart and nothing else: intent → one line / real work.
Everything is read off `input.*` — the script scope holds the base API plus what the caller
assembled (`say` / `turn`) and does **not** flatten `input`; flattening happens only in the
render scope of a `md prompt=` block, which is where every word of every prompt lives.

**Nothing here catches an error.** A stage that times out, breaks its contract or names an
agent that does not exist throws; the run ends, and the host says so in the chat, choosing
the wording from the failure's code (which stage, what went wrong). There is no silence: the
chat is one-on-one, every message is for this bot, and every run ends in a reply or a visible
failure.

```js workflow
// The flow, top to bottom. Every prompt is a block below; every failure simply throws —
// the host says so in the chat, with wording picked from the failure's code.
const window = input.window || []

// 1 ── Intent: one tool-less call decides what this message needs. The chat is one-on-one,
//      so every message is for this bot by definition — the contract has no `ignore`.
const intent = await run(
  input.agents.intent,
  prompt('gate', { window: window.slice(-vars.gateWindow) }),
  { schema: schemas.intent, tools: [], timeoutSec: vars.gateTimeoutSec }
)

// 2 ── Answerable in one line (reply / clarify): say it, no task.
if (intent.decision !== 'task') {
  await say(intent.reply, { decision: intent.decision })
  return { outcome: intent.decision }
}

// 3 ── Work needs this session's turn: one job at a time, in arrival order. Queued behind a
//      reply of its own, the bot first re-checks whether that reply already covered this one;
//      a re-check that fails just means proceeding.
const slot = await turn()
if (vars.recheckStale && slot.selfReplied) {
  const again = await run(
    input.agents.recheck || input.agents.intent,
    prompt('recheck', {
      window: window.slice(-vars.gateWindow),
      since: slot.since.slice(-vars.gateWindow)
    }),
    { schema: schemas.recheck, tools: [], timeoutSec: vars.gateTimeoutSec }
  ).catch(() => null)
  if (again && again.verdict === 'skip') {
    await say(again.reply || prompt('recheckSkipped'), { decision: 'reply' })
    return { outcome: 'recheck-skipped', queuedMs: slot.queuedMs }
  }
}

// 4 ── The task agent — whichever agent md the bot put in that slot, with its own tools —
//      does the work and answers. Prose instead of the contract still ships: someone is
//      waiting, and an answer with no shape beats no answer.
const reply = await run(
  input.agents.task,
  prompt('task', {
    task: intent.task || { objective: intent.reason },
    window: window.slice(-vars.taskWindow),
    since: slot.since
  }),
  {
    schema: schemas.reply,
    timeoutSec: vars.taskTimeoutSec,
    attach: input.message.attachments,
    fallback: 'prose'
  }
)
await say(reply, { decision: 'task' })
return { outcome: 'task', queuedMs: slot.queuedMs, superseded: slot.superseded }
```

A few choices worth knowing about, because they are easy to "fix" by mistake:

- The task stage gets **no `tools` option**. `input.agents.task` is whichever agent md the
  bot put in that slot; narrowing its tools here would overrule what that md says about
  itself. The gate is narrowed to nothing because it is a shared builtin whose job is one
  structured verdict.
- `attach` carries **handles, not bytes**, and no prompt announces them: whatever the host
  fetches arrives as a real user message in context, and a sentence claiming "2 images are
  above" would be a lie on exactly the runs where the fetch failed.
- `fallback: 'prose'` on the task stage means a task agent that wrote its answer as prose
  instead of calling `next` still gets its answer shown, as a plain message.
- The re-check swallows its own failure on purpose: it only ever saves a repeat, so failing
  it means doing the work that was going to be done anyway.

## Contracts

Each stage that returns data ends by calling `next` with an object shaped by one of these
blocks (the instruction to do so is added at dispatch, along with the schema itself). The
gate has no `ignore`: in a one-on-one chat every message is addressed to the bot, so the
verdict is only ever how to answer, never whether.

```json schema=intent
{
  "type": "object",
  "required": ["decision", "reason"],
  "properties": {
    "decision": {
      "enum": ["reply", "task", "clarify"],
      "description": "reply = you can answer fully right now with no tools; task = it needs work; clarify = one question unblocks you. The chat is one-on-one: the message is addressed to you, so answering is not optional."
    },
    "reason": { "type": "string", "maxLength": 200 },
    "reply": { "type": "string", "description": "The reply itself, for decision reply or clarify" },
    "task": {
      "type": "object",
      "required": ["objective"],
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

The stages' own words. All of it is editable prose: copy this file to
`~/.shuvix/workflows/bot-chat.md` and it is yours.

`{{path}}` reads the run's `input` (flattened at the top level), plus `vars`, `event`, and
whatever the script passed as the second argument to `prompt()` — that is where the sliced
`window` comes from. `{{>name}}` pastes another block from this file, rendered in the same
scope; a pasted block whose placeholders all came out empty disappears whole, heading
included. That is how the optional sections below work: `since` is only there when something
happened while the request waited.

```md prompt=gate
A message has just arrived in a chat session. Decide, on this bot's behalf, what to do with
it.

## The bot you speak for

{{bot.displayName}} — {{bot.description}}

{{>window}}

## The new message

{{message.text}}
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

{{>window}}

## The queued message

{{message.text}}

{{>since}}
```

```md prompt=since
## What happened while it waited

{{since}}
```

```md prompt=recheckSkipped
Already covered by my last reply — nothing further from me on that one.
```

```md prompt=task
You are answering a message in a chat session, on this bot's behalf. Do the work, then answer.

## The bot you speak for

{{bot.displayName}} — {{bot.description}}

{{>window}}

## The message

{{message.text}}

{{>since}}

## What you decided this needs

{{task.objective}}

{{>boundaries}}

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

{{task.boundaries}}
```
