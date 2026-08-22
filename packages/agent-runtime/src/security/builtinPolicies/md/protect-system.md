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
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, systemDirs)
    prompt: Write refused. This is an operating-system directory and is closed to the agent.
---

**What it does**: the agent can never write to operating-system locations
(`/etc`, `/usr`, `/System`, the Windows system and program directories, …) —
not even with auto-allow on.

**What it does not do**:

- Only writes by the agent's file tools are blocked; a command you allow runs
  with your full system privileges and is not restricted here.
- Reading these locations is not blocked.
- Your own files are not covered — see ask-on-read / ask-on-write for
  those.

**To adjust**: create an override copy and edit it — do so deliberately.
