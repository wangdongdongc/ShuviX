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
    session: { type: object, required: [id, arbitrated, members] }
    message: { type: object, required: [id, text] }
    window: { type: array }
    notes: { type: string }
    since: { type: array }
    skeletonDecision: { enum: [reply, task, clarify] }
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

> **Status: skeleton (M4′).** The gate, the stale-recheck, the task stage and the notes
> occasion are not wired yet. The script below stands in a deterministic placeholder for
> the first LLM call, so that L0 → cohort → claim → turn → say can be exercised end to end
> before any model is involved. M5′ replaces the placeholder block with a real
> `run(input.agents.intent, …)`; the four contracts below are already their final shape.

## The pipeline

Everything is read off `input.*`. The script scope holds the base API plus whatever the
caller assembled (`say` / `claim` / `turn`) — it does **not** flatten `input`, so a bare
`message` or `agents` would be a ReferenceError. Flattening happens only in the render
scope of a `md prompt=` block.

```js workflow
if (input.occasion === 'notes') {
  // M9′: the notes occasion. The notes stage edits the bot's own markdown in place —
  // nothing comes back here, and a failure changes nothing.
  return { outcome: 'notes-skipped' }
}

// 1 ── The gate (M5′ replaces this whole block). The skeleton's verdict is deterministic
//      and shaped exactly like the `intent` contract below. Which branch it takes is the
//      bot's own business: `shuvix-bot-input: {skeletonDecision: task}`.
const intent = {
  decision: input.skeletonDecision || 'reply',
  relevance: 5,
  reason: 'skeleton',
  reply: input.bot.displayName + ': ' + input.message.text
}

// 2 ── Whose message is this? The host joins here. With one bot, or when this bot was
//      named, it degenerates to a constant: no waiting, no grace window.
const verdict = await claim(intent)
if (!verdict.won) return { outcome: 'yielded', to: verdict.winner }

// 3 ── Anything answerable in one line is answered here — don't open a task for it.
if (intent.decision !== 'task') {
  await say({ headline: intent.reply })
  return { outcome: intent.decision }
}

// 4 ── Take this bot's turn in this session: one job at a time, in arrival order.
return await turn(async (slot) => {
  if (slot.superseded.length) log('merged ' + slot.superseded.join(','))
  // M5′ inserts the stale-recheck here (slot.selfReplied), M8′ the real task stage.
  await say({ headline: intent.reply, body: '(skeleton task turn)' })
  return { outcome: 'replied', queuedMs: slot.queuedMs, superseded: slot.superseded }
})
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
