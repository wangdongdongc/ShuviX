---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-database
shuvix-displayName: Ask Before Running SQL
description: Every SQL statement on a database connection that has write access asks you per statement.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [database]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: '!object.readonly'
    prompt: This connection has write access, so the statement can change or delete data on the server.
---

**What it does**: when the agent runs SQL through a database connection that
has write access, it asks you statement by statement.

**What it does not do**:

- Read-only connections are not gated: the database itself refuses writes.
- It does not tell reads from writes: this policy does not analyze the SQL.
- Once you turn the auto-allow switch on, another builtin policy —
  session-auto-allow — takes over and skips the ask.

**To adjust**: create an override copy and edit it.
