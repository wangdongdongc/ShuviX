---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: Ask Before Writing a File
description: Every file write or edit asks you first, wherever the file is — except this conversation's own artifacts.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [write]
    match: '!inDir(object.path, vars.sessionArtifactsDir)'
    prompt: Writing replaces what is on disk. Check the target path and the diff before allowing.
---

**What it does**: whenever the agent wants to write or edit a file — inside or
outside your working directory — it asks you first.

The one place it does not ask is this conversation's own artifacts
(`~/.shuvix/artifacts/<session>/`): the figures and blocks the agent adopted
to revise them. They are files the conversation owns, outside your projects,
and asking before every tweak of a chart the agent drew a minute ago would
only teach you to click allow.

**What it does not do**:

- It gates the file tools only; if you allow it, the agent can write files by
  running commands too.
- Once you turn the auto-allow switch on, another builtin policy —
  session-grants — takes over and skips the ask.

**To adjust**: create an override copy and edit it.
