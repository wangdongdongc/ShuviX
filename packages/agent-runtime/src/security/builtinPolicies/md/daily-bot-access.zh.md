---
shuvix: policy v1
shuvix-id: policy:builtin:daily-bot-access
shuvix-builtin: true
name: daily-bot-access
shuvix-displayName: 日记 bot 读取今天的会话
description: ShuviX 自带的日记 bot 不用问你，就能读最近 24 小时有过消息的会话和你的日记。它自己什么都不写。
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
    prompt: 看看今天的会话，是日记 bot 的本职。
  - effect: force-allow
    object.type: [path]
    action: [read]
    match: >-
      has(subject.bot) && subject.bot == 'bot:builtin:daily'
      && subject.agentKind == 'root'
      && inDir(object.path, vars.dailyDir)
    prompt: 日记 bot 要看看昨天有没有写日记。
---

**这份策略的作用**：日记 bot（ShuviX 第一次启动时写进 `~/.shuvix/bots/daily.md`
的那个）每天傍晚被内置定时器叫起来，看看今天的会话和昨天有没有写日记，提几条你可以采纳的
建议。它要做的两件事本来每次都会问你，而傍晚 18:00 多半没有人在场回答：

- **读别的会话** —— `ask-on-session-access` 在任何会话读一条不是自己子会话的会话之前询问。
  这份策略让日记 bot 不用问就能读最近 24 小时有过消息的会话（只是读：往里发消息照样询问）；
- **读 `~/.shuvix/daily/`** —— 你的日记（只是读）。

这里没有任何一条让它写东西：你采纳了它的某条建议（比如写今天的日记），那次写入和别的会话一样
照常询问。

两条规则都只作用于绑定了这个 bot 的会话的根 agent（`subject.bot` 是 bot 文件的 `shuvix-id`，
bot 改名也不变），不作用于它的子会话，也不作用于它派出去的 agent。`bot:builtin:daily` 这个 id 只对 ShuviX
自己写下的那份文件成立：别的 bot 文件声明它，身份按名字算；ShuviX 写的 `daily.md` 不在了，这个 id 就不再认。

**怎么调整**：在行菜单里创建覆盖副本，把 `24h` 改成更长或更短的时间窗；或者停用这份策略，
日记 bot 就和别的会话一样询问。删掉 `~/.shuvix/bots/daily.md` 则 bot 本身不再运行。
