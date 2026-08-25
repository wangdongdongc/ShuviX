---
shuvix: policy v1
shuvix-builtin: true
name: session-auto-allow
shuvix-displayName: Session Auto-Allow Takes Effect
description: While the session's auto-allow switch is on, every ask is skipped.
shuvix-policy-scope:
  subject.kind: [agent]
shuvix-policy-rules:
  - effect: force-allow
    match: vars.autoAllow
    prompt: The session's auto-allow switch is on, so ask gates are skipped.
---

**What it does**: this is the "Auto-Allow" switch in the session config panel.
While it is on, every ask gate — file reads and writes, commands, git, database
— is skipped and the operation runs immediately.

**What it does not do**:

- It cannot beat a deny. protect-credentials and protect-system still block
  what they block, auto-allow or not.
- It does not skip a `force-ask` rule. That effect exists precisely to mean
  "this gate does not accept session-level consent", so a policy written with
  it still asks while the switch is on.
- It is per session and never persists to a new one.

**To adjust**: this policy is what gives the switch its meaning. Override it to
narrow the switch — for example, keep asking for writes even when it is on:

    shuvix-policy-scope:
      subject.kind: [agent]
    shuvix-policy-rules:
      - effect: force-allow
        action: [read, execute]
        match: vars.autoAllow

`subject.kind` is required on every rule (here it is declared once in the
scope). Do not drop it: an invalid override file is skipped entirely and does
**not** shadow the builtin — so a narrowing override that fails to parse leaves
the original, un-narrowed switch fully in effect. That is the one direction
where the "invalid user file never shadows a builtin" rule works against your
intent, so check the policy page after editing: if your version is not the one
marked as active, it did not parse.
