---
shuvix: policy v1
shuvix-builtin: true
name: protect-bot-notes
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
      This writes to a bot's own definition file — its persona and its notes. Read the diff.
      Everything above the notes marker is your writing, and a bot rewriting its own persona
      is not part of keeping notes.
---

**What it does**: any file write under your bots directory asks you first, and
**keeps asking even with auto-allow on**.

**Why it is not a refusal**: bots are markdown files, and "help me draft a bot"
is a perfectly good thing to ask an agent to do. Refusing outright would block
that. Asking keeps it possible while making sure a rewrite of a file you own
never happens off-screen.

**Why it survives auto-allow**: this is the one file an agent edits _about
itself_. The notes stage runs on a throttle, long after a conversation ended —
you will not be watching. A whole-file rewrite that quietly drops half your
notes, or edits the persona above the marker, is exactly what this card exists
to put in front of you.

**What it does not do**:

- It gates the file tools only. An agent that can run commands can write files
  without passing through here — the real backstop is the audit trail and the
  fact that these files are visible in Settings.
- It says nothing about reading. Bot files are prompts; the bot's own text is
  already in its context.

**To adjust**: create an override copy and edit it. Narrowing it to skip the
notes stage (`subject.profile == 'bot-notes'`) is a reasonable change once you
trust it — that is a decision about your own files.
