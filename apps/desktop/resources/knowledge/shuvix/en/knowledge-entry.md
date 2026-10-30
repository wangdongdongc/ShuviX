---
shuvix: okf v0.2
type: Guide
title: 'Knowledge base entry (shuvix: okf v0.2)'
description: 'The complete specification of a note in a ShuviX knowledge base — what a base is, "read wide, write strict", every frontmatter key of the OKF profile, links and `shuvix://` references, file naming, the `knowledge` tool''s actions, validation tiers, the `submit` check, and the reserved names.'
tags: [shuvix, knowledge, okf, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/conceptFile.ts
    title: conceptFile.ts — the entry model and builder (source of truth)
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/validate.ts
    title: validate.ts — the validation tiers
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/knowledgeTool.ts
    title: knowledgeTool.ts — the `knowledge` tool
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/review.ts
    title: review.ts — what `submit` hands the knowledge writer and the stamp a pass earns
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

**A session in a project always has that project's base**, `project`, listed first — it is
where what was learned about the project goes, so it is not something to tick (it is not offered
in the cards). **The other bases are the user's selection** (the Knowledge bases row under
session config → Extensions, or the tool picker by the input box; project config sets the default
for new sessions). Unset, a session follows its parent session, then its project's default; when
nobody chose, **no other base is enabled** — `shuvix` included. The one exception is a notebook
opened on one of ShuviX's own files (a policy, hook, agent, bot, skill or knowledge entry): it
always has `shuvix`, so its agent can look up that file's specification.
The selection is a hard boundary: `bases` lists only the enabled ones, and naming any other is
refused. The `<knowledge_bases>` fence in the system prompt lists the same names.

The selection also decides what the agent may touch without asking. An enabled base is a
**read-write** row of the session's permission table (`vars.aclWrite` in the `policy-md` entry):
reading, creating and editing files in it never asks — in the file tools or in a sandboxed
command — because every change is committed to the base's own git and can be rolled back.
`shuvix`, when enabled, is a **read-only** row (`vars.aclRead` only): reading is free, writing
asks. A base that is not enabled is like any other folder in your home: reading it asks.

## Read wide, write strict

- **Every** non-hidden `.md` in a base is a **note**: it is listed in the sidebar, searched, and
  readable — title = frontmatter `title` → first `# heading` → file name. No metadata is required,
  and ShuviX never rewrites a user's note to add any.
- A note is additionally an **OKF entry (concept)** when its frontmatter parses as a mapping, has
  a non-empty string `type`, and carries no *foreign* `shuvix:` marker (a `shuvix: agent v1` file
  in a base is a note, not a concept). Only an entry that passed the `knowledge` tool's `submit`
  has been **checked** to conform.
- `index.md` and `log.md` are OKF's reserved names. ShuviX no longer generates them; ones it
  generated earlier stay hidden by their shape, while a hand-written file with either name is an
  ordinary note (never a concept).

## Frontmatter keys (the ShuviX profile)

In their usual order:

| Key             | Type                                                   | Required | Meaning                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`        | `okf v0.2`                                             | no       | Self-description: "this is an OKF entry, written to OKF v0.2". Selects the property card in the notebook; a note without it still parses. Any other `shuvix:` type means "not a concept".                                            |
| `type`          | string                                                 | **yes** (for a concept) | What kind of thing this is. ShuviX's open vocabulary: `Memory`, `Concept`, `Entity`, `Decision`, `Guide`, `Source` — other values are allowed and shown as-is.                                                            |
| `title`         | string                                                 | no       | Display title. Default: the file name without `.md`.                                                                                                                                                                                    |
| `description`   | string                                                 | no       | **One line saying when the entry is worth opening** — it is what `list` and `search` show and how later sessions decide to read it.                                                                                                     |
| `resource`      | string                                                 | no       | An external locator the entry stands for (rare).                                                                                                                                                                                        |
| `tags`          | list of strings (a comma-separated string also reads)  | no       | Free tags.                                                                                                                                                                                                                              |
| `status`        | `draft` \| `stable` \| `deprecated`                    | no       | **Lifecycle**, default `stable`: `draft` = still incomplete, `stable` = ready to be relied on, `deprecated` = kept for links and history (dropped from search). Written out explicitly when an entry is submitted. It is **not** a review flag. |
| `stale_after`   | `YYYY-MM-DD`                                           | no       | Date after which the entry needs re-verification (the sidebar badges it).                                                                                                                                                              |
| `sources`       | list of `{ id?, resource, title?, author?, last_modified? }` (or bare locator strings) | no | Where the claims come from. `resource` is a self-contained locator: an absolute path (optionally `#symbol`), a full URL, `<remote-url>@<commit>:<path>`, or `shuvix://session/<id>`. `id` enables footnote citations `[^id]`. |
| `generated`     | `{ by, at }`                                           | no       | **Host stamp** — who wrote the content (`shuvix-<agent>/<model>`) and when (ISO 8601). Refreshed by the write hook on every agent edit of an entry; when an entry passes `submit`, set to the agent that submitted it. Never set it by hand; the sidebar's "new entry" leaves it out on purpose. |
| `verified`      | `{ by, at }` or a list of them                         | no       | **The review axis**: who checked the entry. A person's check (`by: human:…`) is written only by a UI action; a pass of `submit` adds the knowledge writer's machine confirmation (`by: shuvix-knowledge-writer/<model>`, replacing an earlier one). **Agents never write it.** From it come the trust tier — machine-confirmed or human-reviewed, counting only checks no older than `generated.at` — and the "edited after it was checked" badge (every check older than `generated.at`). |

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

