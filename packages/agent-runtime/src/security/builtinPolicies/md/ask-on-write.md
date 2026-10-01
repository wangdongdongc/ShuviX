---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: Ask Before Writing a File
description: File writes and edits ask you first — except this conversation's own artifacts, the working directory, and, while the sandbox is on, the other places a confined command may change anyway.
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
      && !(inDir(object.path, vars.workspaceWritable)
      && !inDir(object.path, vars.workspaceWriteDenied)
      && !vars.workspaceProtectedPatterns.exists(p, object.path.matches(p)))
    prompt: Writing replaces what is on disk. Check the target path and the diff before allowing.
---

**What it does**: whenever the agent wants to write or edit a file, it asks
you first — with three exceptions. With the automatic review on, the reviewer
answers first and most of what is left never reaches you.

- **This conversation's own artifacts** (`~/.shuvix/artifacts/<session>/`):
  the figures and blocks the agent adopted to revise them. They are files the
  conversation owns, outside your projects, and asking before every tweak of
  a chart the agent drew a minute ago would only teach you to click allow.
- **While the sandbox is on**, the places a confined command may change
  anyway: the working directory, temporary folders and tool caches. A
  sandboxed `bash` can already write there without asking, so asking the
  file tools for the same file would only push the agent toward
  `echo > file`. The one protected spot inside them still asks, exactly as
  the sandbox still refuses it to commands: git's own metadata —
  `.git/hooks`, `.git/config` and the rest that git runs by itself.

- **The working directory, sandbox or not** (`vars.workspaceWritable`):
  editing files in the project is most of the work, and the file tools know
  the exact path, so this holds even where commands run unconfined. The same
  protected spot still asks. It is withheld where the sandbox would refuse
  the working directory too — `/`, a folder that covers your home folder, a
  credential folder, ShuviX's own configuration or data — and on Windows,
  where the protected-spot patterns cannot be matched reliably.

The host fills `vars.sandboxWritableRoots` only for a session whose commands
really run confined; the working-directory exemption does not depend on it.

**What it does not do**:

- It gates the file tools only; commands are governed by ask-on-command and
  the sandbox.

**To adjust**: create an override copy and edit it. Keeping only the first
line of the `match` restores "every write asks, sandbox or not"; dropping the
last clause (the `vars.workspace*` lines) restores "the working directory asks
when the sandbox is off".
