---
shuvix: okf v0.2
type: Guide
title: 'Security policy file (shuvix: policy v1)'
description: 'The complete specification of a ShuviX security policy — the request document a rule sees (subject / action / tool / object / env / vars), the five condition keys, CEL `match`, effects and their precedence, who answers an ask (the automatic review, then you), `lets`, what makes a file invalid, the builtin policies, and how to loosen or tighten a gate.'
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
operating system (it can change files only in the project, temporary folders and package caches,
and cannot read credentials, ShuviX's data or personal folders). The host reports whether a run was
really confined as the command's `sandboxed` attribute, and the builtin policies decide on it: a
confined command runs without asking, an unconfined one — sandbox off, not available, the agent
asking for full access, every `ssh` command — asks, and then runs with the user's full privileges.

An `ask` does not go to the user straight away. With **automatic review** on (Settings → General →
Security, on by default), a reviewing agent answers it first, in a fresh context that sees only what the
user wrote and the operation itself: it lets ordinary work through, refuses what is clearly
harmful, and puts the rest in front of the user with its opinion on the card. The reviewer is
a filter, not a boundary — the sandbox and the `deny` rules are. `force-ask` always goes to the
user. The reviewer is the builtin hook `auto-review` and the agent `permission-reviewer`; see the
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

**What it does**: any write under `~/Documents/drafts` is refused, even with auto-allow on.
The body is documentation only — the engine never reads it.
```

## Frontmatter keys

| Key                     | Type                       | Required | Meaning                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`                | `policy v1`                | no       | File-type marker.                                                                                                                                                                                                                             |
| `name`                  | string                     | no       | Identity (what an override matches on). Defaults to the file's base name.                                                                                                                                                                     |
| `shuvix-displayName`    | string                     | no       | Label in the sidebar's Security Policies group and on ask cards. Defaults to `name`.                                                                                                                                                                            |
| `description`           | string                     | no       | One line for the list.                                                                                                                                                                                                                        |
| `shuvix-policy-scope`   | mapping                    | no       | Conditions shared by **every rule** of this policy (AND-ed into each). Same keys as rule conditions. A rule whose own conditions contradict the scope (intersection empty) makes the file invalid.                                            |
| `shuvix-policy-lets`    | mapping name → CEL string  | no       | Named values computed once from `{vars}` and injected into every rule's `match` as top-level names. Names must be identifiers and must not be `subject`, `action`, `tool`, `object`, `env`, `vars` or `inDir`. Evaluated lazily, when needed. |
| `shuvix-policy-rules`   | list of rules              | **yes**  | The only thing the engine evaluates. May be an empty list (an override with `[]` switches a builtin gate off).                                                                                                                                |

Bare `rules:`, `lets:` or `scope:` keys make the file invalid — a misspelt key must not silently
mean "no rules". Other unprefixed unknown keys are ignored.

### A rule

| Rule key                                                       | Meaning                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect`                                                       | **required**: `allow`, `force-allow`, `ask`, `force-ask` or `deny`.                                                                                                                                                       |
| `subject.kind`, `action`, `object.type`, `env.host`, `tool.name` | structured conditions: a string or a list of strings (list = OR, keys = AND); `'*'` = any; an empty list or empty string is invalid. **`subject.kind` is required** on the rule or in the scope — use `'*'` deliberately. |
| `match`                                                        | optional CEL expression over the request document (below), AND-ed with the conditions. A syntax error invalidates the file.                                                                                               |
| `prompt`                                                       | optional one-liner. On `ask` it is shown on the ask card; on `deny` it is returned to the agent as the refusal reason; on allow rules it is only shown on the policy's property card. Max 1000 characters. The one key that never invalidates a file. |

Any other key in a rule invalidates the file (the old nested `object:` / `subject:` / `when:`
matchers included).

### Effects and precedence

Among all matching rules of all policies, the strongest effect wins:

```
deny  >  force-ask  >  force-allow  >  ask  >  allow  >  (nothing matched = allow)
```

- `ask` puts the call in front of the automatic reviewer, then — if it does not settle it — the
  user; `allow` answers it; `deny` refuses it (the agent gets `prompt` as the reason).
- `force-allow` is an allow that also beats every `ask` — ShuviX uses it for session grants
  ("auto-allow" and "allow and remember"). A `force-allow` never reaches the reviewer.
- `force-ask` is an ask that even `force-allow` cannot skip, and that only the user answers —
  "this gate accepts neither session consent nor the reviewer" (the bot-file and ShuviX-config
  gates are two).
- `deny` beats everything.

Conditions compile to native predicates evaluated **before** the CEL, so a rule whose conditions
miss never runs its `match` or the policy's `lets`.

## The request document

Every check is a five-part request; `match` sees it as:

```
subject  { kind: 'agent' | 'user', agentKind: 'root' | 'spawned', profile: <agent name>, sessionId, depth }
action   'read' | 'write' | 'execute'
tool     { name: <tool name>, operation: <tool-specific op, '' if none> }
object   { type: <object type>, ...attributes }        ← an open attribute document
env      { host: 'desktop' | 'extension', platform: 'darwin' | 'win32' | 'linux' }
vars     the host variable table (below) + session grants
```

`subject.kind` is `agent` for tool calls and `user` for the UI's own passive checks — that is
why every builtin rule carries `subject.kind: [agent]`.

### Object types and their attributes

| `object.type`  | Raised by                                                   | `action`         | Attributes                                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`         | `read`, `write`, `edit`, the `knowledge` tool, file previews | `read` / `write` | `path` (where the path really leads: absolute; on the desktop symlinks are followed and `..` goes to the real parent, as the OS does when it opens the path), `requestedPath` (the absolute path as the tool asked for it — differs from `path` when a link or `..` was in the way), `displayPath` (as the model wrote it, for messages) |
| `command`      | `bash`, `powershell`, `ssh`                                 | `execute`        | `command` (raw text), `channel` (`bash` / `powershell` / `ssh`), `sandboxed` (bool — the host really confined this run in the OS command sandbox; always present, `false` for `ssh` and wherever there is no sandbox), `unconfinedReason` (why not: `''` when confined, `escalated` = the agent asked for full access, `disabled` = the sandbox is switched off, `unsupported` = no sandbox on this platform or for this shell, `unavailable` = the sandbox could not be applied this time, `remote` = `ssh`), and lazily from the shell parser (a `powershell` command is read by ShuviX's own PowerShell scanner: `base` is the canonical name — aliases resolved to cmdlets, path and `.exe` / `.com` dropped, case kept, so compare with `lowerAscii()` — and `-Name:value` is split into two items): `parsed` (bool), `commands` (list of `{ base, argv, wrappers, complete, depth }` — `base` is the real program after `sudo` / `env` / `timeout` are stripped, dynamic words are `''`), `writes` (redirect targets as absolute paths) |
| `gitTool`      | the `git` tool                                              | `execute`        | `gitAction`, `command`, `force` (bool), `delete` (bool)                                                                                                                                                                                                                                                  |
| `database`     | the built-in `database` server's `query` tool               | `execute`        | `sql`, `credential`, `dbType`, `readonly` (bool — whether the connection is read-only)                                                                                                                                                                                                                   |
| `url`          | the built-in `browser` / `chrome` servers: every navigation, and in `chrome` the first use of each site | `navigate`       | `url`, `scheme`, `host` (lower-cased, no trailing dot), `origin`, `browser` (`app` = the browser panel inside ShuviX, `chrome` = your own Chrome); `file://` is not a url object — it is judged as a read of that path |
| `invocation`   | **every** tool call, before it runs                         | `execute`        | none — judge it by `tool.name` / `tool.operation` (e.g. `session` / `create-sub-session`). A rule here must name a tool; an untargeted ask on `invocation` would stop every call.                                                                                                                       |

**Strict semantics**: reading an attribute the object does not have (e.g. `object.path` on a
`command`) is an error, and an error **fail-safes by effect** — a `deny` / `ask` rule counts as
matched (with a warning), an allow rule as not matched. Always guard with the type:
`object.type == 'path' && inDir(object.path, …)`, or declare `object.type` as a condition.

### Functions available in `match`

- `inDir(path, dirs)` — `dirs` is a string or a list; true when `path` is inside one of them,
  on path-segment boundaries (`/foo` does not match `/foobar`); empty and non-string entries
  never match. On the desktop both sides are compared by **where they really lead**: `path` and
  every directory are resolved first (symlinks, `..`, the on-disk letter case), so a link in the
  workspace that points at `~/.ssh/id_rsa` is inside `~/.ssh`, and `~/.ssh` still matches when it
  is itself a link into a dotfiles repo. Relative directories are compared as written.
- `hasShortFlags(argv, 'rf')` — whether a GNU-style short-flag cluster in `argv` carries all of
  those letters (`-rf`, `-fr`, `-r -f` all count).
- The usual CEL operators, `in`, `startsWith`, `has(...)`, string and list functions.

### `vars` — the host variable table

| Name                    | Type     | Meaning                                                                                       |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `workspace`             | string   | the session's working directory                                                               |
| `home`                  | string   | the user's home directory                                                                     |
| `toolResultsBase`       | string   | where large tool results are spooled                                                          |
| `skillsDirs`            | string[] | the skill directories (global, builtin, registered external)                                  |
| `memoryDirs`            | string[] | the legacy project-memory root                                                                |
| `botsDir`               | string   | `~/.shuvix/bots`                                                                              |
| `builtinKnowledgeDir`   | string   | the read-only knowledge base ShuviX ships (this one)                                          |
| `sessionArtifactsDir`   | string   | this conversation's own artifacts, `~/.shuvix/artifacts/<session>`                            |
| `shuvixConfigDirs`      | string[] | `~/.shuvix/policies`, `agents`, `hooks` and `skills` — ShuviX's own configuration              |
| `workspaceWritable`     | string[] | the working directory, where file-tool writes do not ask (empty on Windows, and where the working directory is unsuitable — `/`, a folder covering your home, ShuviX's own data) |
| `workspaceWriteDenied`  | string[] | protected places inside it (a project's `.vscode`, `.claude`, …; credential dirs)             |
| `workspaceProtectedPatterns` | string[] | regexes of protected git metadata inside it — use with `matches`                    |
| `sandboxActive`         | boolean  | this session's commands run in the command sandbox                                            |
| `sandboxWritableRoots`  | string[] | where a confined command may write (empty when the sandbox is not active)                     |
| `sandboxWriteDenied`    | string[] | protected places inside those roots (a project's `.vscode`, `.claude`, …; credential dirs)    |
| `sandboxProtectedPatterns` | string[] | regexes of protected git metadata (`.git/hooks`, `.git/config`, …) — use with `matches` |
| `sandboxReadDenied`     | string[] | what a confined command cannot read (personal folders, ShuviX's data, credential dirs)        |
| `sandboxReadAllowed`    | string[] | readable exceptions inside those (the workspace, this session's tool results, read grants)    |
| `systemDirs`            | string[] | extra OS directories (Windows system / program directories)                                   |
| `autoAllow`             | boolean  | the session's "auto-allow" switch                                                             |
| `grantedRead`, `grantedWrite` | string[] | paths the user answered "allow and remember" for in this session (write implies read) |

A `vars.x` that the host did not supply and that a rule uses **only** as `inDir`'s directory
argument is treated as "no such directory" (a positive `inDir` cannot match through it; a negated
one is true, i.e. the rule asks more). Any other use of a missing var errors into the fail-safe.

## What makes the file invalid

The whole file is rejected (skipped, listed as an amber row in the sidebar's Security Policies group,
never shadowing a builtin) on: no frontmatter / YAML error / not a mapping; a bare `rules` /
`lets` / `scope` key; `shuvix-policy-rules` not a list; a rule with an unknown key, an unknown
`effect`, an invalid condition value, a `match` that does not parse; a rule with no
`subject.kind` (rule or scope); a rule whose conditions intersect the scope to nothing; an
invalid `lets` (bad name, reserved name, non-string or unparsable expression). A `match` that
reads `object.*` without declaring `object.type` is accepted with a warning.

## Builtin policies

Thirteen ship with the application (per UI language; **the rules are always taken from the
English file**, translations only change the text people read):

| Name                            | Gate                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `protect-credentials`           | deny writes to and ask on reads of credential directories (`.ssh`, `.aws`, …)                                        |
| `protect-system`                | deny writes to operating-system directories                                                                            |
| `block-catastrophic-commands`   | deny a short list of machine-destroying commands, judged on parsed structure (`rm -rf /`, `mkfs`, `dd` to a device, `Format-Volume`…) |
| `protect-bot-files`             | **force-ask** on any write under `~/.shuvix/bots`                                                                      |
| `protect-shuvix-config`         | **force-ask** on any write under `~/.shuvix/policies`, `agents`, `hooks` and `skills`                                  |
| `ask-on-read`                   | ask on reads outside the workspace, tool results, skill directories and this reference base; with the sandbox active, only on the places a confined command cannot read |
| `ask-on-write`                  | ask on file writes, with a diff preview — except this conversation's artifacts, the working directory (minus its protected spots, not on Windows) and, with the sandbox active, where a confined command may write anyway |
| `ask-on-command`                | ask on every command that is not confined to the sandbox (`object.sandboxed` false: sandbox off or unavailable, full access requested, `ssh`) |
| `git-safety`                    | ask on destructive git operations (`init`, `restore`, forced checkout, branch delete)                                  |
| `ask-on-database`               | ask on every statement over a writable database connection                                                             |
| `ask-on-sub-session`            | ask once when a sub-session is opened (`tool.name == 'session' && tool.operation == 'create-sub-session'`)             |
| `ask-on-new-site`               | in your own Chrome (the ShuviX side panel), ask the first time a conversation opens or works on a site (`object.browser == 'chrome'`) |
| `session-grants`                | `force-allow` everything while the session's auto-allow switch is on, and reads / writes under paths the user answered "allow and remember" for |

The sidebar's Security Policies group lists each one (a row opens its md, rules on the property
card); "Create override copy" in a builtin row's menu writes the current text to
`~/.shuvix/policies/<name>.md`.

## Loosening and tightening

- **Remove a gate**: override it by name with `shuvix-policy-rules: []`.
- **Exempt one place from an ask** without touching the builtin: a new policy with a
  `force-allow` rule (`force-allow` beats `ask`), e.g. writes under one directory.
- **Add a hard stop**: a `deny` rule — it beats everything, including auto-allow.
- **Make a gate un-skippable**: `force-ask` — neither auto-allow nor the automatic reviewer can
  answer it. That is also how to keep the reviewer away from one kind of operation, e.g.
  `object.unconfinedReason == 'escalated'` for "always ask me when the agent wants to leave the
  sandbox".
- Keep rules narrow: a deny cannot be waived per call, so a rule that fires on ordinary work is
  worse than one that misses.

## Not in the file

The engine never reads the body (rationale for humans only). There is no per-tool schema, no
regex matching on raw command text (structure is what `commands` / `writes` are for), and no way
to change what a tool *does* — a policy only decides whether a call proceeds.
