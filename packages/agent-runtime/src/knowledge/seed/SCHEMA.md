---
shuvix: okf v0.2
type: Schema
title: Knowledge base schema
description: How this knowledge base is organized and how entries are written — read before adding or changing anything.
status: stable
tags: [schema]
---

This directory is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) v0.2 bundle maintained by ShuviX. Every `.md` file except `index.md` and `log.md` is one **entry**: YAML frontmatter is the metadata, the body is the knowledge. The host regenerates every `index.md` and appends to `log.md` after each change, commits every change to git, and stamps `generated`; humans verify entries in the app. Agents write entries and nothing else.

## Layout — directories are scopes

| Directory                                | Who reads it                                          | What goes there                                                                  |
| ---------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `global/`                                | every session                                         | facts about the user, the machine, standing preferences                          |
| `projects/<slug>/`                       | sessions of that project                              | project memory; `project.md` binds the directory to the project                  |
| `projects/<slug>/sessions/`, `sessions/` | later sessions of the same project (or of no project) | one rolling summary per session                                                  |
| `bots/<name>/`                           | that bot's pipeline                                   | what the bot has learned; `bot.md` binds the directory                           |
| `wiki/<topic>/`                          | anyone who asks                                       | curated knowledge compiled from sources                                          |
| `raw/<id>/`                              | curation                                              | immutable sources: `source.md` holds the extracted text, originals sit beside it |

A scope answers "who gets this"; `type` answers "what it is".

## Entry types

`Memory` (observation, preference, lesson), `Session Summary`, `Project`, `Bot`, `Concept`, `Entity`, `Decision`, `Guide`, `Source`, `Schema`. Other values are allowed; readers tolerate unknown types.

## Frontmatter

```yaml
---
shuvix: okf v0.2 # this file is an OKF knowledge base entry, conforming to OKF v0.2
type: Memory # required — the only required field
title: Token refresh pitfalls
description: Read before touching src/auth/ — two refresh-token traps # ONE line: when to open this
tags: [auth, pitfall]
status: draft # draft | stable | deprecated; the default is stable, so drafts are explicit
stale_after: 2026-12-31 # optional: needs re-verification after this date
sources:
  - id: s1
    resource: shuvix://session/0192… # absolute path, full URL, repo@commit:path, or a ShuviX URI
    title: 2026-09-09 session "fix login"
generated: { by: shuvix-work/gpt-5, at: 2026-09-09T08:12:03Z } # stamped by the host
verified: { by: human:alice, at: 2026-09-10T02:00:00Z } # stamped by the app when a human verifies
---
```

- `shuvix` is ShuviX's own self-description, not part of OKF — an entry without it still parses, and an entry with it is still a valid OKF concept for any other reader. Write it on entries you create; leave whatever an outside tool wrote alone.
- `description` is what indexes show and how later sessions decide whether to read the entry: write it as the condition for opening it, not as a summary.
- Only the host writes `generated`; only the app writes `verified`. Never claim either.
- New entries start as `draft`. Agents may set `deprecated` (name the successor) or `draft`; only a human sets `stable`.
- Links between entries are standard markdown links with bundle-absolute paths: `[title](/wiki/auth/token-refresh.md)`. Cite sources per claim with footnotes keyed to `sources[].id`.

## Writing rules

- One entry, one idea. If it needs a second heading it is two entries — split and link.
- Record what took effort to establish: decisions and why, pitfalls, preferences, facts that are not in the code. Do not record what the repository already states, git history, or what only matters to one conversation.
- Search before writing; update an existing entry instead of adding a near-duplicate.
- Slow-changing knowledge belongs in the body; fast-changing details (line numbers, parameters) belong in `sources` as pointers, never as copies.
- The file name is the stable id. Rename by changing `title`, never by moving the file.
