---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-read
shuvix-displayName: Ask Before Reading a File
description: Reads outside the workspace and the app's read-only dirs ask first; reads inside are free.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      !inDir(object.path, vars.workspace)
      && !inDir(object.path, vars.toolResultsBase)
      && !inDir(object.path, vars.skillsDirs)
    prompt: Reading outside the working directory pulls that file into the model context, where later turns and tool calls can carry it further.
---

**What it does**: the agent reads freely inside your working directory (and the
app's read-only directories: tool results, skills). Reading anything outside
that range — other locations, files belonging to other projects — asks you
first.

**What it does not do**:

- It gates the file tools only: if you allow it, the agent can read files by
  running commands too.
- This policy does not analyze how sensitive a file is.
- Once you turn the auto-allow switch on, another builtin policy —
  session-auto-allow — takes over and skips the ask.

**To adjust**: create an override copy and edit it.
