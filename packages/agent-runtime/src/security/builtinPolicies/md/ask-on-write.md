---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: Ask Before Writing a File
description: Every file write or edit asks you first, wherever the file is.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [write]
    prompt: Writing replaces what is on disk. Check the target path and the diff before allowing.
---

**What it does**: whenever the agent wants to write or edit a file — inside or
outside your working directory — it asks you first.

**What it does not do**:

- It gates the file tools only; if you allow it, the agent can write files by
  running commands too.
- Once you turn the auto-allow switch on, another builtin policy —
  session-auto-allow — takes over and skips the ask.

**To adjust**: create an override copy and edit it.
