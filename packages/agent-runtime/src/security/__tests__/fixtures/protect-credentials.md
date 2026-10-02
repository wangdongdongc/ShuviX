---
shuvix: policy v1
name: protect-credentials
shuvix-displayName: Protect Some Credential Directories
description: Reading a credential store asks you first; sandboxed commands cannot touch them at all.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  credentialDirs: >-
    ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.shuvix/.session-state',
    'AppData/Local/Microsoft/Credentials',
    'AppData/Roaming/Microsoft/Credentials'].map(s, vars.home + '/' + s)
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: inDir(object.path, credentialDirs)
    prompt: This path holds credentials. Anything read here — private keys, tokens — enters the model context, which is the same as handing it over.
---

**What it does**: for your credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`,
`~/.config/gh`, `~/.netrc`, and `~/.shuvix/.session-state` — the key ShuviX
encrypts your saved API keys with):

- **Reading asks first** — reading a private key is effectively leaking it, so
  the agent asks before the file tools read these paths.
- **Sandboxed commands can neither read nor write them.** The command sandbox
  takes its list from this policy's `credentialDirs`, so an override copy that
  changes the list changes it for commands too.

**What it does not do**:

- Only these paths are covered.
- Writing is not refused: a write here is an ordinary write and asks under
  ask-on-write, like any write outside the working directory.
- A command that runs outside the sandbox (the sandbox is off or unavailable,
  or the agent asked for full access) is not checked path by path — it asks as
  a whole, under ask-on-command.
- It does not always reach you: with the automatic review on, a reviewing
  agent answers first — it lets ordinary work through, refuses what is
  clearly harmful and puts the rest in front of you with its opinion.

**To adjust**: create an override copy and edit it — do so deliberately.
