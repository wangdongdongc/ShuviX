---
shuvix: policy v1
shuvix-id: policy:builtin:daily-bot-access
shuvix-builtin: true
name: daily-bot-access
shuvix-displayName: 日报 bot 读取最近的会话
description: ShuviX 自带的日报 bot 不用问你，就能读最近 7 天有过消息的会话，并维护 ~/.shuvix/tracking 里的跟踪项。
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
    prompt: 翻看最近 7 天的会话正是日报 bot 的本职。
  - effect: force-allow
    object.type: [path]
    action: [read, write]
    match: >-
      has(subject.bot) && subject.bot == 'bot:builtin:daily'
      && subject.agentKind == 'root'
      && inDir(object.path, vars.trackingDir)
    prompt: 跟踪项是日报 bot 自己的文件。
---

**这份策略的作用**：日报 bot（ShuviX 第一次启动时写进 `~/.shuvix/bots/daily.md`
的那个）每天傍晚被内置定时器叫起来，翻一遍你最近的会话来维护跟踪项。它要做的两件事
本来每次都会问你，而傍晚 18:00 多半没有人在场回答：

- **读别的会话** —— `ask-on-session-access` 在任何会话读一条不是自己子会话的会话之前询问。
  这份策略让日报 bot 不用问就能读最近 7 天有过消息的会话（只是读：往里发消息照样询问）；
- **读写 `~/.shuvix/tracking/`** —— `ask-on-external-path` 在往会话权限表以外写之前询问。

两条规则都只作用于绑定了这个 bot 的会话的根 agent（`subject.bot` 是 bot 文件的 `shuvix-id`，
bot 改名也不变），不作用于它的子会话，也不作用于它派出去的 agent。`bot:builtin:daily` 这个 id 只对 ShuviX
自己写下的那份文件成立：别的 bot 文件声明它，身份按名字算；ShuviX 写的 `daily.md` 不在了，这个 id 就不再认。

**怎么调整**：在行菜单里创建覆盖副本，把 `168h` 改成更长或更短的时间窗；或者停用这份策略，
日报 bot 就和别的会话一样询问。删掉 `~/.shuvix/bots/daily.md` 则 bot 本身不再运行。
