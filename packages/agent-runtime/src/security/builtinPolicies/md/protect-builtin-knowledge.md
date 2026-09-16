---
shuvix: policy v1
shuvix-builtin: true
name: protect-builtin-knowledge
shuvix-displayName: Keep ShuviX's Built-in Knowledge Base Read-only
description: The agent can never write into the knowledge base ShuviX ships with the app.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, [vars.builtinKnowledgeDir])
    prompt: >-
      Write refused. This file is part of ShuviX's built-in knowledge base — the
      reference it ships with the app, replaced on every update. Record what you
      learned in one of the user's own knowledge bases instead ("bases" in the
      knowledge tool lists them).
---

**What it does**: any file write under ShuviX's built-in knowledge base is refused —
not even with auto-allow on.

**Why**: that base is ShuviX's own reference (how its agent / bot / policy / hook
files, knowledge entries and skills are written). It lives inside the application
bundle and is replaced wholesale on every update, so anything written there is lost
at the next release — and on macOS a modified application bundle no longer matches
its signature and may refuse to launch. The `knowledge` tool already refuses to
`create` there and marks the base read-only; this policy closes the remaining path,
a direct `write` / `edit` at the absolute path the tool prints.

**What it does not do**:

- Only writes by the agent's file tools are blocked; a command you allow runs with
  your full system privileges and is not restricted here.
- Reading is not blocked — reading is what the base is for.
- Your own knowledge bases under `~/.shuvix/knowledge/` are not covered — see
  ask-on-write for those.
