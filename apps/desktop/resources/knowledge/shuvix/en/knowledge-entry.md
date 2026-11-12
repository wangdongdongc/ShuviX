---
shuvix: okf v0.2
type: Guide
title: 'Knowledge base entry (shuvix: okf v0.2)'
description: 'The complete specification of a note in a ShuviX knowledge base — what a base is, "read wide, write strict", every frontmatter key of the OKF profile, links and `shuvix://` references, file naming, the `knowledge` tool''s actions, how the knowledge librarian records a submission, validation tiers, and the reserved names.'
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
    title: review.ts — what `submit` hands the knowledge librarian and the stamp its entries earn
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
| this project's      | `~/.shuvix/knowledge-shuvix/projects/<projectId>/` (written by the knowledge librarian, never by hand) | `project` (reserved)                          |
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
nobody chose, **only `shuvix` is enabled**: none of your own bases are on by default, and unticking
`shuvix` turns it off for that session. The other exception is a notebook
opened on one of ShuviX's own files (a policy, hook, agent, bot, skill or knowledge entry): it
always has `shuvix`, so its agent can look up that file's specification.
The selection is a hard boundary: `bases` lists only the enabled ones, and naming any other is
refused. The `<knowledge_bases>` fence in the system prompt lists the same names.

**Agents other than the knowledge librarian never see a base's directory.** To them a base is
its name and its entries are their paths inside the base (`/auth/session.md`): they `search`,
`list` and `read` entries through the `knowledge` tool and hand anything worth keeping to the
librarian with `submit` (see below). This is a convention of the tool and the prompts, not a
lock: nothing stops an agent that finds the directory some other way.

The selection also decides what the session may touch without asking. An enabled base is a
**read-write** row of the session's permission table (`vars.aclWrite` in the `policy-md` entry) —
the librarian runs inside the submitting session and writes with the file tools, so reading,
creating, moving and deleting files in it never asks; every change is committed to the base's
own git and can be rolled back. `shuvix`, when enabled, is a **read-only** row (`vars.aclRead`
only). A base that is not enabled is like any other folder in your home: reading it asks.

## Read wide, write strict

- **Every** non-hidden `.md` in a base is a **note**: it is listed in the sidebar, searched, and
  readable — title = frontmatter `title` → first `# heading` → file name. No metadata is required,
  and ShuviX never rewrites a user's note to add any.
- A note is additionally an **OKF entry (concept)** when its frontmatter parses as a mapping, has
  a non-empty string `type`, and carries no *foreign* `shuvix:` marker (a `shuvix: agent v1` file
  in a base is a note, not a concept). Only an entry the knowledge librarian reported after a
  `submit` — and that then passed the strict checks — carries ShuviX's machine confirmation.
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
| `generated`     | `{ by, at }`                                           | no       | **Host stamp** — who wrote the content (`shuvix-<agent>/<model>`) and when (ISO 8601). Refreshed by the write hook on every agent edit of an entry; on an entry the librarian reports after a `submit`, set to the agent that submitted it. Never set it by hand; the sidebar's "new entry" leaves it out on purpose. |
| `verified`      | `{ by, at }` or a list of them                         | no       | **The review axis**: who checked the entry. A person's check (`by: human:…`) is written only by a UI action; each entry the librarian reports after a `submit` gets its machine confirmation (`by: shuvix-knowledge-writer/<model>`, replacing an earlier one). **Agents never write it.** From it come the trust tier — machine-confirmed or human-reviewed, counting only checks no older than `generated.at` — and the "edited after it was checked" badge (every check older than `generated.at`). |

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

The librarian names an entry's file after its subject and may rename or move it later, fixing the
links that pointed at the old name. In a base, `write` refuses to overwrite an existing file the
agent has not read, so a taken name cannot silently replace someone else's entry. The sidebar's **new entry** derives the
name from the title: letters and digits of any script are kept, runs of anything else become `-`,
ASCII is lower-cased, the result is cut to 60 characters, and a taken name gets `-2`, `-3`, …
(the reserved names count as taken).

## How entries are written and changed

