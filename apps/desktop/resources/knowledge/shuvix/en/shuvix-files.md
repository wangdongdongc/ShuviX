---
shuvix: okf v0.2
type: Guide
title: 'ShuviX customization files — where they live and the rules they share'
description: 'Start here when asked to create, fix or explain any ShuviX markdown (agent, bot, policy, hook, knowledge entry) or a skill — the directory map, the `shuvix:` marker, same-name shadowing, and how a file becomes live.'
tags: [shuvix, files, overview, format]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/chat-protocol/src/shuvixMdContract.ts
    title: shuvixMdContract.ts — the `shuvix:` marker
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/registryShadowing.ts
    title: registryShadowing.ts — same-name resolution
---

# ShuviX customization files

ShuviX is customised with **markdown files under `~/.shuvix/`**. There is no database row to
create, no "enable" switch and no restart: **a file that exists and parses is live the next time
it is used**. This entry is the map; every file type has its own entry in this knowledge base with
the full key-by-key specification.

## Directory map

| What it is                                                                   | Where it lives                                                                 | Marker line             | Entry             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------- | ----------------- |
| **Agent** — a persona + tool whitelist that an agent runs on                 | `~/.shuvix/agents/<name>.md`                                                   | `shuvix: agent v1`      | `agent-md`        |
| **Bot** — a persona + memory bound to a bot chat                             | `~/.shuvix/bots/<name>.md`                                                     | `shuvix: bot v2`        | `bot-md`          |
| **Security policy** — when a tool call is allowed, asked about or denied     | `~/.shuvix/policies/<name>.md`                                                 | `shuvix: policy v1`     | `policy-md`       |
| **Hook** — dispatch an agent when a session event fires                      | `~/.shuvix/hooks/<name>.md`                                                    | `shuvix: hook v1`       | `hook-md`         |
| **Knowledge base entry** — a note in one of the user's knowledge bases       | `~/.shuvix/knowledge/<base>/**/*.md`                                           | `shuvix: okf v0.2`      | `knowledge-entry` |
| **Skill** — a reusable instruction pack (Agent Skills format)                | `~/.shuvix/skills/<name>/SKILL.md`, `<project>/.claude/skills/<name>/SKILL.md` | none (`name:` required) | `skills`          |

Other things under `~/.shuvix/` are ShuviX's own and are not meant to be edited by hand:
`knowledge-shuvix/` (ShuviX-maintained knowledge bundles, one per project — written through the
`knowledge` tool), `skills/.config.json` (which skills are disabled and which extra skill
directories are registered), `widgets/`, `tts/`, `cli-token`. The old `memory/`, `wikis/` and
`workflows/` directories are retired formats that are no longer read.

**Builtins live inside the application, not on disk.** ShuviX ships builtin agents (`work`,
`chat`, `notebook`, `bot`, `coding`, `explore`, `widget`, `titler`, `knowledge-writer`), builtin security policies and one builtin hook
(`auto-title`). There are no builtin bots and no builtin skills. A builtin cannot be edited, but
it can be **overridden**: a user file whose `name` equals the builtin's name replaces it
completely (the Settings tabs offer "create override copy", which writes the builtin's current
text into your directory as a starting point).

## The `shuvix:` marker

Every ShuviX contract file starts with a YAML frontmatter whose **first key** is the file-type
marker:

```yaml
---
shuvix: agent v1
name: scout
---
```

The value is `<type> v<version>`. The type says what the file is (`agent`, `bot`, `policy`,
`hook`, `okf` for a knowledge entry); the version is the format's own revision (`v1`, `v2`) or,
for knowledge entries, the OKF specification version (`v0.2`). Parsers discriminate on the
**type only** and tolerate a missing or newer version.

How strictly the marker is required differs per type — the exact rule is in each entry:

- **agent, policy, knowledge entry**: optional on read (a hand-written file without it still
  loads); ShuviX writes it whenever it writes such a file.
- **bot**: optional, but a **wrong type is rejected** — an agent file dropped into `bots/` is
  refused rather than read as a persona.
- **hook**: **required** — a file without it is not a hook.

Related rules shared by all types:

- The frontmatter must be the **first thing in the file** (a BOM and leading blank lines are
  tolerated), fenced by `---` lines. The content is real YAML, parsed with a full YAML parser —
  quotes, multi-line strings and comments all work. A `---` block later in the body is body text.
- `name` defaults to the **file's base name** (`scout.md` → `scout`) and can be overridden in the
  frontmatter. `shuvix-displayName` is the human-facing label where the UI shows one.
- ShuviX's own keys are prefixed `shuvix-` (for example `shuvix-tools`, `shuvix-policy-rules`,
  `shuvix-hook-on`). The prefix is deliberate: the same markdown opened by another application
  must not misread a generic key such as `tools`. Unknown keys without the prefix are ignored;
  what happens to unknown `shuvix-` keys is type-specific (hooks reject them).
- `shuvix-builtin: true` appears in files ShuviX ships. Parsers do not read it; it only states
  "this text came from the builtin set". Do not add it to user files — it does nothing.

## Invalid files are rejected whole

The agent, bot, policy and hook parsers share one philosophy: a structurally invalid file (no
frontmatter, YAML error, frontmatter that is not a mapping, a key of the wrong type, a rule that
can never match, …) is **rejected as a whole, never half-applied**. A rejected user file:

- is skipped by the runtime — it never shadows a builtin of the same name;
- is listed in the corresponding Settings tab under "cannot be parsed" with the parser's reason
  (the Bots group in the sidebar shows an invalid bot file the same way);
- shows the same verdict live in its notebook's property card while you edit it.

A knowledge entry is the exception by design ("read wide, write strict"): a note that is not a
valid OKF concept is still a note — see `knowledge-entry`.

## Same-name shadowing

When several files carry the same `name`, exactly one is in effect and the others are listed as
**Overridden** (never silently skipped):

1. a user file beats a builtin;
2. among user files, the one whose **file name is the name** wins (`scout.md` beats
   `scout copy.md`; file names are compared after the same sanitisation that new files get —
   `\ / : * ? " < > |` become `-`, leading dots are dropped — case-insensitively);
3. then the shorter file name;
4. then code-point order of the file name (never directory listing order).

The runtime's active set and the Settings list are two views of this one resolution, so a row
shown as active is the copy actually in use.

## Editing and verifying

Opening one of these files in ShuviX opens it as a **notebook session**: a live-preview markdown
editor with a property card for the frontmatter (dropdowns and pickers for known keys, the
parser's verdict as a badge) and autosave. There is no separate editor and no Save button; the
file on disk is the source of truth, and a change made with any editor is picked up on the next
use.

When you create or change one of these files on the user's behalf:

- Write the whole file with the `write` tool (or `edit` an existing one) at the exact path in
  the table above; the directory may not exist yet — create it. Use the current text of a
  builtin (Settings → "create override copy", or the builtin's `md` as quoted in these entries) as
  the model for an override.
- The result of a `write` / `edit` on a file that carries a `shuvix:` marker comes back with
  the parser's verdict appended (the file is still written — the verdict is a receipt, not a
  gate). Read it and fix the file rather than reporting success.
- Point the user at where the file shows up: Settings → Agents / Policies / Hooks, the Bots
  group, the Knowledge base group, or the Skills tab.
