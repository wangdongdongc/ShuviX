---
shuvix: okf v0.2
type: Guide
title: 'Hook file (shuvix: hook v1)'
description: 'The complete specification of a ShuviX hook — a file that dispatches an agent when a session event fires: the required marker, the two keys, the trigger points and their payloads, the CEL `when` filter, the body-as-task, and the runtime rules that are not in the file.'
tags: [shuvix, hook, format, spec, trigger]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/hook/hookFile.ts
    title: hookFile.ts — the parser (source of truth)
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/hook/triggerPoints.ts
    title: triggerPoints.ts — the trigger table and payload shapes
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/hook/builtinHooks/md/auto-title.md
    title: auto-title — the builtin hook
---

# Hook file

A **hook** says one thing: *on these trigger points, when this condition holds, dispatch this
agent and hand it this text*. ShuviX appends the event to the text, the agent acts through its
own tools, and **the host never reads the agent's result** — a hook is an observer, not an
interceptor. It cannot block, rewrite or delay the thing that triggered it.

- Location: `~/.shuvix/hooks/<name>.md`.
- Marker: `shuvix: hook v1` — **required** (there are no pre-marker hook files, so a file
  without it can only be a stray note). `hook` and `hook v2` are accepted; the version is not
  checked.
- Live on presence, read again on every trigger. One builtin: `auto-title`.

## Example

```markdown
---
shuvix: hook v1
name: capture-decisions
description: After each turn in a project session, keep any decision worth keeping.
shuvix-hook-agent: knowledge-writer
shuvix-hook-on:
  - trigger: session.turn-completed
    when: event.profileName == 'work' && event.textMessageCount >= 2
---

Read `recentText` in the event below. If it holds a decision about this project, record it
in the `project` knowledge base. Otherwise finish without writing.
```

## Frontmatter keys

| Key                   | Type            | Required | Meaning                                                                                                                                                                     |
| --------------------- | --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`              | `hook v1`       | **yes**  | File-type marker.                                                                                                                                                           |
| `name`                | string          | no       | Identity; defaults to the file's base name.                                                                                                                                 |
| `shuvix-displayName`  | string          | no       | Label in Settings → Hooks. Defaults to `name`.                                                                                                                              |
| `description`         | string          | no       | One line for the settings list.                                                                                                                                             |
| `shuvix-hook-agent`   | string          | **yes**  | The agent to dispatch, by `name`: any builtin agent or `~/.shuvix/agents/<name>.md`. **Never a base persona** (`work` / `chat` / `notebook` / `bot`) — rejected at parse.   |
| `shuvix-hook-on`      | list of bindings| **yes**  | At least one `{ trigger, when? }`. `trigger` is a trigger-point id; `when` is an optional CEL expression. A binding with any other key is rejected.                          |

Strictness (whole file rejected, with the reason shown in Settings → Hooks): missing marker,
missing or empty `shuvix-hook-agent`, a base persona as the agent, missing / empty / non-list
`shuvix-hook-on`, a binding without `trigger` or with an extra key, a `when` that is not a
string or does not parse as CEL, a bare `on:` / `agent:` key (the prefixed names are the only
ones read — a misspelt key must not silently mean "no bindings"), and any `shuvix-hook-*` key
that is not one of the two above. An **unknown trigger id is not an error**: the binding is
kept but inert, with a warning, because the trigger vocabulary grows per release. An empty or
`~` `when` means "no condition".

## The body — the task text

Everything after the frontmatter is the prose handed to the agent. It may be empty (when the
agent's own file already says what to do). **There is no template syntax**: no placeholders, no
variables. The event is appended by the runtime as YAML inside a fixed fence:

```text
<body>

<hook_event trigger="session.turn-completed">
sessionId: …
profileName: work
title: …
isDefaultTitle: false
turnCount: 3
textMessageCount: 5
titleAutoGenerated: true
recentText: |
  User: …
  Assistant: …
</hook_event>
```

To make the agent look at one field, name it in the body ("the excerpt is in `recentText`").

## Trigger points

Both current triggers are **session-scoped** and are emitted by ordinary chat sessions (notebook
sessions do not emit them). The payload holds only facts the emitting place naturally has:

| Trigger                    | When                                                                                                   | Payload                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.prompt-accepted`  | a user prompt passed validation and is about to be handed to the root agent (the model has not run yet) | `sessionId`, `profileName` (`work` / `chat` / `bot`, or a sub-session's pinned agent), `title`, `isDefaultTitle` (title still the generic default), `promptText`                                                                                                        |
| `session.turn-completed`   | a whole turn ended, tool calls included — **fires whether the turn succeeded, failed or was aborted**   | the four common fields plus `turnCount` (user text messages so far, this one included), `textMessageCount` (non-empty user + assistant messages), `titleAutoGenerated` (`true` while the title came from automation), `recentText` (the tail of the conversation, ~1000 chars) |

Adding a trigger is a ShuviX change (one row in the trigger table plus one emit); a hook cannot
invent one.

## The `when` filter

CEL (Common Expression Language — the same engine that evaluates security policies, but without
the policy functions such as `inDir`). It must evaluate to a **boolean** over:

- `event` — the payload above **plus** `trigger` (the trigger id; `trigger` is therefore a
  reserved payload key);
- `env` — `{ host: 'desktop' | 'extension', platform: 'darwin' | 'win32' | 'linux' }`.

Reading a field the payload does not have is an error, and an error means **no match** (plus a
warning) — a hook never fires by accident. Guard optional fields with `has(event.field)`.

## Runtime rules (host-side, not in the file)

- A run is one dispatch of the named agent **under the session that emitted the event** — the
  same path as the `agent` tool, so tools, asks, LLM logs and the sub-agent panel all land on that
  session and every tool call goes through the same security policies. Model = the session's
  current model, unless the agent file's `shuvix-model` says otherwise; the hook never picks one.
- **Dedupe**: while a run of this hook for this session is still going, a new trigger is skipped
  (`busy`). **Timeout**: 5 minutes, then the run is aborted. **Unknown agent / no usable model**:
  skipped with a logged reason (configuration errors, not failed runs).
- The agent's answer is discarded. Anything it should persist, it must do through its tools
  (record to a knowledge base, set the session title through the `session` tool, …).
- Runs are visible in the owning session's sub-agent panel and in the main-process log
  (`hook "<name>" run=… start / ok / failed`, `skipped …: busy | unknown-agent | no-model`).
  There is no journal file.
- Deleting the session aborts its hook runs.

## Builtin hook and overriding

`auto-title` names the `titler` agent on `session.prompt-accepted when event.isDefaultTitle`
and on `session.turn-completed when event.titleAutoGenerated && event.turnCount == 2 &&
event.textMessageCount >= 3`; the titler applies the title with the `session` tool's
`set-title`. A user file named `auto-title` replaces it entirely (to silence it, an override with
a `when: false` binding is enough). Same-name copies follow the rule in the `shuvix-files` entry.

## Deliberately absent

No script block, no orchestration primitives, no result schema, no prompt templates, no
concurrency or timeout keys, no journal, and no synchronous or blocking hooks. If a task needs
to *change* what the session does next, it is not a hook — it belongs in the agent's own prompt
or in a security policy.
