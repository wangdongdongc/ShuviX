---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-read
shuvix-displayName: Ask Before Reading a File
description: Reads outside the workspace and the app's read-only dirs ask first; while the sandbox is on, only the sensitive places a confined command cannot read ask.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      has(vars.sandboxActive) && vars.sandboxActive
      ? inDir(object.path, vars.sandboxReadDenied)
      && !inDir(object.path, vars.sandboxReadAllowed)
      : !inDir(object.path, vars.workspace)
      && !inDir(object.path, vars.toolResultsBase)
      && !inDir(object.path, vars.skillsDirs)
      && !inDir(object.path, vars.memoryDirs)
      && !inDir(object.path, vars.builtinKnowledgeDir)
      && !inDir(object.path, vars.sessionArtifactsDir)
    prompt: Reading this file pulls it into the model context, where later turns and tool calls can carry it further.
---

**What it does** depends on whether this session's commands run in the
sandbox.

- **Sandbox on**: a confined command can read almost anything, so the file
  tools do too — asking `read` for a file `cat` gets for free would only
  push the agent toward `cat`. What still asks is the one list the sandbox
  refuses to commands: ShuviX's own data (other conversations, the database,
  the credential key), your personal folders (Documents, Desktop, Downloads,
  Pictures, Movies, Music, iCloud Drive, Mail, Messages, Safari, other apps'
  containers) and the credential directories. The working directory and this
  session's own tool results stay free even when they sit inside one of
  those folders.
- **Sandbox off** (or not available here): the agent reads freely inside
  your working directory and the app's read-only directories — tool results,
  skills, project memories, ShuviX's own built-in knowledge base (reading
  that reference is what it is shipped for) and this conversation's own
  artifacts. Anything outside that range asks first.

**What it does not do**:

- It gates the file tools only; commands are governed by ask-on-command and
  the sandbox.
- This policy does not analyze how sensitive a file is beyond those lists.
- Once you turn the auto-allow switch on, another builtin policy —
  session-grants — takes over and skips the ask.

**To adjust**: create an override copy and edit it. Replacing the `match`
with its part after `:` restores "outside the workspace asks", sandbox or
not.
