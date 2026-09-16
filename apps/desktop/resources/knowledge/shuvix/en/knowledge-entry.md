---
shuvix: okf v0.2
type: Guide
title: 'Knowledge base entry (shuvix: okf v0.2)'
description: 'The complete specification of a note in a ShuviX knowledge base — what a base is, "read wide, write strict", every frontmatter key of the OKF profile, links and `shuvix://` references, file naming, the `knowledge` tool''s actions, validation tiers, and the reserved names.'
tags: [shuvix, knowledge, okf, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/conceptFile.ts
    title: conceptFile.ts — the entry model and builder (source of truth)
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/validate.ts
    title: validate.ts — the validation tiers
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/knowledgeTool.ts
    title: knowledgeTool.ts — the `knowledge` tool
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/chat-protocol/src/knowledge.ts
    title: knowledge.ts — the type and status vocabularies
---

# Knowledge base entry

A **knowledge base** is a directory of markdown; an **entry** is one `.md` in it. ShuviX follows
the Open Knowledge Format (OKF) v0.2 with a small profile of its own: the frontmatter is
metadata, the body is the knowledge, and the only reserved names are `index.md` and `log.md`.

## Where bases live

| Base                | Directory                                         | Named in the `knowledge` tool as              |
| ------------------- | ------------------------------------------------- | --------------------------------------------- |
| the user's own      | `~/.shuvix/knowledge/<name>/` — **every non-hidden sub-directory is one base**; no marker file needed | the directory name                             |
| this project's      | `~/.shuvix/knowledge-shuvix/projects/<projectId>/` (written through the tool, never by hand) | `project` (reserved)                          |
| ShuviX's reference  | inside the application (read-only, per UI language) | `shuvix` (reserved)                           |

A base needs nothing but its directory: copy a folder of notes in and it is a base. Hidden files
and directories (`.obsidian/`, `.trash/`, `.git/`) are never part of a base. Each base keeps its
own git history: the first write ShuviX observes runs `git init` (if the folder has no
repository) with the folder as it was as the baseline, and every later observed change is
committed as `kb(<op>): /path` with `Knowledge-Op` / `Knowledge-Actor` trailers.

**Which bases a session works with is the user's selection** (session config → Knowledge bases;
project config sets the default for new sessions). Unset, the default is every user base + the
project's base (in a project) + `shuvix`. The selection is a hard boundary: `bases` lists only the
enabled ones, and naming any other is refused. The `<knowledge_bases>` fence in the system prompt
lists the same names.

## Read wide, write strict

- **Every** non-hidden `.md` in a base is a **note**: it is listed in the sidebar, searched, and
  readable — title = frontmatter `title` → first `# heading` → file name. No metadata is required,
  and ShuviX never rewrites a user's note to add any.
- A note is additionally an **OKF entry (concept)** when its frontmatter parses as a mapping, has
  a non-empty string `type`, and carries no *foreign* `shuvix:` marker (a `shuvix: agent v1` file
  in a base is a note, not a concept). Only what the `knowledge` tool's `create` writes is
  **guaranteed** to conform.
- `index.md` and `log.md` are OKF's reserved names. ShuviX no longer generates them; ones it
  generated earlier stay hidden by their shape, while a hand-written file with either name is an
  ordinary note (never a concept).

## Frontmatter keys (the ShuviX profile)

In the order `create` writes them:

