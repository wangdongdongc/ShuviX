---
shuvix: hook v1
shuvix-builtin: true
name: auto-review
shuvix-displayName: 自动审查审批请求
description: 审批卡片弹出之前，由权限审查员替你作答 —— 日常工作直接放行，明显有害的拒绝，其余的交给你。
shuvix-hook-agent: permission-reviewer
shuvix-hook-on:
  - trigger: permission.request
---

Review the operation in the event below and answer with `next`: allow ordinary work the user asked for, ask the user about the rest, deny only what is clearly harmful.