- **Submit it** (`knowledge`, `action: submit` with `base` and `content`): plain markdown saying
  what holds and where each claim comes from (a path, URL or commit); add `entry` when it
  corrects or extends that one. ShuviX runs the builtin knowledge librarian (the
  `knowledge-writer` agent) on it right away, inside the submitting conversation. The librarian
  is the only agent that writes a base: it reads what the base already holds and decides how to
  record the submission — a new entry, a change to existing ones (extending, correcting, splitting,
  merging, renaming, moving, marking `deprecated` or deleting), or nothing — and answers with the
  entries it touched and a short report. It writes with the file tools (`read`, `write`, `edit`,
  `move`, `delete`, `grep`) inside the base's directory, gives every entry it writes the
  frontmatter above, leaves the user's own notes (files without frontmatter) as they are, and
  never opens anything outside the base to check a submission's facts. ShuviX then stamps each
  entry it reported that passes the strict checks: `generated` (the submitter) and `verified` (the
  librarian's machine confirmation). The librarian runs only this way — the `agent` tool cannot
  dispatch it — and its model follows the usual rule (its md's `shuvix-model`, else the caller's).
  Override `~/.shuvix/agents/knowledge-writer.md` to change how it organizes bases.
- **Migrate it from another project** (`knowledge`, `action: migrate` with `project`, `entries`
  and `base`): when a project is split, an agent of a session in the new project brings entries
  over from the other project's own base. ShuviX reads the named entries and hands them to the
  librarian of the receiving base as they are — the agent does not copy their text. The librarian
  takes each one in as it is, merges it into the entry that already covers its subject, or turns
  it down, and reports which ones it took; ShuviX stamps what it wrote the same way as after a
  submission and removes exactly the entries it took from the other project's base. To choose,
  the agent first looks into that base with `list`, `search` or `read` plus `project` (the other
  project's name). That base is outside the session's permission table, so reading it and
  changing it each ask first. See the `moving-sessions` entry for splitting a project.
- **By hand** (Obsidian, the ShuviX notebook, any editor): no metadata needed; a human edit
  under the base is picked up on the next scan and committed with the next observed write. The
  sidebar's **new entry** writes the full metadata itself (with `type: Memory`,
  `status: draft`) minus `generated`, under the actor `human`.

**Finding an entry is two steps.** `search` indexes each entry's *face* only — title, description,
tags, type and the **headings** inside it, never the prose — so a result list says which entries
are plausibly about the subject, not what they say: read the titles and descriptions, pick the
ones that fit, and `read` those entries. (Whole bodies used to be indexed; one ordinary word then
pulled back half the base with a paragraph of context per hit, burying the entry actually wanted.)

The `knowledge` tool's actions: `bases` (what this session may name), `search` (free text;
without `base` it covers every enabled base, grouped per base — separate BM25 indexes, scores not
comparable across bases; Chinese and Japanese text is word-segmented before indexing), `list`
(every note of one base), `read` (one entry by its path inside the base, `offset` / `limit` for
long ones), `submit` (above). Results name entries by their path inside the base; only the
librarian's calls also show the base's directory. The reference base `shuvix` is read-only:
`submit` is refused there; an app update restores the shipped files anyway.

## Validation tiers

- an entry that carries the self-description line, or any note with a `type`: the strict OKF
  checks — **error** on missing frontmatter or `type`; **warning** on missing `title` /
  `description`, an invalid `status`, a non-date `stale_after`, malformed `generated` /
  `verified` / `sources`, or an unresolvable in-base link;
- any other note: only a warning when its YAML frontmatter is broken;
- generated `index.md` / `log.md`: never checked.

The write hook's validation is a receipt, not a gate: a broken entry is still written and still
listed. The stamp after a `submit` is the gate — ShuviX never stamps an entry that still fails the
strict checks.

## What to record

What will be looked up again: a decision and why it went that way, a pitfall that cost time, a
convention the code does not state, a fact that took effort to establish — in the base the
subject belongs to, handed over with `submit`. Search first and name the entry that already covers
the subject when the submission extends it; do not submit what the repository already states or
what only matters to the current conversation.
