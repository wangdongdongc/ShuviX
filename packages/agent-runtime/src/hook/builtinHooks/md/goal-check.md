---
shuvix: hook v1
shuvix-id: hook:builtin:goal-check
shuvix-builtin: true
name: goal-check
shuvix-displayName: Goal Check
description: After each run of a session with a goal, the goal checker decides whether the goal is met; if not, the session keeps working toward it.
shuvix-hook-agent: goal-judge
shuvix-hook-on:
  - trigger: goal.check
---

Judge the goal in the event below against the evidence and answer with `next`.
