---
shuvix: policy v1
shuvix-builtin: true
name: protect-system
shuvix-displayName: Protect Some System Directories
description: The agent can never write to operating-system locations.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  systemDirs: >-
    ['/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/root',
    '/System', '/Library', '/private/etc', '/private/var'] + vars.systemDirs
  tempDirs: >-
    ['/private/var/folders', '/private/var/tmp']
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, systemDirs) && !inDir(object.path, tempDirs)
    prompt: Write refused. This is an operating-system directory and is closed to the agent.
---

**What it does**: the agent can never write to operating-system locations
(`/etc`, `/usr`, `/System`, the Windows system and program directories, …) —
not even with auto-allow on.

A path counts by where it really leads, not by how it is written: a link in
your project that points into `/etc` is refused like `/etc` itself, and on macOS
`/var/…` is `/private/var/…`.

**What it does not do**:

- Only writes by the agent's file tools are blocked; a command you allow runs
  with your full system privileges and is not restricted here.
- Reading these locations is not blocked.
- Temporary directories are not system locations, even where macOS keeps them
  under `/private/var`: your own temp directory (`$TMPDIR`, under
  `/private/var/folders`) and `/private/var/tmp` stay writable (with the usual
  ask).
- Your own files are not covered — see ask-on-read / ask-on-write for
  those.

**To adjust**: create an override copy and edit it — do so deliberately.
