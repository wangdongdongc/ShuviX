---
shuvix: okf v0.2
type: Guide
title: 'Skills (SKILL.md) as ShuviX reads them'
description: 'How ShuviX discovers, parses, enables and delivers skills — the SKILL.md frontmatter it actually reads, the three skill sources (global, project, external directories), `.config.json`, the slash-command expansion, the `skill` tool, and the `skill:<name>` entries in agent files and session extensions.'
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

ShuviX reads exactly two frontmatter keys, with a **line-based** parser (not a YAML parser):

| Key           | Required | Meaning                                                                                                                                                                                                                   |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | **yes**  | The skill's name — the slash command and the value used in `skill:<name>`. Single line; surrounding quotes are stripped. Keep it a simple identifier (letters, digits, `-`).                                               |
| `description` | no       | One line. It is what the `skill` tool shows the model and what the slash-command popover shows the user — write it as *when to use this skill*, with the words a user or model would search for. Single line, quotes stripped. |

Rules of the parser: the file must start with `---`; the frontmatter ends at the next `---`; each
line is split on its first `:`; multi-line values are **not** supported. If `name` is missing the
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
| external directory | any folder registered in Settings → Skills | `<dirName>:<name>`     | on by default; the whole directory or single skills can be disabled          |
| builtin          | shipped inside the application, read-only    | `builtin:<name>`       | on by default; can be disabled                                               |

The directory name and `name` may differ; ShuviX matches by `name`. Builtin skills come with the
application (one directory per UI language) and cannot be edited; today there is one,
`builtin:drawing` — the craft for inline SVG figures — which the `work`, `chat`, `coding`, `bot`
and `notebook` agents name in their `shuvix-tools`.
Enable state lives in `~/.shuvix/skills/.config.json`:

```json
{ "disabled": ["<name>", "<dirName>:<name>"], "disabledDirs": ["<dirName>"], "dirs": [{ "name": "<dirName>", "path": "/abs/path" }] }
```

Edit it through Settings → Skills; the file is ShuviX's, not a place for hand edits.

## How a skill reaches the model

1. **Slash command** — typing `/<name>` in the input box inserts the skill as the message:
   `Base directory for this skill: <abs dir>` followed by the body, with `${CLAUDE_SKILL_DIR}`
   replaced by the skill's directory and `${CLAUDE_SESSION_ID}` by the current session id. The
   whole body enters the conversation as the user's text.
2. **The `skill` tool** — when a session (or an agent file) enables `skill:<name>` entries, the
   agent gets a `skill` tool whose description lists the enabled skills as
   `<name> / <description> / file://<dir>`; the model calls `skill` with a `name` to receive the
   full `SKILL.md` body plus a sample of the companion files, then reads what it needs. This is
   lazy: nothing is injected until the model asks for it, so a long skill costs nothing while
   unused.
   - **Per session**: the Extensions section of the session config (and the input-box tool
     picker) — stored in the session's `settings.enabledTools` as `skill:<name>`; a project's
     own defaults seed new sessions; the selection is read once when the session's agent is
     created and is read-only while that agent exists. Entries the session's agent file declares
     are listed there too, ticked and locked: they are on regardless of the selection.
   - **Per agent file**: `shuvix-tools: …, skill:<name>` in an agent md — that agent always has
     the skill, whatever the session selected.
   - Project-level skills are visible to the `skill` tool of any root agent working in that
     project.
3. **As a file to read** — nothing stops an agent from reading `SKILL.md` directly; the two
   mechanisms above just save it the path lookup.

## Writing a good skill for ShuviX

- Put the trigger conditions in `description`; put the procedure in the body. The description is
  the only thing the model sees before deciding to load the skill.
- Keep the body self-contained and imperative; link companion files by relative path or with
  `${CLAUDE_SKILL_DIR}` when the text will be used as a slash command.
- Name the directory after the skill (`conventional-comments/SKILL.md`) so the two never drift.
- After creating one, tell the user to check Settings → Skills (or that `/<name>` now appears in
  the input box); a global skill is picked up on the next scan without a restart.
