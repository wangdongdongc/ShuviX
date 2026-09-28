---
shuvix: policy v1
shuvix-builtin: true
name: protect-shuvix-config
shuvix-displayName: Always Ask Before Changing ShuviX's Own Configuration
description: Writes to ShuviX's policies, agents, hooks and skills always ask you — neither the automatic review nor the auto-allow switch answers them.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, vars.shuvixConfigDirs)
    prompt: >-
      This changes ShuviX's own configuration — a security policy, an agent's instructions,
      a hook that runs on its own, or a skill. It decides what agents may do from now on,
      the automatic review included. Read the diff.
---

**What it does**: any file write by an agent under `~/.shuvix/policies`, `~/.shuvix/agents`,
`~/.shuvix/hooks` or `~/.shuvix/skills` asks you first, and **keeps asking even with auto-allow
on**. The automatic review does not answer it either: a `force-ask` only ever goes to you.

**Why**: these files are rules, not content. A policy decides what agents may do; an agent file
is a system prompt; a hook starts agents on its own; a skill is read as instructions. The
automatic review is made of them too — its reviewer is an agent file and its trigger a hook file,
and a file with the same name overrides the builtin one. If these could change without you
seeing it, a single injected instruction could switch every later check off for good.

**What it does not do**:

- It gates the file tools only. Commands are held by the sandbox where it is on (it cannot write
  under `~/.shuvix` either); a command that runs unconfined is judged like any other, and the
  reviewer treats changing ShuviX's protections as harmful.
- Your own edits in the notebook are not agent writes and are never asked about. When you ask
  the notebook's agent to change one of these files, each change asks — that is the point.
- Bot files have their own policy, protect-bot-files.

**To adjust**: create an override copy and edit it — do so deliberately.
