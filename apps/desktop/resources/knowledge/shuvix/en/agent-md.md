---
shuvix: okf v0.2
type: Guide
title: 'Agent definition file (shuvix: agent v1)'
description: 'The complete specification of a ShuviX agent file — every frontmatter key, the tool whitelist syntax, the prompt blocks ShuviX appends after the body, what makes a file invalid, the builtin agents, and how an agent is put to use.'
tags: [shuvix, agent, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/definitionFile.ts
    title: definitionFile.ts — the parser (source of truth)
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/promptBlocks.ts
    title: promptBlocks.ts — the blocks appended after the body
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/chat-protocol/src/agentPromptBlocks.ts
    title: agentPromptBlocks.ts — the `shuvix-prompt-blocks` vocabulary
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
shuvix-tools: read, ls, grep, glob, bash, skill
shuvix-model: anthropic/claude-sonnet-4-5
shuvix-thinking: low
shuvix-prompt-blocks: environment, agents_md, claude_md, project_prompt
---

You are a code reviewer. Read the diff the caller points you at, then report:
correctness risks first, then style, each with file and line. Never modify files.
```

## Frontmatter keys

| Key                         | Type                  | Required | Meaning                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`                    | `agent v1`            | no       | File-type marker. Always written by ShuviX; optional on read.                                                                                                                                                                                                                                                              |
| `name`                      | string                | no       | The agent's identity — what the `agent` tool, a hook's `shuvix-hook-agent` and a sub-session's `agent_profile` name. Defaults to the file's base name (`reviewer.md` → `reviewer`).                                                                                                                                         |
| `description`               | string                | no       | One human-facing line shown in the agents list. Not shown to the model.                                                                                                                                                                                                                                                    |
| `shuvix-displayName`        | string                | no       | Label in the UI. Defaults to `name`.                                                                                                                                                                                                                                                                                       |
| `shuvix-tools`              | comma-separated string| no       | The tool whitelist (see below). **A string, not a YAML list** — a list makes the file invalid. Omitted = no tools at all.                                                                                                                                                                                                  |
| `shuvix-model`              | string                | no       | Which model this agent runs on: `<providerId>/<modelId>` (what the UI writes) or a bare `<modelId>`. On a base (`work` / `chat` / `notebook` / `bot`) it is the model that kind of session runs on until one is picked in the session, ahead of the default model in Settings. Omitted = the agent follows the session it runs in (or the caller that dispatched it). A model that is not enabled in Settings is treated as absent.                                                                  |
| `shuvix-thinking`           | string                | no       | How deeply this agent thinks: `off` / `low` / `medium` / `high` / `xhigh` / `max` (case-insensitive). A dispatched agent runs at this level; a sub-session that names the agent through `agent_profile` starts at it (and can be changed in that session afterwards); on a base it is the level that kind of session runs at until one is picked in the session. Omitted = the caller's level (a sub-session follows its parent). Any other value makes the file invalid. |
| `shuvix-prompt-blocks`      | comma-separated string| no       | Which blocks ShuviX appends to the system prompt after the body (see below): any of `document`, `drawing`, `environment`, `agents_md`, `claude_md`, `project_prompt`. **A string, not a YAML list.** Omitted = nothing appended. |
| `shuvix-user-words`         | boolean               | no       | `true` = when this agent runs as a sub-session, each message its parent session sends it also carries the user's own words from the parent session — what the user typed there and their answers to its questions — quoted verbatim by ShuviX after the parent's text, so the agent can tell them from the parent's paraphrase. The first message carries everything so far (the first and the latest ten, each up to 4000 characters), later ones only what is new. Only the parent's own sub-sessions get it. Must be a real YAML boolean. Default `false`; the built-in `coding` agent has it on. |
| `shuvix-builtin`            | boolean               | no       | Self-marker of files ShuviX ships. Not read by the parser; do not add it to user files.                                                                                                                                                                                                                                    |
| `shuvix-id`                 | string                | no       | Object id — how ShuviX recognises this file wherever it moves. A UUID in files ShuviX creates, `<type>:builtin:<name>` in shipped ones; a copy shares its original's id. Written by ShuviX — leave it alone. A malformed value is ignored with a warning, never rejects the file.                                          |

Keys that are **ignored** (read as unknown, no error, no effect): the generic `tools` key (other
applications' meaning of tool names would be misread — use `shuvix-tools`), and the retired keys
`whenToUse`, `displayName`, `shuvix-dispatch-only`, `shuvix-session-awareness`,
`shuvix-prompt-sections`, `shuvix-project-prompt`, `shuvix-project-memory`,
`shuvix-instruction-files` (now the blocks `agents_md` / `claude_md`) and
`shuvix-project-awareness` (now the block `project_prompt`). A file that still carries the last
two gets no instruction file and no project prompt until it lists the blocks.

### `shuvix-tools` — the whitelist

A comma-separated string. Each entry is one of:

- a **builtin tool name** — case-insensitive, normalised to lower case: `bash`, `powershell`, `read`,
  `write`, `edit`, `move`, `delete`, `ls`, `glob`, `grep`, `ask`, `git`, `session`, `knowledge`, `artifact`;
- `agent` — opt-in to **dispatching sub-agents** with the `agent` tool (only up to the nesting
  cap: a dispatched agent may itself dispatch only while the depth limit, 2 by default, allows);
- `mcp:<server>` — every tool of that MCP server (the server's name as configured in Settings;
  case is kept after the prefix; the server is connected lazily when the agent is created). Three
  servers ship inside ShuviX and run in-process: `mcp:browser` (ShuviX's own browser panel),
  `mcp:ssh` (the hosts in your `~/.ssh/config`) and `mcp:database` (the database connections saved
  in ShuviX's settings). No builtin agent declares them — a session ticks them when it needs them —
  so an agent that should always drive the browser lists `mcp:browser`;
- `skill` — the `skill` tool. Its shelf is **every skill that is switched on** in the sidebar's
  Skills group (the ones shipped with ShuviX included) plus the session project's
  `.claude/skills`, minus any whose `SKILL.md` says `disable-model-invocation: true`; the model
  loads one when the task matches its description. An agent file does not pick individual
  skills, and neither does a session — the same as in Claude Code or Codex. An older file's
  `skill:<name>` entries are read as `skill`.

**Platform-specific tools** exist only on some platforms: `bash` on macOS and Linux, `powershell`
on Windows (Settings → LLM tools tags them with their platforms). List every platform's version —
the builtin agents list both `bash` and `powershell` — and each machine assembles the one it has, so the
same file works on every machine. An agent that lists only `bash` has no command tool on Windows.

Entries are de-duplicated in order. A name that does not exist on this host is silently dropped
— the agent is created without it. **Everything the list names is on**, however the agent is put
to use. When it is the root of a session, its `mcp:` entries appear in that session's extension
pickers ticked by default (hovering says which agent declared them). The session can tick more
servers, and can untick a declared one for itself; the session stores that as `-mcp:<server>` in
its selection, a project's default can carry it too, and the agent file is not touched. Removing
an entry for every session still means overriding the agent. Builtin tool names cannot be
unticked. Skills are not in the pickers at all: to keep a skill away from the model, switch it
off in the sidebar — that applies to agents created from then on; a running agent keeps the
shelf it was created with until you rebuild it (the X on the agent chip). Narrowing a list is
**not** how a role is expressed in ShuviX: an agent without `grep` just greps through `bash`.
The builtin `work`, `chat` and `coding` agents deliberately share one list (`bash, powershell, read, write,
edit, ask, suggest, show_image, ls, grep, glob, agent, session, knowledge, artifact, widget, tool_search, shuvix, skill`) and differ only in their bodies. `tool_search` is only given to a session's root agent: a dispatched agent does not get it even if its file lists it, because what it turns on belongs to the session.

### The body — the system prompt

Everything after the frontmatter, trimmed, is the system prompt, sent to the model exactly as
written. It is plain prose — there is no template syntax. The `{{shuvix:name}}` placeholders of
earlier versions are no longer replaced: one left in a body reaches the model as that literal
text, so delete it and list the block that carries the same information instead.

### `shuvix-prompt-blocks` — what ShuviX appends after the body

What depends on the session (where the agent works, today's date, the project's own
instructions …) is not written in the body. ShuviX renders it as **blocks**, each wrapped in an
XML tag, and appends them after the body; the file only says which ones it wants.

| Block            | Appended as                                  | Contains                                                                                                                                                                                                                                              | Not appended when                                                                                  |
| ---------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `document`       | `<document>`                                 | The document a notebook session has open (its path relative to the working directory). When it is one of ShuviX's own files (policy, hook, agent, bot, skill, knowledge entry): what it is, when a saved change applies, and which manual entry specifies it. | The agent is not the root agent of a notebook session.                                             |
| `drawing`        | `<drawing>`                                  | How to draw: load the builtin drawing skill before the first figure. In a chat it also says that a figure is part of the reply; an agent that edits a document (it holds `doc_edit`) gets only the load line.                                          | The agent has no `skill` tool, or the builtin drawing skill is switched off.                       |
| `environment`    | `<environment>`                              | A list, one fact per line: working directory and the session's temporary folder (only for an agent holding a file tool or a command tool); Git repository, Shell and OS (only with `bash` / `powershell`); Platform, Current date, User language, ShuviX version (always). | —                                                                                                  |
| `agents_md`      | `<project_instructions file="AGENTS.md">`    | The content of `AGENTS.md` in the working directory.                                                                                                                                                                                                  | The file is missing or empty.                                                                      |
| `claude_md`      | `<project_instructions file="CLAUDE.md">`    | The content of `CLAUDE.md` in the working directory.                                                                                                                                                                                                  | The file is missing or empty, or `agents_md` is listed too and the two files have the same content. |
| `project_prompt` | `<project_prompt>`                           | The project's prompt (the text in the project's settings).                                                                                                                                                                                            | The session has no project, or the project has no prompt.                                          |

- **The list is a set.** The order you write does not matter and names are case-insensitive:
  ShuviX always appends in the order of the table, and writes the key back in that order.
- **Listed does not mean present.** A block whose condition does not hold is left out whole, so
  the prompt never points at something the agent does not have.
- **Both instruction files are read.** With `agents_md` and `claude_md` both listed and both
  files present, both are in the prompt, `AGENTS.md` first. When their content is identical (one
  is a copy of, or a link to, the other) it is kept once, as `AGENTS.md`.
- **An unknown name is ignored** with a warning; it never rejects the file. Omitting the key appends nothing.
- A dispatched agent gets the same blocks, resolved against the session that dispatched it: that
  session's working directory, temporary folder and project. `document` is for a notebook
  session's root agent only.
- Guidance that belongs to one tool follows the tool, not this list: an agent holding
  `knowledge` gets `<knowledge_bases>` (the session's knowledge bases and when to use them), and
  a root agent holding `tool_search` gets `<extensions>` (what the session can turn on).

The blocks are rendered when the agent is created. A session's root agent then keeps its system
prompt for the whole conversation — a later edit of the agent file, `AGENTS.md` / `CLAUDE.md` or
the project prompt does not change it until you rebuild it (the small indicator before the usage
ring in the input box says when a source has changed and offers “Rebuild system prompt”).

## What makes the file invalid

The parser rejects the **whole file** (it is skipped, listed as an amber row at the bottom of
the sidebar's Agents group with the reason as its tooltip, and never shadows a builtin of the same
name) when:

- there is no YAML frontmatter block, or the YAML does not parse, or it is not a mapping;
- `shuvix-tools` / `shuvix-model` / `shuvix-prompt-blocks` is not a string (a YAML list is
  the usual mistake);
- `shuvix-thinking` is not one of `off` / `low` / `medium` / `high` / `xhigh` / `max` (`false` is not
  accepted either — write `off`);
- `shuvix-user-words` is not a boolean.

An empty frontmatter (`---` directly followed by `---`) is valid: every field takes its default.

## Builtin agents and overriding them

Shipped inside the application (per UI language, with the same parser): the five **base**
personas `work` (root of a session inside a project), `chat` (root of a session outside any
project), `notebook` (root of a notebook session — a note in the main window or a markdown file
opened in its own window — changing the document only through `doc_read` / `doc_edit` /
`doc_insert`), `bot` (root of a bot chat) and `tab` (root of a Chrome side panel conversation, the
only one holding `mcp:chrome` — the user's own Chrome) — plus
the task agents `coding`, `explore` and `titler`, and two agents only ShuviX
dispatches: `permission-reviewer`, which answers approval requests for the automatic review (see
the `policy-md` entry), and `knowledge-writer`, the knowledge librarian — the only agent that
writes knowledge bases, recording what other agents submit through the `knowledge` tool (see the
`knowledge-entry` entry).

- **A session's root persona is derived from the session's form, never chosen**: notebook or
  markdown window → `notebook`, bot chat → `bot`, Chrome side panel → `tab`, in a project → `work`, otherwise →
  `chat`. There is no setting
  and no picker. To change how a main conversation behaves, **override the base by name**:
  `~/.shuvix/agents/work.md` replaces the builtin `work` completely ("Create override copy" in
  the builtin row's menu in the sidebar's Agents group gives you the current text to start from).
- Any user file whose `name` equals a builtin's name replaces that builtin. Same-name copies
  among user files are resolved by the rule in the `shuvix-files` entry; losers are listed as
  Overridden. A broken override never shadows the builtin.
- The bases are **never dispatched and never named**: the `agent` tool, a hook's
  `shuvix-hook-agent` and a sub-session's `agent_profile` all refuse `work` / `chat` /
  `notebook` / `bot` / `tab`. `permission-reviewer` is refused by the `agent` tool and
  by `agent_profile` as well — an agent that could call its own reviewer at will could keep trying
  phrasings until one passed — but a hook may name it.

- **Model and thinking without an override: ShuviX settings.** In a builtin agent's md (opened from
  the sidebar's Agents group) the **Model** and **Thinking** rows of its properties can be changed
  although the file itself is read-only: the choice is stored in ShuviX (its value is shown in the
  accent color with a dotted underline; hover it to see where it comes from), keyed by the file's `shuvix-id`, and only **fills in** what the file does not
  write — a key the file writes always wins, and its row stays read-only. So a builtin such as
  `explore` can run on a cheaper model without an override copy, and keeps getting the shipped text
  on every update. An override copy keeps the builtin's id, so it gets the same settings. In your
  own agent files these rows edit the file as usual. Agents cannot change ShuviX settings — only you.

## How an agent is put to use

1. **Dispatched as a sub-agent** through the `agent` tool (the caller's own list must include
   `agent`): `name` = this file's `name`, plus a `prompt` and a short `description`. The sub-agent
   runs in memory as a peer of the root agent, inherits the session's model and thinking level
   unless `shuvix-model` / `shuvix-thinking` say otherwise, gets the blocks its own file lists
   (resolved against the root session's working directory and project), and returns its final text. The tool does **not**
   enumerate available agents to the model — a name must be known from the prompt or from the
   user.
2. **As the persona of a sub-session** — the `session` tool's `agent_profile` (any agent that is
   not a base). The child keeps the MCP servers it copied from its parent; the `mcp:` entries in
   that agent's `shuvix-tools` are on in addition, like everything else the list names, unless the
   copied selection unticks them.
3. **As a hook's agent** (`shuvix-hook-agent` — see the `hook-md` entry).
4. **As a base override** (above).

The blocks apply in every case: `shuvix-prompt-blocks` is read from **this** file, and the
knowledge-base guide is appended whenever the tool list contains `knowledge`.
