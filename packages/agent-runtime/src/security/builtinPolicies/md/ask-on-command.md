---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-command
shuvix-displayName: Ask Before Running a Command
description: Every bash/ssh command asks you per command; the only exemption is the session-level auto-allow switch.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    prompt: An allowed command runs with your full system privileges — any file, any network access. Read what it actually does before allowing.
---

**What it does**: every command the agent wants to run has to ask you first.

**What it does not do**:

- The ask is the gate: once you allow it, the command runs with your full
  system privileges.
- Once you turn the auto-allow switch on, another builtin policy —
  session-auto-allow — takes over and skips the ask.

**To adjust**: create an override copy and edit it.
