---
shuvix: policy v1
shuvix-builtin: true
name: review-knowledge-writes
shuvix-displayName: Always Review Knowledge Writes
description: Writing an entry into the knowledge base always asks you first, even while auto-allow is on — session summaries excepted.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, [vars.knowledgeRoot]) && !inDir(object.path, vars.knowledgeSessionDirs)
    prompt: A knowledge entry is written once and read back by every later session in its scope. Check that this one is worth keeping before allowing.
---

**What it does**: whenever an agent wants to create or change an entry in the
knowledge base (`~/.shuvix/knowledge`), it asks you first — through the
`knowledge` tool or by writing the file directly, both land on the same gate.
Unlike the other ask gates, this one still asks while the session's auto-allow
switch is on.

**What it leaves alone**: the `sessions/` directories. Session summaries are
rolling notes the host keeps up to date automatically; asking on every refresh
would turn "automatic" into a stream of prompts. They stay drafts you review in
the knowledge page.

**What it does not do**:

- It gates the file tools and the `knowledge` tool only; if you allow it, the
  agent can still write an entry by running a command.
- It does not judge whether an entry is any good — that is what your review is
  for. Allowing a write is not verifying it: entries become verified only when
  you mark them so in the app.
- It does not gate reading entries. Recall stays free.

**To adjust**: create an override copy. Change the effect to `ask` to make
knowledge writes behave like any other write (skipped while auto-allow is on),
drop the `sessions` clause to review summaries too, or remove the rule to stop
asking.
