---
shuvix: hook v1
shuvix-builtin: true
name: auto-review
shuvix-displayName: 承認リクエストの自動審査
description: 承認カードが表示される前に、権限レビュアーがあなたの代わりに答えます —— 普段の作業は通し、明らかに有害なものは拒否し、残りはあなたに委ねます。
shuvix-hook-agent: permission-reviewer
shuvix-hook-on:
  - trigger: permission.request
---

Review the operation in the event below and answer with `next`: allow ordinary work the user asked for, ask the user about the rest, deny only what is clearly harmful.
