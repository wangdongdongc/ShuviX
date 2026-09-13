---
shuvix: policy v1
shuvix-builtin: true
name: protect-bot-files
shuvix-displayName: Always Ask Before a Bot Rewrites Itself
description: Writes to your bot files always ask — the auto-allow switch does not cover them.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, [vars.botsDir])
    prompt: >-
      This writes to a bot's own file — who it is and what it remembers, which it
      reads back as part of its system prompt in every conversation from now on. Read the
      diff: a new preference or fact is what this file is for; a rewritten persona is a
      change to who the bot is.
---

**What it does**: any file write under your bots directory asks you first, and
**keeps asking even with auto-allow on**.

**Why it is not a refusal**: a bot is a markdown file, and "help me draft a bot"
is a perfectly good thing to ask for. Refusing outright would block that. Asking
keeps it possible while making sure a rewrite of a file you own never happens
off-screen.

**Why it survives auto-allow**: a bot file is the one file an agent edits _about
itself_. Its body is appended to the system prompt of the bot session that reads it,
and the bot is expected to keep it current on its own — a stated preference, a
correction, a fact about you that took effort to establish. That edit happens in the
middle of answering you, and it persists across every later conversation. An edit that
quietly rewrites the persona, or drops half of what the bot knew, is exactly what this
card exists to put in front of you.

**What it does not do**:

- It gates the file tools only. A bot session's own agent cannot run commands at all,
  but a sub-session it dispatches can — and a command that writes files is not checked
  against path policies. The backstop there is the audit trail and the fact that the
  sub-session is a visible conversation you can open.
- It does not gate reads. The bot's body is already in its system prompt.