Whoever writes an entry names its file, and the name is the entry's permanent id — name it after
the subject. In a base, `write` refuses to overwrite an existing file the agent has not read, so a
taken name cannot silently replace someone else's entry. The sidebar's **new entry** derives the
name from the title: letters and digits of any script are kept, runs of anything else become `-`,
ASCII is lower-cased, the result is cut to 60 characters, and a taken name gets `-2`, `-3`, …
(the reserved names count as taken).

## How entries are written and changed

- **Write it with `write`** into the base's directory as plain markdown — one subject per file,
  no frontmatter needed, saying in the body where each claim comes from — and then **submit** it
  (`knowledge`, `action: submit` with `base` and `path`). ShuviX runs the builtin
  `knowledge-writer` agent on it right away: it completes the frontmatter (self-description,
  `type`, `title`, `description`, `tags`, `status`, `sources`) and judges whether the entry is
  about one subject, reads cold, and sources every claim. On a pass ShuviX stamps `generated`
  (the submitter) and `verified` (the writer's machine confirmation); on a fail the report says
  what to fix and the entry stays unconfirmed. The writer runs only this way — the `agent` tool
  cannot dispatch it — and its model follows the usual rule (its md's `shuvix-model`, else the
  caller's).
- **Change with `edit`** at the absolute path that `search` / `list` gave you — a surgical diff
  beats re-sending the body. After an edit the write hook validates the file (diagnostics come
  back in the tool result), refreshes `generated`, commits, and the sidebar updates; the machine
  confirmation no longer covers the changed content until the entry is submitted again.
- **By hand** (Obsidian, the ShuviX notebook, any editor): no metadata needed; a human edit
  under the base is picked up on the next scan and committed with the next observed write. The
  sidebar's **new entry** writes the full metadata itself (with `type: Memory`,
  `status: draft`) minus `generated`, under the actor `human`.

**Finding an entry is two steps.** `search` indexes each entry's *face* only — title, description,
tags, type and the **headings** inside it, never the prose — so a result list says which entries
are plausibly about the subject, not what they say: read the titles and descriptions, pick the
ones that fit, and `read` those files. (Whole bodies used to be indexed; one ordinary word then pulled
back half the base with a paragraph of context per hit, burying the entry actually wanted.) For a
literal string inside bodies — an error message, a symbol, a URL — use `grep` over the base's
directory, which every listing prints.

The `knowledge` tool's actions: `bases` (what this session may name, with each base's
directory), `search` (free text; without `base` it covers every enabled base, grouped per base —
separate BM25 indexes, scores not comparable across bases; Chinese and Japanese text is
word-segmented before indexing), `list` (every note of one base), `submit` (above). Listings
give absolute paths. The reference base `shuvix` is read-only: `submit` is refused there, and a
file write into it is not blocked but asks (ask-on-external-path — it is a read-only row of the
session's permission table); an app update restores the shipped files anyway.

## Validation tiers

- an entry that carries the self-description line, or any note with a `type`: the strict OKF
  checks — **error** on missing frontmatter or `type`; **warning** on missing `title` /
  `description`, an invalid `status`, a non-date `stale_after`, malformed `generated` /
  `verified` / `sources`, or an unresolvable in-base link;
- any other note: only a warning when its YAML frontmatter is broken;
- generated `index.md` / `log.md`: never checked.

The write hook's validation is a receipt, not a gate: a broken entry is still written and still
listed. `submit` is the gate — it never stamps an entry that still fails the strict checks.

## What to record

What will be looked up again: a decision and why it went that way, a pitfall that cost time, a
convention the code does not state, a fact that took effort to establish — in the base the
subject belongs to, and submit it. Search first and extend the entry that already covers the
subject rather than adding a near-duplicate; do not record what the repository already states or what only matters to
the current conversation.
