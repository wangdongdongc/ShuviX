---
shuvix: okf v0.2
type: Guide
title: 'Hook file (shuvix: hook v1)'
description: 'The complete specification of a ShuviX hook — a file that dispatches an agent when a session event fires or an approval request needs an answer: the required marker, the two keys, observe and decide trigger points and their payloads, the CEL `when` filter, the body-as-task, and the runtime rules that are not in the file.'
tags: [shuvix, hook, format, spec, trigger]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/hook/hookFile.ts
    title: hookFile.ts — the parser (source of truth)
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/hook/triggerPoints.ts
    title: triggerPoints.ts — the trigger table and payload shapes
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/hook/builtinHooks/md/auto-title.md
    title: auto-title — a builtin observe hook
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/hook/builtinHooks/md/auto-review.md
    title: auto-review — the builtin decide hook
---

# Hook file

A **hook** says one thing: *on these trigger points, when this condition holds, dispatch this
agent and hand it this text*. ShuviX appends the event to the text. What happens to the agent's
answer depends on the kind of trigger point it is bound to:

- **Observe** triggers (`session.*`): **the host never reads the agent's result** — the hook is
  an observer, not an interceptor. It cannot block, rewrite or delay the thing that triggered it;
  the agent acts through its own tools.
- **Decide** triggers (`permission.request`): the agent must answer with a structured result
  through the `next` tool, and ShuviX acts on that answer. A decide trigger only exists where
  ShuviX has already stopped to ask — the hook decides *who* answers, never *whether* to ask.

The file format is the same for both: binding a file to a decide trigger is what makes it run as a
decision.

- Location: `~/.shuvix/hooks/<name>.md`.
- Marker: `shuvix: hook v1` — **required** (there are no pre-marker hook files, so a file
  without it can only be a stray note). `hook` and `hook v2` are accepted; the version is not
  checked.
- Live on presence, read again on every trigger. Two builtins: `auto-title` and `auto-review`.

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
| `shuvix-displayName`  | string          | no       | Label in the sidebar's Hooks group. Defaults to `name`.                                                                                                                              |
| `description`         | string          | no       | One line for the settings list.                                                                                                                                             |
| `shuvix-hook-agent`   | string          | **yes**  | The agent to dispatch, by `name`: any builtin agent or `~/.shuvix/agents/<name>.md`. **Never a base persona** (`work` / `chat` / `notebook` / `bot`) — rejected at parse.   |
| `shuvix-hook-on`      | list of bindings| **yes**  | At least one `{ trigger, when? }`. `trigger` is a trigger-point id; `when` is an optional CEL expression. A binding with any other key is rejected.                          |

Strictness (whole file rejected, shown as an amber row in the sidebar's Hooks group with the
reason as its tooltip): missing marker,
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

Every trigger is **session-scoped**: a run is always dispatched under a session. The two
`session.*` triggers are emitted by ordinary chat sessions (notebook sessions do not emit them);
`permission.request` is emitted wherever an agent's tool call reaches an ask, in any session. The
payload holds only facts the emitting place naturally has:

| Trigger                    | Kind    | When                                                                                                   | Payload                                                                                                                                                                                                                                                             |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.prompt-accepted`  | observe | a user prompt passed validation and is about to be handed to the root agent (the model has not run yet) | `sessionId`, `profileName` (`work` / `chat` / `bot`, or a sub-session's pinned agent), `title`, `isDefaultTitle` (title still the generic default), `promptText`                                                                                                        |
| `session.turn-completed`   | observe | a whole turn ended, tool calls included — **fires whether the turn succeeded, failed or was aborted**   | the four common fields plus `turnCount` (user text messages so far, this one included), `textMessageCount` (non-empty user + assistant messages), `titleAutoGenerated` (`true` while the title came from automation), `recentText` (the tail of the conversation, ~1000 chars) |
| `permission.request`       | decide  | a security policy wants an operation judged (effect `ask`) and the approval card is about to be shown   | see below                                                                                                                                                                                                                                                           |

Adding a trigger is a ShuviX change (one row in the trigger table plus one emit); a hook cannot
invent one.

## `permission.request` — answering an approval request

It fires only for rules whose effect is `ask`. A `force-ask` rule means "only the user answers"
(`protect-bot-files`, `protect-shuvix-config`), a `deny` refuses outright, and auto-allow and
"allow and remember" (`force-allow`) let the call through — none of those reach a hook. The asks
of an agent dispatched by a decide hook go straight to the user, so a reviewer never reviews
itself.

The payload is everything the reviewing agent gets. It carries what the human wrote and the
operation itself, never the working agent's own text or tool output:

- `sessionId` — the session the operation happens in (the run is dispatched under it).
- `agent` — `profile` (agent name) and `kind` (`root` / `spawned`) of the agent asking.
- `operation` — `tool` (with its operation, e.g. `session: create-sub-session`), `action`
  (`read` / `write` / `execute` / `navigate`), `objectType` (`command` / `path` / `database` /
  `gitTool` / `url` / `invocation`), `target` (the command, path, SQL or URL, clipped), and `facts`:
  for a command `channel`, `host` (ssh), `sandboxed`, `unconfinedReason`, `background`; for a path
  `path`, `requestedPath`, `diff` (clipped) and `isNewFile`; for a database `connection`, `dbType`,
  `readonly`; for a url `scheme`, `host`, `browser`; always `workingDirectory` and `platform`.
- `policy` — `names` of the policies that asked and their combined `prompt`.
- `userMessages` — what the human wrote, oldest first: their messages, their answers to the
  agent's questions and their feedback on approval cards (the first one and the latest eight,
  each clipped). In a sub-session they come from the top-level conversation it belongs to.
- `delegatedTasks` — in a sub-session, the task its parent agent sent it (a claim, not
  permission); empty elsewhere.
- `recentOperations` — up to ten earlier decisions in this session, each `{ target, outcome }`.

The answer is the `next` tool's argument, checked against a fixed schema:
`{ decision: allow | ask | deny, risk: low | medium | high | critical, summary, reason }`.

- `allow` — the call runs without a card. `deny` — it is refused, and the agent reads
  `reason`. `ask` — the card is shown with the reviewer's `risk`, `summary` and `reason`.
- Several matching hooks run in parallel and the strictest answer wins (`deny` > `ask` > `allow`).
- No answer — timeout, stop, a failed run, a malformed result, or no hook matching — means the
  user is asked. A broken answer can never become an allow.
- After three denials in a row, or twenty in one session, asks in that session go straight to the
  user; the user answering an ask clears the run of three.
- The **Automatic review of approvals** switch (Settings → General → Security) turns the whole
  step off.

## The `when` filter

CEL (Common Expression Language — the same engine that evaluates security policies, but without
the policy functions such as `inDir`). It must evaluate to a **boolean** over:

- `event` — the payload above **plus** `trigger` (the trigger id; `trigger` is therefore a
  reserved payload key). Nested fields are read with dots: `event.operation.objectType ==
  'command'`, `event.operation.facts.unconfinedReason == 'escalated'`;
- `env` — `{ host: 'desktop' | 'extension', platform: 'darwin' | 'win32' | 'linux' }`.

Reading a field the payload does not have is an error, and an error means **no match** (plus a
warning) — a hook never fires by accident. Guard optional fields with `has(event.field)`.

## Runtime rules (host-side, not in the file)

- A run is one dispatch of the named agent **under the session that emitted the event** — the
  same path as the `agent` tool, so tools, asks, LLM logs and the sub-agent panel all land on that
  session and every tool call goes through the same security policies. Model and thinking level =
  the session's current ones, unless the agent file's `shuvix-model` / `shuvix-thinking` say
  otherwise; the hook never picks either. **Unknown agent / no usable model**: skipped with a
  logged reason (configuration errors, not failed runs).
- **Observe triggers**: while a run of this hook for this session is still going, a new trigger is
  skipped (`busy`). Timeout: 5 minutes, then the run is aborted. The agent's answer is discarded —
  anything it should persist, it must do through its tools (record to a knowledge base, set the
  session title through the `session` tool, …).
- **Decide triggers**: no dedupe — every ask is its own decision. Timeout: 60 seconds. The answer
  is read only from `next`; the agent's prose is never read.
- Runs are visible in the owning session's sub-agent panel and in the main-process log
  (`hook "<name>" run=… start / ok / failed`, `skipped …: busy | unknown-agent | no-model`).
  There is no journal file.
- Deleting the session aborts its hook runs; stopping a tool call aborts the review it is waiting
  for.

## Builtin hooks and overriding

`auto-title` names the `titler` agent on `session.prompt-accepted when event.isDefaultTitle`
and on `session.turn-completed when event.titleAutoGenerated && event.turnCount == 2 &&
event.textMessageCount >= 3`; the titler applies the title with the `session` tool's
`set-title`.

`auto-review` names the `permission-reviewer` agent on every `permission.request`. That agent has
no tools and declares `shuvix-thinking: low` (with thinking off, some models answer in prose instead of calling `next`); its file is the review rules. Only ShuviX
dispatches it: the `agent` tool cannot, and a sub-session cannot be opened with it.

A user file with the same name replaces a builtin hook entirely: to silence one, an override with
a `when: false` binding is enough; to review only some operations, give `auto-review` a `when`
(e.g. `event.operation.objectType != 'database'`). To change how operations are judged, override
the agent instead: `~/.shuvix/agents/permission-reviewer.md`. An agent's writes under
`~/.shuvix/hooks`, `agents`, `policies` and `skills` always ask the user (policy
`protect-shuvix-config`), so an agent cannot quietly rewrite its own reviewer. Same-name copies
follow the rule in the `shuvix-files` entry.

## Deliberately absent

No script block, no orchestration primitives, no result schema in the file (a decide trigger
brings its own), no prompt templates, no concurrency or timeout keys, and no journal. An observe
hook cannot block anything, and a decide hook exists only where ShuviX already stops to ask. If a
task needs to *change* what the session does next, it is not a hook — it belongs in the agent's
own prompt or in a security policy.
