---
shuvix: okf v0.2
type: Guide
title: 'Security policy file (shuvix: policy v1)'
description: 'The complete specification of a ShuviX security policy — the request document a rule sees (subject / action / tool / object / env / vars), the five condition keys, CEL `match`, effects and their precedence, who answers an ask (the automatic review, then you), `lets`, dispositions (auto-redaction), what makes a file invalid, the builtin policies, and how to loosen a gate or add one of your own. Remote access (the `network` subject) has its own entry, `network-policy`.'
tags: [shuvix, policy, security, format, spec, cel]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/policyFile.ts
    title: policyFile.ts — the parser (source of truth)
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/celMatch.ts
    title: celMatch.ts — the CEL environment, `inDir`, `hasShortFlags`, strict semantics
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md
    title: the builtin policies, one md per language
---

# Security policy file

ShuviX's permission system is an **ask model, not a sandbox**. Every tool call is checked
in-process against a set of rules that answer **allow / ask / deny**, and the rules are markdown
files the user can read, override and remove. The first principle is **no policy = allow**: an
operation that matches no rule runs freely; every protection ShuviX ships is a visible policy.
The policies themselves are not OS-level isolation. That is the separate **command sandbox**: on
macOS, with Settings → LLM tools → bash → Sandbox on, each `bash` command runs confined by the
operating system. It confines file access to this session's **permission table**
(`vars.aclRead` / `vars.aclWrite` below): a confined command can read the paths in the table,
write the writable ones and read outside your home folder — nothing else. It also cannot open
apps, signal other processes or connect to local services such as Docker. Git, installing
dependencies, builds and other tools that read their configuration or caches in your home folder
are meant to run outside it. The host reports whether a run was
really confined as the command's `sandboxed` attribute, and the builtin policies decide on it: a
confined command runs without asking, an unconfined one — sandbox off, not available, the agent
asking for full access, every `ssh` command — asks, and then runs with the user's full privileges.

An `ask` does not go to the user straight away. Unless you disable the builtin hook `auto-review` (it is on by
default), a reviewing agent answers it first, in a fresh context that sees what the user wrote, the
operation itself and, when it needs to, the files the operation runs: it lets ordinary work through, refuses what is clearly
harmful, and puts the rest in front of the user with its opinion on the card. The reviewer is
a filter, not a boundary — the sandbox is, and so is any `deny` rule you write. `force-ask` always
goes to the user. The reviewer is the builtin hook `auto-review` and the agent `permission-reviewer`; see the
`hook-md` entry for what it sees and how to change it.

- Location: `~/.shuvix/policies/<name>.md`.
- Marker: `shuvix: policy v1`; optional on read, always written.
- Live on presence, read again when a session's rules are assembled. A user file with the same
  `name` as a builtin **replaces** it; an invalid user file never shadows a builtin.

## Example

```markdown
---
shuvix: policy v1
name: protect-drafts
shuvix-displayName: Never overwrite my drafts
description: Files under ~/Documents/drafts can be read but never written by an agent.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  drafts: "[vars.home + '/Documents/drafts']"
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, drafts)
    prompt: Write refused — the drafts folder is read-only for agents; ask the user to move the file out first.
---

**What it does**: any write under `~/Documents/drafts` is refused, even under an "allow and
remember" grant. The body is documentation only — the engine never reads it.
```

## Frontmatter keys

