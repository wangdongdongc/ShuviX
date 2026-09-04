---
shuvix: policy v1
shuvix-builtin: true
name: protect-bot-files
shuvix-displayName: Always Ask Before an Agent Edits a Bot
description: Writes to your bot definitions always ask — the auto-allow switch does not cover them.
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, [vars.botsDir])
    prompt: >-
      This writes to a bot's own definition file — its persona and what it remembers, which
      every agent acting for that bot reads as part of its system prompt from now on. Read
      the diff: a new preference or fact is what this file is for; a rewritten persona is a
      change to who the bot is.
---

**What it does**: any file write under your bots directory asks you first, and
**keeps asking even with auto-allow on**.

**Why it is not a refusal**: bots are markdown files, and "help me draft a bot"
is a perfectly good thing to ask an agent to do. Refusing outright would block
that. Asking keeps it possible while making sure a rewrite of a file you own
never happens off-screen.

**Why it survives auto-allow**: a bot's file is the one file an agent edits
_about itself_. Its body is appended to the system prompt of every agent that
acts for that bot, and the bot is expected to keep it current on its own — a
stated preference, a correction, a fact about the project. That edit happens in
the middle of answering you, and it persists across every later conversation.
An edit that quietly rewrites the persona, or drops half of what the bot knew,
is exactly what this card exists to put in front of you.

**What it does not do**:

- It gates the file tools only. An agent that can run commands can write files
  without passing through here — the real backstop is the audit trail and the
  fact that these files are visible in Settings.
- It says nothing about reading. The bot's body is already in the agent's
  system prompt, and the host marks the file as read at dispatch, so a self-edit
  needs no `read` first.

**To adjust**: create an override copy and edit it. Loosening it for one trusted
task agent (`subject.profile == '<agent name>'`) is a reasonable change once you
trust it — that is a decision about your own files.
