---
shuvix: policy v1
shuvix-builtin: true
name: protect-credentials
shuvix-displayName: Protect Some Credential Directories
description: Credential stores can never be written; reading them asks first.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  credentialDirs: >-
    ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc',
    'AppData/Local/Microsoft/Credentials',
    'AppData/Roaming/Microsoft/Credentials'].map(s, vars.home + '/' + s)
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, credentialDirs)
    prompt: Write refused. Credential directories (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh, ~/.netrc) are closed to the agent. Ask the user to make the change themselves.
  - effect: ask
    action: [read]
    match: inDir(object.path, credentialDirs)
    prompt: This path holds credentials. Anything read here — private keys, tokens — enters the model context, which is the same as handing it over.
---

**What it does**: for your credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`,
`~/.config/gh`, `~/.netrc`):

- **Writing is never allowed** — not even with auto-allow on.
- **Reading asks first** — reading a private key is effectively leaking it, so
  unless you have auto-allow on, the agent asks before reading these paths.

**What it does not do**:

- Only these paths are covered.
- It gates the file tools only: if you allow it, the agent can act on important
  credential files by running commands.
- Once you turn the auto-allow switch on, another builtin policy —
  session-auto-allow — takes over and skips the ask.

**To adjust**: create an override copy and edit it — do so deliberately.
