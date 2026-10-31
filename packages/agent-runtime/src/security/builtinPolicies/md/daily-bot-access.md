---
shuvix: policy v1
shuvix-id: policy:builtin:daily-bot-access
shuvix-builtin: true
name: daily-bot-access
shuvix-displayName: Diary Bot Reads Today's Sessions
description: The diary bot that ships with ShuviX reads the sessions active in the last 24 hours and your diary without asking you. It writes nothing on its own.
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-allow
    object.type: [session]
    action: [read]
    match: >-
      has(subject.bot) && subject.bot == 'bot:builtin:daily'
      && subject.agentKind == 'root'
      && timestamp(object.lastActiveAt) > timestamp(vars.now) - duration('24h')
    prompt: Looking at today's sessions is what the diary bot is for.
  - effect: force-allow
    object.type: [path]
    action: [read]
    match: >-
      has(subject.bot) && subject.bot == 'bot:builtin:daily'
      && subject.agentKind == 'root'
      && inDir(object.path, vars.dailyDir)
    prompt: The diary bot checks whether yesterday has a diary page.
---

**What it does**: the diary bot (the one ShuviX writes into `~/.shuvix/bots/daily.md`
on first start) is woken by the built-in timer every evening, looks at today's
sessions and at whether yesterday has a diary page, and makes a few suggestions
you can accept. Two things it needs would otherwise ask you every time, and
nobody is there to answer at 18:00:

- **reading other sessions** — `ask-on-session-access` asks before any session
  reads a session that is not its own sub-session. This policy lets the diary
  bot read, without asking, every session that had a message in the last
  24 hours (only read: sending messages into them still asks);
- **reading `~/.shuvix/daily/`** — your diary (only read).

Nothing here lets it write: when you accept one of its suggestions — writing
today's diary, say — that write goes through the usual asks like any other
session's.

Both rules apply only to the root agent of a session bound to that bot
(`subject.bot` is the bot file's `shuvix-id`, which does not change when the
bot is renamed), never to its sub-sessions or to agents it dispatches. The id `bot:builtin:daily`
counts only for the file ShuviX itself wrote: another bot file declaring it is identified by its
name instead, and once ShuviX's `daily.md` is gone the id is not granted again.

**Adjusting it**: create an override copy (row menu) and change `24h` to read
a longer or shorter window, or disable this policy to make the diary bot ask
like every other session. Deleting `~/.shuvix/bots/daily.md` stops the bot
itself.
