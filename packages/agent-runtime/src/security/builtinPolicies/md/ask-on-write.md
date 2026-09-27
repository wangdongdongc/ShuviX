---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: Ask Before Writing a File
description: File writes and edits ask you first — except this conversation's own artifacts, and, while the sandbox is on, the places a confined command may change anyway.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [write]
    match: >-
      !inDir(object.path, vars.sessionArtifactsDir)
      && !(inDir(object.path, vars.sandboxWritableRoots)
      && !inDir(object.path, vars.sandboxWriteDenied)
      && !vars.sandboxProtectedPatterns.exists(p, object.path.matches(p)))
    prompt: Writing replaces what is on disk. Check the target path and the diff before allowing.
---

**What it does**: whenever the agent wants to write or edit a file, it asks
you first — with two exceptions.

- **This conversation's own artifacts** (`~/.shuvix/artifacts/<session>/`):
  the figures and blocks the agent adopted to revise them. They are files the
  conversation owns, outside your projects, and asking before every tweak of
  a chart the agent drew a minute ago would only teach you to click allow.
- **While the sandbox is on**, the places a confined command may change
  anyway: the working directory, temporary folders and tool caches. A
  sandboxed `bash` can already write there without asking, so asking the
  file tools for the same file would only push the agent toward
  `echo > file`. The protected spots inside them still ask, exactly as the
  sandbox still refuses them to commands: `.git/hooks`, `.git/config` and
  the other git metadata that git runs on its own, and a project's
  `.vscode`, `.idea`, `.claude`, `.cursor`, `.codex`, `.zed`, `.mcp.json`
  and `.envrc`.

The host fills `vars.sandboxWritableRoots` only for a session whose commands
really run confined; with the sandbox off, on a platform without one, or
for a working directory inside ShuviX's own data, the list is empty and
every write outside the artifacts asks, as before.

**What it does not do**:

- It gates the file tools only; commands are governed by ask-on-command and
  the sandbox.
- Once you turn the auto-allow switch on, another builtin policy —
  session-grants — takes over and skips the ask.

**To adjust**: create an override copy and edit it. Keeping only the first
line of the `match` restores "every write asks, sandbox or not".
