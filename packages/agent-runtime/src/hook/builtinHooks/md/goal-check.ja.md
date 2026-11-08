---
shuvix: hook v1
shuvix-id: hook:builtin:goal-check
shuvix-builtin: true
name: goal-check
shuvix-displayName: 目標チェック
description: 目標を設定したセッションが一回りするたびに、目標チェッカーが達成したかどうかを判断します。未達成なら、セッションは作業を続けます。
shuvix-hook-agent: goal-judge
shuvix-hook-on:
  - trigger: goal.check
---

Judge the goal in the event below against the evidence and answer with `next`.