| Key                   | Type                      | Required | Meaning                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`              | `policy v1`               | no       | File-type marker.                                                                                                                                                                                                                                                                 |
| `name`                | string                    | no       | Identity (what an override matches on). Defaults to the file's base name.                                                                                                                                                                                                         |
| `shuvix-displayName`  | string                    | no       | Label in the sidebar's Security Policies group and on ask cards. Defaults to `name`.                                                                                                                                                                                              |
| `description`         | string                    | no       | One line for the list.                                                                                                                                                                                                                                                            |
| `shuvix-id`           | string                    | no       | Object id — how ShuviX recognises this file wherever it moves. A UUID in files ShuviX creates, `<type>:builtin:<name>` in shipped ones; a copy shares its original's id. Written by ShuviX — leave it alone. A malformed value is ignored with a warning, never rejects the file. |
| `shuvix-policy-scope` | mapping                   | no       | Conditions shared by **every rule** of this policy (AND-ed into each). Same keys as rule conditions. A rule whose own conditions contradict the scope (intersection empty) makes the file invalid.                                                                                |
| `shuvix-policy-lets`  | mapping name → CEL string | no       | Named values computed once from `{vars}` and injected into every rule's `match` as top-level names. Names must be identifiers and must not be `subject`, `action`, `tool`, `object`, `env`, `vars`, `inDir` or `inCidr`. Evaluated lazily, when needed.                           |
| `shuvix-policy-rules` | list of rules             | **yes**  | The only thing the engine evaluates. May be an empty list (an override with `[]` switches a builtin gate off).                                                                                                                                                                    |

Bare `rules:`, `lets:` or `scope:` keys make the file invalid — a misspelt key must not silently
mean "no rules". Other unprefixed unknown keys are ignored.

### A rule

| Rule key                                                         | Meaning                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`                                                         | **required**: `allow`, `force-allow`, `ask`, `force-ask` or `deny`.                                                                                                                                                                                   |
| `subject.kind`, `action`, `object.type`, `env.host`, `tool.name` | structured conditions: a string or a list of strings (list = OR, keys = AND); `'*'` = any; an empty list or empty string is invalid. **`subject.kind` is required** on the rule or in the scope — use `'*'` deliberately.                             |
| `match`                                                          | optional CEL expression over the request document (below), AND-ed with the conditions. A syntax error invalidates the file.                                                                                                                           |
| `disposition`                                                    | optional, only on `allow` / `force-allow`: something extra the host does when this rule decides the request. Two exist, both for auto-redaction (the `redaction` entry): `detect` on `modelRequest` (the request is redacted) and `redact` on `sensitive` (this piece stays a placeholder). A string or a list. On another effect, or on a rule whose `object.type` cannot take it, the file is invalid. |
| `prompt`                                                         | optional one-liner. On `ask` it is shown on the ask card; on `deny` it is returned to the agent as the refusal reason; on allow rules it is only shown on the policy's property card. Max 1000 characters. The one key that never invalidates a file. |

Any other key in a rule invalidates the file (the old nested `object:` / `subject:` / `when:`
matchers included).

### Effects and precedence

Among all matching rules of all policies, the strongest effect wins:

```
deny  >  force-ask  >  force-allow  >  ask  >  allow  >  (nothing matched = allow)
```

- `ask` puts the call in front of the automatic reviewer, then — if it does not settle it — the
  user; `allow` answers it; `deny` refuses it (the agent gets `prompt` as the reason).
- `force-allow` is an allow that also beats every `ask` — the way to exempt one place from an ask
  without touching the policy that asks. A `force-allow` never reaches the reviewer.
- `force-ask` is an ask that even `force-allow` cannot skip, and that only the user answers — its
  card offers no "allow and remember": "this gate accepts neither an exemption nor the reviewer".
- `deny` beats everything.
- A `disposition` counts only on the winning tier: a `force-allow` without one beats an `allow`
  that has one, so writing that `force-allow` switches the disposition off for what it matches.
  A check point that cannot carry out a disposition refuses the request instead.
- At remote access checks (`subject.kind` `network`) nobody can be asked: an `ask` or `force-ask`
  result refuses the request — see the `network-policy` entry.

Conditions compile to native predicates evaluated **before** the CEL, so a rule whose conditions
miss never runs its `match` or the policy's `lets`.

## The request document

Every check is a five-part request; `match` sees it as:

```
subject  { kind: 'agent' | 'user' | 'network', agentKind: 'root' | 'spawned', profile: <agent name>, sessionId, depth }
action   'read' | 'write' | 'execute' | …   (each object type below says which)
tool     { name: <tool name>, operation: <tool-specific op, '' if none>, restored: [<categories>] }
object   { type: <object type>, ...attributes }        ← an open attribute document
env      { host: 'desktop' | 'extension', platform: 'darwin' | 'win32' | 'linux' }
vars     the host variable table (below), this session's permission table included
```

