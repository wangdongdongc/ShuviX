# Tracked item file format

```markdown
---
shuvix: track v1
status: active
---

# Waiting on Li's reply about the database migration

(Once there is a conclusion, put it here in a sentence or two.)

## Progress

- 10-24: in [Migration review](shuvix://session/<session id>) the user said "let's wait for Li's reply before deciding".
```

- The frontmatter has two lines, `shuvix: track v1` and `status`; a new item gets `status: active`. `status` has three values only: `active` / `waiting` / `archived`; when to change it is in SKILL.md under "Status". When changing it, change only that line and leave the rest of the frontmatter alone.
- The body's first line is `# Title`, which is what the Inbox shows; under it the Inbox shows the last progress line.
- Name the file with a short lowercase slug, e.g. `waiting-li-migration.md`.
- Append progress by date under `## Progress`, each line with a link to its session `[session title](shuvix://session/<session id>)`; for an item you created directly, the first line quotes the user's words.
- Once there is a conclusion, write it as the first paragraph under the title; keep the progress. For an archived item this paragraph is what the Inbox shows.
