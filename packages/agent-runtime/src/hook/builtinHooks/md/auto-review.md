---
shuvix: hook v1
shuvix-id: hook:builtin:auto-review
shuvix-builtin: true
name: auto-review
shuvix-displayName: Automatic Review of Approval Requests
description: Before an approval card is shown, the permission reviewer answers it on your behalf — it lets ordinary work through, refuses what is clearly harmful and leaves the rest to you.
shuvix-hook-agent: permission-reviewer
shuvix-hook-on:
  - trigger: permission.request
---

Review the operation in the event below and answer with `next`: allow ordinary work the user asked for, ask the user about the rest, deny only what is clearly harmful.
