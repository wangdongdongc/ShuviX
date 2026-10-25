---
shuvix: policy v1
shuvix-id: policy:builtin:daily-bot-access
shuvix-builtin: true
name: daily-bot-access
shuvix-displayName: Daily Bot Reads Recent Sessions
description: The daily bot that ships with ShuviX reads the sessions active in the last 7 days and your diary, and keeps the tracked items in ~/.shuvix/tracking, without asking you.
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
      && timestamp(object.lastActiveAt) > timestamp(vars.now) - duration('168h')
    prompt: Going through the sessions of the last 7 days is what the daily bot is for.
  - effect: force-allow
    object.type: [path]
    action: [read, write]
    match: >-
      has(subject.bot) && subject.bot == 'bot:builtin:daily'
      && subject.agentKind == 'root'
      && inDir(object.path, vars.trackingDir)
    prompt: The tracked items are the daily bot's own files.
  - effect: force-allow
    object.type: [path]
    action: [read]
    match: >-
      has(subject.bot) && subject.bot == 'bot:builtin:daily'
      && subject.agentKind == 'root'
      && inDir(object.path, vars.dailyDir)
    prompt: Your own words in the diary are what tells the daily bot a matter is unfinished.
---

**What it does**: the daily bot (the one ShuviX writes into `~/.shuvix/bots/daily.md`
on first start) is woken by the built-in timer every evening and goes through
your recent sessions to keep the tracked items. Three things it needs would
otherwise ask you every time, and nobody is there to answer at 18:00:

- **reading other sessions** — `ask-on-session-access` asks before any session
  reads a session that is not its own sub-session. This policy lets the daily
  bot read, without asking, every session that had a message in the last
  7 days (only read: sending messages into them still asks);
- **reading and writing `~/.shuvix/tracking/`** — `ask-on-external-path` asks
  before writing outside a session's permission table;
- **reading `~/.shuvix/daily/`** — your diary, where your own words say what is
  still unfinished (only read: the bot never writes your diary).

All three rules apply only to the root agent of a session bound to that bot
(`subject.bot` is the bot file's `shuvix-id`, which does not change when the
bot is renamed), never to its sub-sessions or to agents it dispatches. The id `bot:builtin:daily`
counts only for the file ShuviX itself wrote: another bot file declaring it is identified by its
name instead, and once ShuviX's `daily.md` is gone the id is not granted again.

**Adjusting it**: create an override copy (row menu) and change `168h` to read
a longer or shorter window, or disable this policy to make the daily bot ask
like every other session. Deleting `~/.shuvix/bots/daily.md` stops the bot
itself.
