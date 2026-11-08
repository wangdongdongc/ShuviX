---
shuvix: hook v1
shuvix-id: hook:builtin:goal-check
shuvix-builtin: true
name: goal-check
shuvix-displayName: 目标检查
description: 设了目标的会话每跑完一轮，由目标检查员判断目标达成没有；没达成，会话就接着做。
shuvix-hook-agent: goal-judge
shuvix-hook-on:
  - trigger: goal.check
---

Judge the goal in the event below against the evidence and answer with `next`.
