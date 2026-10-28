---
shuvix: okf v0.2
type: Guide
title: 'Skills (SKILL.md) as ShuviX reads them'
description: 'How ShuviX discovers, parses, enables and delivers skills — the SKILL.md frontmatter it actually reads, the skill sources (global, project, shared, external directories), `.config.json`, the slash-command expansion, the `skill` tool, and which agents get it.'
tags: [shuvix, skills, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/services/skillService.ts
    title: skillService.ts — discovery, parsing, enable state, slash-command expansion (source of truth)
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/services/skillTool.ts
    title: skillTool.ts — the `skill` tool that loads a skill on demand
---

# Skills

A **skill** is a reusable instruction pack: a directory with a `SKILL.md` and, optionally,
companion files (scripts, templates, references). ShuviX uses the community **Agent Skills**
layout — the same files work in other tools — and adds nothing to the format; what is specific to
ShuviX is *where* skills are found, *how* they are enabled, and *how* they reach an agent.

## The file

```markdown
---
name: conventional-comments
description: Use when reviewing code or writing review comments — the conventional-comments labels (praise, nitpick, suggestion, issue, …) and when each applies.
---

# Conventional comments

Prefix every review comment with a label…
Scripts for this skill live in ${CLAUDE_SKILL_DIR}/scripts.
```

ShuviX reads four frontmatter keys, with a **line-based** reader (YAML only helps with a multi-line `description`, below):

| Key           | Required | Meaning                                                                                                                                                                                                                   |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | **yes**  | The skill's name — the slash command and the name the `skill` tool lists. Single line; surrounding quotes are stripped. Keep it a simple identifier (letters, digits, `-`).                                               |
| `description` | no       | Preferably one line (a YAML `>` block is read too). It is what the `skill` tool shows the model and what the slash-command popover shows the user — write it as *when to use this skill*, with the words a user or model would search for. |
| `disable-model-invocation` | no | `true` keeps the skill off the `skill` tool: only the user can run it, as `/<name>`. Same key as in Claude Code. |
| `user-invocable` | no | `false` keeps the skill out of the `/` menu: only the model can load it. Same key as in Claude Code. |

Rules of the parser: the file must start with `---`; the frontmatter ends at the next `---`; each
line is split on its first `:`. A `description` written over several lines — a YAML `>` or `|`
block, or a sentence continued on the next indented line — is read through YAML when the
frontmatter is valid YAML; every other value, `name` always included, stays exactly as the line
reader sees it. If `name` is missing the
frontmatter is not recognised at all: the directory name becomes the name and the **entire file,
frontmatter included**, becomes the skill's content. Everything after the closing `---` is the
skill's body.

`SKILL.md` is the only file ShuviX reads. Companion files are for the agent to open with `read`
after loading the skill; refer to them by path from the skill's base directory.

## Where skills live

| Source           | Path                                         | Name as ShuviX sees it | Enable state                                                                 |
| ---------------- | -------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| global           | `~/.shuvix/skills/<dir>/SKILL.md`            | `<name>`               | on by default; can be disabled                                               |
| project          | `<project>/.claude/skills/<dir>/SKILL.md`    | `<name>`               | **always on** for sessions in that project; preferred when a name clashes    |
| shared           | `~/.claude/skills/<dir>/SKILL.md`, `~/.agents/skills/<dir>/SKILL.md` | `claude:<name>`, `agents:<name>` | **off by default**; turn the whole directory on from its row menu |
| external directory | any folder added from the sidebar's Skills group | `<dirName>:<name>` | on by default; the whole directory or single skills can be disabled          |
| builtin          | shipped inside the application, read-only    | `builtin:<name>`       | on by default; can be disabled                                               |

The two **shared** directories are the ones other agent tools use: `~/.claude/skills` is Claude
Code's, `~/.agents/skills` is the cross-tool Agent Skills location (Codex and pi read it, and
`npx skills add -g` puts the real copy there). ShuviX lists them without being asked — each gets a
row once it holds a skill, and the row cannot be removed — but leaves them **off** until the user
turns the directory on, since what is in them was installed for other tools. Their skills are the
user's own files and open as editable notes. A symbolic link inside any skills folder is not read
as a skill, so a skill that `npx skills add` linked into `~/.claude/skills` appears once, under
`agents`. If the same folder was already added as an external directory, that entry keeps it.