| Key             | Type                                                   | Required | Meaning                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`        | `okf v0.2`                                             | no       | Self-description: "this is an OKF entry, written to OKF v0.2". Selects the property card in the notebook; a note without it still parses. Any other `shuvix:` type means "not a concept".                                            |
| `type`          | string                                                 | **yes** (for a concept) | What kind of thing this is. ShuviX's open vocabulary: `Memory`, `Concept`, `Entity`, `Decision`, `Guide`, `Source` — other values are allowed and shown as-is.                                                            |
| `title`         | string                                                 | no       | Display title. Default: the file name without `.md`.                                                                                                                                                                                    |
| `description`   | string                                                 | no       | **One line saying when the entry is worth opening** — it is what `list` and `search` show and how later sessions decide to read it.                                                                                                     |
| `resource`      | string                                                 | no       | An external locator the entry stands for (rare).                                                                                                                                                                                        |
| `tags`          | list of strings (a comma-separated string also reads)  | no       | Free tags.                                                                                                                                                                                                                              |
| `status`        | `draft` \| `stable` \| `deprecated`                    | no       | **Lifecycle**, default `stable`: `draft` = still incomplete, `stable` = ready to be relied on, `deprecated` = kept for links and history (dropped from search). Written out explicitly by `create`. It is **not** a review flag.        |
| `stale_after`   | `YYYY-MM-DD`                                           | no       | Date after which the entry needs re-verification (the sidebar badges it).                                                                                                                                                              |
| `sources`       | list of `{ id?, resource, title?, author?, last_modified? }` (or bare locator strings) | no | Where the claims come from. `resource` is a self-contained locator: an absolute path (optionally `#symbol`), a full URL, `<remote-url>@<commit>:<path>`, or `shuvix://session/<id>`. `id` enables footnote citations `[^id]`. |
| `generated`     | `{ by, at }`                                           | no       | **Host stamp** — who last wrote the file (`shuvix-<agent>/<model>`) and when (ISO 8601). Written by `create` and refreshed by the write hook on every agent edit. Never set it by hand; the sidebar's "new entry" leaves it out on purpose. |
| `verified`      | `{ by, at }` or a list of them                         | no       | **The review axis**: the user's record of having checked the entry. Only a UI action may write it — **agents never do**. From it comes the trust tier (unverified / machine-confirmed / human-reviewed) and the "edited after verification" badge (a `verified.at` older than `generated.at`). |

Unknown keys are kept as they are. Values of the wrong shape are reported as warnings and fall
back to defaults; only a missing frontmatter or a missing / empty `type` makes a file "not a
concept".

## The body

Markdown. Link other entries of the **same base** with bundle-absolute markdown links —
`[Agent definition file](/agent-md.md)` — the root being the base's directory; validation
warns on links that resolve nowhere inside the base. To point at something in **another** base,
or at a session, use a `shuvix://` URI instead of a path (link checks skip anything with a
scheme). Headings, code fences and footnotes are ordinary markdown; a `# Heading` at the top
doubles as the title of a note that has no frontmatter.

## File names

`create` derives the file name from the title: letters and digits of any script are kept, runs of
anything else become `-`, ASCII is lower-cased, the result is cut to 60 characters, and a taken
name gets `-2`, `-3`, … (the reserved names count as taken). Entries always land at the **root**
of the base; folders are for the user's own organisation and the sidebar's "new entry".

## How entries are written and changed

- **Create with the `knowledge` tool** (`action: create` with `base`, `type`, `title`,
  `description`, `body`, optional `tags` / `sources` / `stale_after` / `status`). The host
  assembles the frontmatter (self-description, key order, normalised `type` / `status`,
  `generated`), names the file, commits it, and answers with the absolute path. Never create an
  entry with `write` — the metadata would be yours to get right.
- **Change with `edit`** at the absolute path that `search` / `list` / `read` / `create` gave you
  — a surgical diff beats re-sending the body. After an edit the write hook validates the file
  (diagnostics come back in the tool result), refreshes `generated`, commits, and the sidebar
  updates. Run `validate` afterwards.
- **By hand** (Obsidian, the ShuviX notebook, any editor): no metadata needed; a human edit
  under the base is picked up on the next scan and committed with the next observed write. The
  sidebar's **new entry** writes the same metadata as `create` (with `type: Memory`,
  `status: draft`) minus `generated`, under the actor `human`.

The `knowledge` tool's other actions: `bases` (what this session may name), `search` (free text;
without `base` it covers every enabled base, grouped per base — separate BM25 indexes, scores
not comparable across bases; Chinese and Japanese text is word-segmented before indexing),
`list` (every note of one base), `read` (one entry by bundle-relative path, e.g. `/foo.md`),
`validate` (one note or a whole base). The reference base `shuvix` is read-only: `create` is
refused there and a policy denies file writes into it.

## Validation tiers

- an entry that carries the self-description line, or any note with a `type`: the strict OKF
  checks — **error** on missing frontmatter or `type`; **warning** on missing `title` /
  `description`, an invalid `status`, a non-date `stale_after`, malformed `generated` /
  `verified` / `sources`, or an unresolvable in-base link;
- any other note: only a warning when its YAML frontmatter is broken;
- generated `index.md` / `log.md`: never checked.

Validation is a receipt, not a gate: a broken entry is still written and still listed.

## What to record

What will be looked up again: a decision and why it went that way, a pitfall that cost time, a
convention the code does not state, a fact that took effort to establish — in the base the
subject belongs to. Search first and revise the entry that already covers the subject rather than
adding a near-duplicate; do not record what the repository already states or what only matters to
the current conversation.
