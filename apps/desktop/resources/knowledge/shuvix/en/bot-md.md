---
shuvix: okf v0.2
type: Guide
title: 'Bot file (shuvix: bot v2)'
description: 'The complete specification of a ShuviX bot file — the three identity keys, the persona-and-memory body, how a bot chat is bound to it, what the bot may and may not do, and how the bot maintains its own file.'
tags: [shuvix, bot, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/bot/botFile.ts
    title: botFile.ts — the parser (source of truth)
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/subagent/builtinAgents/md/bot.md
    title: bot.md — the `bot` base persona a bot chat runs on
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/protect-bot-files.md
    title: protect-bot-files — the always-ask gate on bot files
---

# Bot file

A **bot** is a markdown file bound to an ordinary chat session: **three identity keys and one
body**. The body is the bot's **persona and memory** — who it is, how it talks, and what it has
learned about the user — and it is appended to the system prompt of every conversation held with
that bot. That is the whole format: a bot file declares no tools, no model, no pipeline. *How* a
bot works is fixed by the builtin `bot` persona; *what* it runs on (model, extensions) is the
session's business.

- Location: `~/.shuvix/bots/<name>.md`.
- Marker: `shuvix: bot v2`. Optional on read, but a **different type is rejected**: an agent file
  dropped into `bots/` is refused, not read as a persona. The version is not checked.
- Live on presence, no builtin bots, no enable switch.

## Example

```markdown
---
shuvix: bot v2
name: mentor
shuvix-displayName: Mentor
description: A patient writing coach who remembers what I am working on.
---

## Who I am

You are Mentor, a writing coach. You ask before you rewrite, you quote the sentence you are
talking about, and you never pad feedback with praise.

## What I remember

- The user is drafting a novel set in 1920s Shanghai; chapters live in ~/Documents/novel.
- Prefers feedback on structure first, prose second.
```

## Frontmatter keys

| Key                   | Type      | Required | Meaning                                                                                                                   |
| --------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`              | `bot v2`  | no       | File-type marker. Wrong type → the whole file is rejected.                                                                 |
| `name`                | string    | no       | The bot's stable identity — what a bot session stores in `settings.bot`. Defaults to the file's base name.               |
| `shuvix-displayName`  | string    | no       | Label in the sidebar and the session header. Defaults to `name`. Must be a string if present.                            |
| `description`         | string    | no       | One line for the list and the new-bot-chat picker. Purely display. Must be a string if present.                          |

Everything else is ignored, with one exception: the retired v1 key `shuvix-bot-pipeline` (from
the pipeline era, when a bot named a workflow) still parses but earns a **warning asking you to
delete it** — it looks like configuration and controls nothing. `shuvix: bot v1` files therefore
keep working; only the leftover block is noise.

Invalid (whole file rejected, listed in the Bots group as unparseable): no frontmatter, YAML
error, frontmatter not a mapping, a `shuvix` marker of another type, or a non-string
`shuvix-displayName` / `description`.

## The body — persona and memory

The trimmed body is injected verbatim into the **root agent** of every session bound to this
bot, inside a `<bot_profile name="…" file="…">` fence, after a short host preamble that states
the self-maintenance rule (below). The system prompt is outside rolling compaction, so the
injection lasts for the whole conversation.

- **Only the root agent gets it.** A sub-session the bot opens, or an agent it dispatches, builds
  its own system prompt from its own agent file and never sees the bot's body. "The persona
  shapes how the bot talks, not how work gets done" is a structural guarantee.
- The body may be empty (a freshly created bot is), but keep at least the two headings the
  new-bot template seeds (**who I am** / **what I remember**): the bot maintains its own file
  with `edit`, and `edit` needs existing text to anchor on. The first section is the user's to
  write; the second is the bot's.

## A bot chat

A **bot session** is a session created with `settings.bot = <name>` (sidebar → a project group's
menu → "new bot chat" → pick a bot). The binding is decided at creation and **never changed** —
switching bots means a new session, because the history is that bot's words. Otherwise it is an
ordinary rooted session: model picker, extensions, compaction, export, sub-sessions and
background auto-resume all work as usual.

Its root persona is the builtin **`bot`** base, whose tool list is deliberately narrow:
`read, ls, grep, glob, ask, edit, session, agent, knowledge, artifact, skill:builtin:drawing` —
no `bash` or `write`, and none of the built-in capability servers `mcp:ssh` / `mcp:browser` /
`mcp:database` is declared (the user can still tick them on in the session's extensions — that
is the user's own call). The bot can look but not touch: anything that changes or runs must go
to a sub-session (programming work → `agent_profile: coding`). `edit` is there for one purpose —
maintaining its own file — and every write under `~/.shuvix/bots/` goes through the builtin
policy **protect-bot-files**, which asks the user even when auto-allow is on. Like `notebook`,
the base declares project awareness but reads no instruction files (AGENTS.md / CLAUDE.md are
conventions for the sub-session that does the coding). The base can be overridden by name
(`~/.shuvix/agents/bot.md`) like any builtin agent.

## Lifecycle notes

- **Editing** a bot = opening its file in ShuviX (the Bots group row) as a notebook session:
  live preview, property card, autosave. There is no bot page and no Save button.
- **Renaming** through the frontmatter `name` migrates the sessions bound to the old name when
  ShuviX next scans the directory (it compares each file's name with what it saw last time); a
  rename done while ShuviX is closed, or while the old or new name is still used by another
  file, is not migrated.
- **Deleting** the file leaves its sessions untouched (they are the user's); their header chip
  shows the bot as gone and they simply run on the base without the persona.
- Same-name copies follow the rule in the `shuvix-files` entry — the losing copies are shown
  under the winner, struck through.