The directory name and `name` may differ; ShuviX matches by `name`. Builtin skills come with the
application (one directory per UI language) and cannot be edited; among them are
`builtin:drawing` — the craft for inline SVG figures — and `builtin:widget` — building and
maintaining widgets. They are on the shelf of every agent that has the `skill` tool, like any
other enabled skill: the `work`, `chat`, `coding`, `bot`, `notebook` and `tab` agents list it in
their `shuvix-tools`. Switching `builtin:drawing` off also drops the drawing section from the
system prompt of agents created afterwards.
Enable state lives in `~/.shuvix/skills/.config.json`:

```json
{ "disabled": ["<name>", "<dirName>:<name>"], "disabledDirs": ["<dirName>"], "enabledDirs": ["agents"], "dirs": [{ "name": "<dirName>", "path": "/abs/path" }] }
```

`enabledDirs` is the opposite of `disabledDirs` and applies only to the shared directories, which
start off.

Change it through the sidebar's Skills group (the enable / disable item in a row's menu); the
file is ShuviX's, not a place for hand edits.

**Reading a skill never asks; changing one does.** The builtin skills, `~/.shuvix/skills`,
every external directory that is not disabled and every shared directory that is turned on are
read-only rows of every session's permission table
(`vars.aclRead` in the `policy-md` entry): the file tools read them without asking, and a
sandboxed command may read them too. Writing there asks — a skill is instructions the agent
itself follows — so creating or editing a global or external skill on the user's behalf goes
through an approval. Project-level skills sit in the working directory and are treated like any
other file of the project.

## How a skill reaches the model

1. **Slash command** — typing `/<name>` in the input box inserts the skill as the message:
   `Base directory for this skill: <abs dir>` followed by the body, with `${CLAUDE_SKILL_DIR}`
   replaced by the skill's directory and `${CLAUDE_SESSION_ID}` by the current session id. The
   whole body enters the conversation as the user's text.
2. **The `skill` tool** — an agent whose `shuvix-tools` lists `skill` gets a `skill` tool whose
   description lists **every enabled skill** (minus those with `disable-model-invocation: true`)
   as `<name> / <description> / file://<dir>`; the model calls `skill` with a `name` to receive the
   full `SKILL.md` body plus a sample of the companion files, then reads what it needs. This is
   lazy: only names and descriptions are listed until the model asks for one, so a long skill
   costs little while unused. It works the way Claude Code and Codex do:
   - **No per-session or per-project choice**: there is no skill list in the session config, the
     input-box picker or the project settings. To keep a skill from the model, switch it (or its
     directory) off in the sidebar.
   - **Fixed when the agent is created**: the shelf is read when a session's agent is created and
     kept with it. Switching a skill on or off affects agents created from then on; a running
     agent keeps its shelf until it is rebuilt (the X on the agent chip), so its prompt cache
     is not broken.
   - **Per agent file**: listing `skill` gives the agent the whole shelf; an agent file cannot
     pick individual skills (an older `skill:<name>` entry is read as `skill`).
   - Project-level skills are on the shelf of agents working in that project.
3. **As a file to read** — nothing stops an agent from reading `SKILL.md` directly; the two
   mechanisms above just save it the path lookup.

## Writing a good skill for ShuviX

- Put the trigger conditions in `description`; put the procedure in the body. The description is
  the only thing the model sees before deciding to load the skill.
- Keep the body self-contained and imperative; link companion files by relative path or with
  `${CLAUDE_SKILL_DIR}` when the text will be used as a slash command.
- Name the directory after the skill (`conventional-comments/SKILL.md`) so the two never drift.
- After creating one, tell the user to look in the sidebar's Skills group (or that `/<name>` now
  appears in the input box); a global skill is picked up on the next scan without a restart.