`tool.restored` lists the categories of sensitive content ShuviX put back into this call's
arguments (auto-redaction: the agent wrote `{{REDACTED_API_KEY_…}}`, the tool gets the real key) — empty
when nothing was restored; the `redaction` entry has a rule that uses it.

`subject.kind` is `agent` for tool calls, `user` for the UI's own passive checks and `network` for
requests from a browser using remote access — that is why every builtin rule names its subject
(`[agent]` for the agent gates, `[network]` for `network-admission`). A `network` subject also
carries the sender's address, headers, device ID and more; the `network-policy` entry lists them.

On the desktop the `agent` subject also carries an open attribute `subject.bot`: the object id of the bot this session is bound to (the bot file's `shuvix-id`, which does not change on rename; the bot's name when the file has no id), an empty string when the session is not a bot session. Use it to loosen or tighten things for one bot — not `subject.profile`, since any session can pin a sub-session to the same profile. Other subjects do not have this attribute: write `has(subject.bot)` before comparing so the rule does not fail on them. A builtin-form id
(such as `bot:builtin:daily`) counts only for the bot file ShuviX itself wrote; another file declaring it is identified by its name.

### Object types and their attributes

| `object.type` | Raised by                                                                                                                                                            | `action`         | Attributes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`        | `read`, `write`, `edit`, `ls`, `grep`, `glob`, the `knowledge` tool, file previews; for remote access the file routes and file channels (`tool.name` `files` / `fs`) | `read` / `write` | `path` (where the path really leads: absolute; on the desktop symlinks are followed and `..` goes to the real parent, as the OS does when it opens the path), `requestedPath` (the absolute path as the tool asked for it — differs from `path` when a link or `..` was in the way), `displayPath` (as the model wrote it, for messages); for remote access also `scope` (`files`) and `access` (same as `action`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `command`     | `bash`, `powershell`, `ssh`                                                                                                                                          | `execute`        | `command` (raw text), `channel` (`bash` / `powershell` / `ssh`), `sandboxed` (bool — the host really confined this run in the OS command sandbox; always present, `false` for `ssh` and wherever there is no sandbox), `unconfinedReason` (why not: `''` when confined, `escalated` = the agent asked for full access, `disabled` = the sandbox is switched off, `unsupported` = no sandbox on this platform or for this shell, `unavailable` = the sandbox could not be applied this time, `remote` = `ssh`), and lazily from the shell parser (a `powershell` command is read by ShuviX's own PowerShell scanner: `base` is the canonical name — aliases resolved to cmdlets, path and `.exe` / `.com` dropped, case kept, so compare with `lowerAscii()` — and `-Name:value` is split into two items): `parsed` (bool), `commands` (list of `{ base, argv, wrappers, complete, depth }` — `base` is the real program after `sudo` / `env` / `timeout` are stripped, dynamic words are `''`), `writes` (redirect targets as absolute paths) |
| `gitTool`     | the `git` tool                                                                                                                                                       | `execute`        | `gitAction`, `command`, `force` (bool), `delete` (bool)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `database`    | the built-in `database` server's `query` tool                                                                                                                        | `execute`        | `sql`, `credential`, `dbType`, `readonly` (bool — whether the connection is read-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `url`         | the built-in `browser` / `chrome` servers: every navigation, and in `chrome` the first use of each site                                                              | `navigate`       | `url`, `scheme`, `host` (lower-cased, no trailing dot), `origin`, `browser` (`app` = the browser panel inside ShuviX, `chrome` = your own Chrome); `file://` is not a url object — it is judged as a read of that path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session`     | the `session` tool, every action that addresses a session other than the caller's own sub-sessions (reading it, waiting for it, sending it a message, steering, answering, stopping); its own sub-sessions never come here — gate those on `invocation` | `read` / `write` | `sessionId` (the target session), `title` (its title — written by an LLM, do not judge by it), `ownTurn` (bool — the action only concerns the turn the caller itself started there: collecting its answer, answering its question, steering or stopping it). `read` = read its answers, inspect it, wait for it; `write` = send it a message, steer, answer, stop. `tool.operation` names the action (`prompt-session`, `read-session` …) The host adds two facts: `lastActiveAt` (ISO 8601 UTC — when the target last had a user message, or when it was created if it never had one; to allow by age write `timestamp(object.lastActiveAt) > timestamp(vars.now) - duration('168h')`) and `bot` (the bot the target is bound to, written like `subject.bot`; empty when it is not a bot session) |
| `widget`      | the `widget` tool, every action that uses a widget: calling one of its operations, previewing, building, running SQL on its data, exporting it. Listing widgets and reading their operations never comes here | `read` / `write` | `widgetId`, `name` (the widget's name — written by an agent, do not judge by it), `operation` (the operation called, or the tool action such as `build` / `sql` / `preview`). `read` = call a read operation, preview, export; `write` = call an operation that writes, build it, run SQL on it. `tool.operation` names the tool action (`call`, `build` …) |
| `invocation`  | **every** tool call, before it runs                                                                                                                                  | `execute`        | none — judge it by `tool.name` / `tool.operation` (e.g. `session` / `create-sub-session`). A rule here must name a tool; an untargeted ask on `invocation` would stop every call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `modelRequest` | every request ShuviX sends to a model for an agent: the conversation's own, spawned and hook agents, the automatic reviewer, titles, compaction summaries | `send` | `provider` (the provider's name as Settings shows it — a builtin provider by its slug such as `anthropic` or `openai`, a provider you added by the name you gave it), `model` (the model id). An `allow` with `disposition: detect` redacts the request, an `allow` without it sends the real values, a `deny` — or an `ask`, since nobody can be asked here — does not send it at all |
| `sensitive`   | each piece of sensitive content in a request being redacted (only when the `modelRequest` rule carried `detect`) | `disclose` | `category` (`API_KEY`, `TOKEN`, `PASSWORD`, `SECRET`, `PRIVATE_KEY`, `EMAIL`, `PHONE`, … — the `redaction` entry lists all of them), `rule` (the detection rule that found it), `provider`, `model` (as on `modelRequest`), `value` (the real value — for `match` only; never logged). An `allow` with `disposition: redact` keeps the placeholder, an `allow` without it sends the real value, a `deny` stops the whole request |
| `socket`      | remote access: a connection opens, before HTTP is read                                                                                                               | `connect`        | none — judge it by `subject.address` and the other facts of the `network` subject (the `network-policy` entry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `request`     | remote access: every HTTP request, the WebSocket upgrade included                                                                                                    | `request`        | `method`, `path` (URL path), `query`, `route` (`page`, `asset`, `media`, `preview`, `download`, `lib`, `widget`, `socket`), `scope`, `access` — see Scope and access in the `network-policy` entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `channel`     | remote access: every call over the WebSocket                                                                                                                         | `invoke`         | `channel`, `group`, `scope` (which part, one of 15), `kind`, `access` (`read` / `write` / `admin`), `size`, `args` — the `network-channels` entry lists the channels scope by scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Strict semantics**: reading an attribute the object does not have (e.g. `object.path` on a
`command`) is an error, and an error **fail-safes by effect** — a `deny` / `ask` rule counts as
matched (with a warning), an allow rule as not matched. Always guard with the type:
`object.type == 'path' && inDir(object.path, …)`, or declare `object.type` as a condition.
Model requests (`modelRequest`, `sensitive`) are judged only by rules that name them: `object.type`
lists the type, or `action` lists `send` / `disclose`. Any other rule, however broad, never applies
there — an "ask me about everything" rule written for tools does not stop a bot's model requests.

### Functions available in `match`

- `inDir(path, dirs)` — `dirs` is a string or a list; true when `path` is inside one of them,
  on path-segment boundaries (`/foo` does not match `/foobar`); empty and non-string entries
  never match. On the desktop both sides are compared by **where they really lead**: `path` and
  every directory are resolved first (symlinks, `..`, the on-disk letter case), so a link in the
  workspace that points at `~/.ssh/id_rsa` is inside `~/.ssh`, and `~/.ssh` still matches when it
  is itself a link into a dotfiles repo. Relative directories are compared as written.
- `hasShortFlags(argv, 'rf')` — whether a GNU-style short-flag cluster in `argv` carries all of
  those letters (`-rf`, `-fr`, `-r -f` all count).
- `inCidr(ip, cidrs)` — whether the IP address `ip` is in one of `cidrs` (a string or a list of
  `a.b.c.d/n`, `x::/n` or single addresses); an IPv4-mapped IPv6 address counts as IPv4, and an
  entry that is not a valid network never matches. For remote access rules (`subject.address`).
- The usual CEL operators, `in`, `startsWith`, `has(...)`, string and list functions.

### `vars` — the host variable table

| Name                  | Type     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`           | string   | the session's working directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `aclRead`             | string[] | every path this session may read without asking — its **permission table** (below); write implies read, so every `aclWrite` path is here too. One row per source: the working directory (unless it is `/`, covers your home folder, or is ShuviX's own configuration or app data), a notebook session's own document, a bot session's own bot file, its temporary folder, artifacts and tool results, its knowledge bases (its project's own base and the ones ticked for it; the ShuviX manual read-only), the skill folders (read-only), and the granted paths — "allow and remember" on an ask card (the file or its folder), a path added by hand in the session's settings → File access, the folder of every widget the session may read and change (a read-and-write widget row). Computed by the host — the same table the command sandbox confines a command to |
| `aclWrite`            | string[] | every path this session may write without asking: the writable rows of the table — the working directory, a notebook's document and a bot session's own bot file (unless the user made them read-only), its temporary folder, artifacts and tool results, its knowledge bases except the ShuviX manual (every change to a base is committed to the base's own git) and write grants                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `aclSessionRead`      | string[] | ids of the other sessions this session may **read** without asking — the `session` rows of its permission table ("allow and remember" on a session question card); talking implies reading, so every `aclSessionWrite` id is here too. Its own sub-sessions need no row |
| `aclSessionWrite`     | string[] | ids of the other sessions this session may **talk to** without asking — send a message, steer, answer, stop a turn it started |
| `aclWidgetRead`       | string[] | ids of the widgets this session may **read** without asking — the `widget` rows of its permission table ("allow and remember" on a widget question card, or a widget the session created); read-and-write implies read |
| `aclWidgetWrite`      | string[] | ids of the widgets this session may **read and change** without asking — call any operation, build the widget, run SQL on it. Such a row also puts the widget's folder in `aclWrite` |
| `home`                | string   | the user's home directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `toolResultsBase`     | string   | where large tool results are spooled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `skillsDirs`          | string[] | the skill directories (global, builtin, registered external)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `botsDir`             | string   | `~/.shuvix/bots`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `builtinKnowledgeDir` | string   | the read-only knowledge base ShuviX ships (this one)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sessionArtifactsDir` | string   | this conversation's own artifacts, `~/.shuvix/artifacts/<session>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `shuvixConfigDirs`    | string[] | `~/.shuvix/policies`, `agents`, `hooks` and `skills` — ShuviX's own configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `systemDirs`          | string[] | extra OS directories (Windows system / program directories)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `now`                 | string   | this moment (ISO 8601 UTC) — use it with `timestamp(...)` and `duration('168h')` for rules that allow by time |
| `dailyDir`            | string   | `~/.shuvix/daily` — the daily reports folder |
| `trackingDir`         | string   | `~/.shuvix/tracking` — the tracked items folder (experimental) |

The permission table is made when the session is created. Rows that come from the session's
settings follow them (tick a knowledge base and its row appears); granted rows stay until the user
removes them. A sub-session starts with a copy of its parent's granted rows, a fork with its
source's granted rows and working-directory access; agents spawned in a session and its hook
agents use the session's table. A path outside the table is not refused — that is up to the
policies (ask-on-external-path asks). The table also holds **session rows**: another session this
one may read or talk to without asking (`vars.aclSessionRead` / `vars.aclSessionWrite`); only
"allow and remember" on a session question card writes them, they are listed under the session's
settings → Session access, and a row goes away when its session is deleted. Likewise **widget rows**:
a widget this one may use without asking (`vars.aclWidgetRead` / `vars.aclWidgetWrite`), written by
"allow and remember" on a widget question card or when the session creates the widget, listed under
Widget access, gone when the widget is deleted.

A `vars.x` that the host did not supply and that a rule uses **only** as `inDir`'s directory
argument is treated as "no such directory" (a positive `inDir` cannot match through it; a negated
one is true, i.e. the rule asks more). Any other use of a missing var errors into the fail-safe.

## What makes the file invalid

The whole file is rejected (skipped, listed as an amber row in the sidebar's Security Policies group,
never shadowing a builtin) on: no frontmatter / YAML error / not a mapping; a bare `rules` /
`lets` / `scope` key; `shuvix-policy-rules` not a list; a rule with an unknown key, an unknown
`effect`, an invalid condition value, a `match` that does not parse; a rule with no
`subject.kind` (rule or scope); a rule whose conditions intersect the scope to nothing; an
invalid `lets` (bad name, reserved name, non-string or unparsable expression, or one that reads
the request — `subject`, `object`, `action`, `tool`, `env` —, which a let never sees). A `match` that
reads `object.*` without declaring `object.type` is accepted with a warning.

## Builtin policies

Seven ship with the application (per UI language; **the rules are always taken from the
English file**, translations only change the text people read). The four gates for agents ask as
little as possible, so they are plain `ask` rules; the one for remote access is a `deny`, because
nobody can be asked there; `daily-bot-access` is no gate but a relaxation — two `force-allow` rules
for the diary bot that ships with ShuviX; `redact-sensitive` is no gate either — two `allow` rules
whose dispositions turn on auto-redaction. Beyond that, `deny`, `force-ask` and `force-allow` are for
policies of your own:

| Name                   | Gate                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask-on-external-path` | the file tools ask before reading a file in your home folder outside this session's permission table (`vars.aclRead`), and before writing anywhere outside its writable rows (`vars.aclWrite`), with a diff preview; "allow and remember" adds the file, or its folder, to the table. Reading outside the home folder does not ask |
| `ask-on-command`       | ask on every command that is not confined to the sandbox (`object.sandboxed` false: sandbox off or unavailable, full access requested, `ssh`)                                                                                                                                                                                      |
| `ask-on-session-access` | the `session` tool asks before reading or talking to a session that is not the caller's own sub-session, unless the action only concerns a turn the caller started there (`object.ownTurn`) or the session is in the permission table (`vars.aclSessionRead` / `vars.aclSessionWrite`); "allow and remember" adds it. The automatic review does not answer these — the builtin hook `auto-review` leaves `session` objects to you |
| `ask-on-widget-access` | the `widget` tool asks before using a widget that is not in the permission table at the needed level (`vars.aclWidgetRead` for read operations, previews and exports; `vars.aclWidgetWrite` for writes, builds and SQL); "allow and remember" adds it (a read card can also remember read-and-write). A session that creates a widget gets a read-and-write row for it. The automatic review does not answer these either — the builtin hook `auto-review` leaves `widget` objects to you |
| `network-admission`    | remote access (`subject.kind` `network`): refuses every HTTP request whose sender is not this computer (`127.0.0.0/8`, `::1`). Replace it with a user policy of the same name to let other devices in — the `network-policy` entry has recipes                                                                                     |
| `redact-sensitive`     | auto-redaction (the `redaction` entry): every model request from an agent is redacted (`modelRequest`, `disposition: detect`), and every piece of sensitive content in it reaches the model as a placeholder (`sensitive`, `disposition: redact`) — except `USERNAME`, `HOSTNAME`, `IP` and `BUCKET`, which are sent as they are. Disabling it sends the real values to every model; the conversation record keeps the placeholders either way |
| `daily-bot-access`     | relaxation only: the root agent of the diary bot (`subject.bot == 'bot:builtin:daily'`) reads, without asking, the sessions that had a message in the last 24 hours (over `ask-on-session-access`; the window is the `duration('24h')`, change it in an override copy) and reads `vars.dailyDir`, the diary (over `ask-on-external-path`). Nothing lets it write. A timer wakes it every evening, when nobody is likely to be there to answer. Applies only to that session's root agent, never to its sub-sessions or the agents it dispatches |

The two agent gates draw the same line: what the file tools ask about is exactly what a confined command
cannot reach, so an agent gains nothing by switching from `read` to `cat`. Both read the same
permission table, which follows the session's settings (its working directory, its knowledge
bases, the enabled skill directories) plus what the user granted; nobody maintains it by hand.
Credentials such as `~/.ssh` or `~/.aws` are in your home folder, so reading them asks like any
other file there.

The sidebar's Security Policies group lists each one (a row opens its md, rules on the property
card); "Create override copy" in a builtin row's menu writes the current text to
`~/.shuvix/policies/<name>.md`.

Earlier versions shipped more gates: refusing writes to system directories and a short list of
machine-destroying commands, always asking before writes to bot files and ShuviX's own
configuration, and asking before destructive git operations, SQL on a writable connection,
opening a sub-session and each new site in your Chrome. Later the path gates were folded into
ask-on-external-path: `protect-credentials` (a list of credential locations — they are now
covered as files in your home folder), `ask-on-write` (writes outside the working directory) and
`session-grants` (a `force-allow` for "allow and remember" — a remembered path is now a row of
the session's permission table, which the path rule leaves out through `vars.aclRead` /
`vars.aclWrite`). They were removed on purpose, but every enforcement point is still there (the
object types above), so any of them can come back as a policy of your own.

A builtin policy can be **disabled**: "Disable" in its row's menu in the sidebar, or the
_Enabled_ switch under its properties. A disabled policy is not applied at all — as if it did not
exist, so "no policy = allow" takes over (disabling `ask-on-command` lets unconfined commands run
without asking). The switch is stored in ShuviX, not in the file; the row stays listed, dimmed,
with a _Disabled_ badge. An override copy keeps the builtin's id and follows the same switch.
Agents cannot flip it — only you.

## Loosening and tightening

- **Remove a gate**: override it by name with `shuvix-policy-rules: []`.
- **Exempt one place from an ask** without touching the builtin: a new policy with a
  `force-allow` rule (`force-allow` beats `ask`), e.g. `action: [read]` with
  `match: inDir(object.path, vars.home + '/notes')` lets the file tools read `~/notes` without
  asking. A policy never widens the command sandbox — a confined command still cannot read
  there; a row in the session's permission table ("allow and remember", or one added in its
  settings → File access) is what reaches both.
- **Add an ask**: a new policy with an `ask` rule on the object you care about — see the example
  below.
- **Add a hard stop**: a `deny` rule — it beats everything, including the session's permission
  table.
- **Let "allow and remember" silence an ask of your own**: a path `ask` you write keeps asking
  after "allow and remember" unless its `match` leaves the permission table out the way
  ask-on-external-path does (`&& !inDir(object.path, vars.aclWrite)`; for reads `vars.aclRead`,
  which holds the writable paths too). That exempts every path in the table, the working
  directory included — which is the point: the table is the session's no-ask range.
- **Make a gate un-skippable**: `force-ask` — neither a `force-allow` nor the automatic reviewer
  can answer it, and its card offers no "allow and remember". That is also how to keep the
  reviewer away from one kind of operation, e.g. `object.unconfinedReason == 'escalated'` for
  "always ask me when the agent wants to leave the sandbox", or writes under `vars.botsDir` /
  `vars.shuvixConfigDirs` for "an agent changing a bot file or ShuviX's own configuration always
  asks me".
- **Auto-redaction**: trust a model, send one category as it is, never send another — a policy of
  your own with `force-allow` or `deny` on `modelRequest` / `sensitive`. The `redaction` entry
  has the recipes.
- Keep rules narrow: a deny cannot be waived per call, so a rule that fires on ordinary work is
  worse than one that misses.

For example, asking before every SQL statement on a writable database connection:

```markdown
---
shuvix: policy v1
name: ask-before-sql
description: Every statement on a writable database connection asks first.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [database]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: '!object.readonly'
    prompt: This connection has write access — the statement can change or delete data on the server.
---
```

Destructive git operations are the same shape with `object.type: [gitTool]` and a `match` such as
`object.gitAction == 'restore' || (object.gitAction == 'checkout' && object.force)`.

## Not in the file

The engine never reads the body (rationale for humans only). There is no per-tool schema, no
regex matching on raw command text (structure is what `commands` / `writes` are for), and no way
to change what a tool _does_ — a policy only decides whether a call proceeds.
