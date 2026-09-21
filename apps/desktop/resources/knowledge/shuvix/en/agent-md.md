---
shuvix: okf v0.2
type: Guide
title: 'Agent definition file (shuvix: agent v1)'
description: 'The complete specification of a ShuviX agent file — every frontmatter key, the tool whitelist syntax, the `{{shuvix:*}}` placeholders in the body, what makes a file invalid, the builtin agents, and how an agent is put to use.'
tags: [shuvix, agent, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/definitionFile.ts
    title: definitionFile.ts — the parser (source of truth)
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/promptVars.ts
    title: promptVars.ts — `{{shuvix:*}}` placeholders
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/subagent/builtinAgents/md
    title: builtin agents, one md per language
---

# Agent definition file

An **agent** is a persona plus a tool whitelist. Every agent in ShuviX — the ones it ships and
the ones the user writes — is one markdown file in this format: YAML frontmatter with the
identity and the switches, and a body that is the agent's **system prompt**.

- Location: `~/.shuvix/agents/<name>.md` (one file per agent; the directory may not exist yet).
- Marker: `shuvix: agent v1` as the first key. ShuviX always writes it; on read it is optional
  (older hand-written files load without it).
- Live on presence: the file is read when it is used. No registration, no restart.

## Example

```markdown
---
shuvix: agent v1
name: reviewer
description: Reads a change set and reports risks without editing anything.
shuvix-displayName: Code reviewer
shuvix-tools: read, ls, grep, glob, bash, skill:conventional-comments
shuvix-model: anthropic/claude-sonnet-4-5
shuvix-instruction-files: AGENTS.md, CLAUDE.md
shuvix-project-awareness: true
---

You are a code reviewer working in {{shuvix:workingDirectory}} on {{shuvix:date}}.
Read the diff the caller points you at, then report: correctness risks first, then
style, each with file and line. Never modify files.
```

## Frontmatter keys

| Key                         | Type                  | Required | Meaning                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`                    | `agent v1`            | no       | File-type marker. Always written by ShuviX; optional on read.                                                                                                                                                                                                                                                              |
| `name`                      | string                | no       | The agent's identity — what the `agent` tool, a hook's `shuvix-hook-agent` and a sub-session's `agent_profile` name. Defaults to the file's base name (`reviewer.md` → `reviewer`).                                                                                                                                         |
| `description`               | string                | no       | One human-facing line shown in the agents list. Not shown to the model.                                                                                                                                                                                                                                                    |
| `shuvix-displayName`        | string                | no       | Label in the UI. Defaults to `name`.                                                                                                                                                                                                                                                                                       |
| `shuvix-tools`              | comma-separated string| no       | The tool whitelist (see below). **A string, not a YAML list** — a list makes the file invalid. Omitted = no tools at all.                                                                                                                                                                                                  |
| `shuvix-model`              | string                | no       | Which model this agent runs on: `<providerId>/<modelId>` (what the UI writes) or a bare `<modelId>`. Omitted = the agent follows the session it runs in (or the caller that dispatched it). A model that is not enabled in Settings is treated as absent.                                                                  |
| `shuvix-instruction-files`  | comma-separated string| no       | Project instruction files the agent reads, as paths **relative to the working directory**, in priority order: the first one that exists and is non-empty is injected, at most one. An absolute path, a `..` segment, or a boolean value makes the file invalid. Omitted = nothing injected.                              |
| `shuvix-project-awareness`  | boolean               | no       | `true` = the agent is told which project it is in: the project's prompt and the project's memory index are appended to its system prompt (resolved against the root session's project; nothing when the session has no project). Must be a real YAML boolean. Default `false`.                                        |
| `shuvix-builtin`            | boolean               | no       | Self-marker of files ShuviX ships. Not read by the parser; do not add it to user files.                                                                                                                                                                                                                                    |

Keys that are **ignored** (read as unknown, no error, no effect): the generic `tools` key (other
applications' meaning of tool names would be misread — use `shuvix-tools`), and the retired keys
`whenToUse`, `displayName`, `shuvix-dispatch-only`, `shuvix-session-awareness`,
`shuvix-prompt-sections`, `shuvix-project-prompt`, `shuvix-project-memory`.

### `shuvix-tools` — the whitelist

A comma-separated string. Each entry is one of:

- a **builtin tool name** — case-insensitive, normalised to lower case: `bash`, `read`, `write`,
  `edit`, `ls`, `glob`, `grep`, `ask`, `browser`, `database`, `git`,
  `session`, `knowledge`, `artifact`;
- `agent` — opt-in to **dispatching sub-agents** with the `agent` tool (only up to the nesting
  cap: a dispatched agent may itself dispatch only while the depth limit, 2 by default, allows);
- `mcp:<server>` — every tool of that MCP server (the server's name as configured in Settings;
  case is kept after the prefix; the server is connected lazily when the agent is created);
- `skill:<name>` — that skill (a namespaced skill is written `skill:<dir>:<name>`; the skills
  shipped with ShuviX are `skill:builtin:<name>`).

Entries are de-duplicated in order. A name that does not exist on this host is silently dropped
— the agent is created without it. **Everything the list names is on**, however the agent is put
to use. When it is the root of a session, its `mcp:` / `skill:` entries appear in that session's
extension pickers ticked and locked (hovering says which agent declared them); the session's own
ticks only add to them, and taking one away means overriding the agent. Narrowing a list is
**not** how a role is expressed in ShuviX: an agent without `grep` just greps through `bash`.
The builtin `work`, `chat` and `coding` agents deliberately share one list (`bash, read, write,
edit, ask, browser, ls, grep, glob, database, agent, session, knowledge, artifact,
skill:builtin:drawing`) and differ only in their bodies.

### The body — the system prompt

Everything after the frontmatter, trimmed, is the system prompt. It may embed **placeholders**
of the form `{{shuvix:name}}`, substituted when the agent is created. On the desktop host:

| Placeholder                    | Value                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `{{shuvix:workingDirectory}}`  | absolute working directory of the session                                           |
| `{{shuvix:isGitRepo}}`         | `Yes` / `No` — whether that directory has a `.git`                                 |
| `{{shuvix:platform}}`          | `darwin` / `win32` / `linux`                                                        |
| `{{shuvix:shell}}`             | `zsh` / `bash` / `fish` / the shell's path                                          |
| `{{shuvix:os}}`                | OS type and release                                                                 |
| `{{shuvix:date}}`              | today, `YYYY-MM-DD`                                                                 |
| `{{shuvix:language}}`          | the UI language, e.g. `中文 (zh)` / `English (en)`                                  |
| `{{shuvix:appVersion}}`        | the ShuviX version                                                                  |
| `{{shuvix:projectName}}`       | the project's name, empty outside a project                                         |
| `{{shuvix:notebookPath}}`      | the bound file of a notebook session (root agents of notebook sessions only)        |

An unknown placeholder is kept verbatim (and logged as a warning); an empty value collapses the
blank lines around it, so a sentence built on an empty variable disappears cleanly. The syntax
does not clash with i18n templates. Everything else in the body is plain prose — there is no
other template syntax.

## What makes the file invalid

The parser rejects the **whole file** (it is skipped, listed under "cannot be parsed" in
Settings → Agents, and never shadows a builtin of the same name) when:

- there is no YAML frontmatter block, or the YAML does not parse, or it is not a mapping;
- `shuvix-tools` / `shuvix-model` / `shuvix-instruction-files` is not a string (a YAML list is
  the usual mistake);
- `shuvix-project-awareness` is not a boolean;
- an entry of `shuvix-instruction-files` is absolute or escapes the working directory (`..`), or
  the key holds the pre-2026 boolean form (`shuvix-instruction-files: true` — list file names
  instead).

An empty frontmatter (`---` directly followed by `---`) is valid: every field takes its default.

## Builtin agents and overriding them

Shipped inside the application (per UI language, with the same parser): the four **base**
personas `work` (root of a session inside a project), `chat` (root of a session outside any
project), `notebook` (root of a notebook session) and `bot` (root of a bot chat) — plus the task
agents `coding`, `explore`, `widget`, `titler` and `knowledge-writer`.

- **A session's root persona is derived from the session's form, never chosen**: notebook →
  `notebook`, bot chat → `bot`, in a project → `work`, otherwise → `chat`. There is no setting
  and no picker. To change how a main conversation behaves, **override the base by name**:
  `~/.shuvix/agents/work.md` replaces the builtin `work` completely (Settings → Agents →
  "create override copy" gives you the current text to start from).
- Any user file whose `name` equals a builtin's name replaces that builtin. Same-name copies
  among user files are resolved by the rule in the `shuvix-files` entry; losers are listed as
  Overridden. A broken override never shadows the builtin.
- The bases are **never dispatched and never named**: the `agent` tool, a hook's
  `shuvix-hook-agent` and a sub-session's `agent_profile` all refuse `work` / `chat` /
  `notebook` / `bot`.

## How an agent is put to use

1. **Dispatched as a sub-agent** through the `agent` tool (the caller's own list must include
   `agent`): `name` = this file's `name`, plus a `prompt` and a short `description`. The sub-agent
   runs in memory as a peer of the root agent, inherits the session's model and thinking level
   unless `shuvix-model` says otherwise, gets the same instruction-file / project injections
   resolved against the root session's project, and returns its final text. The tool does **not**
   enumerate available agents to the model — a name must be known from the prompt or from the
   user.
2. **As the persona of a sub-session** — the `session` tool's `agent_profile` (any agent that is
   not a base). The child keeps the extensions it copied from its parent; the `mcp:` / `skill:`
   entries in that agent's `shuvix-tools` are on in addition, like everything else the list names.
3. **As a hook's agent** (`shuvix-hook-agent` — see the `hook-md` entry).
4. **As a base override** (above).

Context injections apply in every case: `shuvix-instruction-files` and
`shuvix-project-awareness` are read from **this** file, and the knowledge-base guide is injected
whenever the tool list contains `knowledge`.
