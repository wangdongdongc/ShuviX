---
shuvix: policy v1
shuvix-builtin: true
name: git-safety
shuvix-displayName: Ask Before Important Git Operations
description: Important operations of the builtin git tool (init / restore / checkout --force / branch -d) ask you before they run.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [gitTool]
shuvix-policy-rules:
  - effect: ask
    match: >-
      object.gitAction in ['init', 'restore']
      || (object.gitAction == 'checkout' && object.force)
      || (object.gitAction == 'branch' && object.delete)
    prompt: These git operations discard uncommitted work or delete a branch (init, restore, checkout --force, branch -d). There is no undo inside the app.
---

**What it does**: this covers the **builtin git tool only**. Its routine
operations (add, commit, diff, …) run freely inside the workspace, but the
important ones ask first — creating a repo (`init`), discarding changes
(`restore`, `checkout --force`), deleting a branch (`branch -d`).

**What it does not do**:

- A `git` command run through the command tools is **not** covered by this
  policy — if you allow it, the agent can perform any git operation by running
  commands.
- Only the listed operations are gated; the git tool's other operations run
  without prompts inside the workspace.
- Git-tool operations targeting a directory outside the workspace go through
  the normal path ask as well.
- Once you turn the auto-allow switch on, another builtin policy —
  session-auto-allow — takes over and skips the ask.

**To adjust**: create an override copy and edit it.
