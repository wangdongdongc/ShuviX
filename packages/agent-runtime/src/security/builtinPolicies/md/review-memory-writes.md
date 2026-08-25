---
shuvix: policy v1
shuvix-builtin: true
name: review-memory-writes
shuvix-displayName: Always Review Memory Writes
description: Writing a project memory always asks you first, even while auto-allow is on.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, vars.memoryDirs)
    prompt: A memory is written once and then read back in every later session. Check that this one is worth keeping before allowing.
---

**What it does**: whenever the agent wants to create or change a project
memory, it asks you first. Unlike the other ask gates, this one still asks
while the session's auto-allow switch is on.

**What it does not do**:

- It gates the file tools only; if you allow it, the agent can still write a
  memory by running a command.
- It does not judge whether a memory is any good — that is what your review is
  for.
- It does not gate reading memories. Recall stays free.

**To adjust**: create an override copy. Change the effect to `ask` to make
memory writes behave like any other write (skipped while auto-allow is on), or
remove the rule to stop asking.
