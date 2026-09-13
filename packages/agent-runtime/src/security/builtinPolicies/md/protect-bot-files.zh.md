---
shuvix: policy v1
shuvix-builtin: true
name: protect-bot-files
shuvix-displayName: bot 改写自己之前必问
description: 写入 bot 文件一律询问 —— 自动放行开关也盖不住它。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, [vars.botsDir])
    prompt: >-
      这次写入落在一份 bot 自己的文件上 —— 它是谁、它记住了什么，从此每一场对话
      它都会把这些当作系统提示词的一部分读回去。请看 diff：写进一条新的偏好或事实正是
      这份文件的用途；改写人设则是在改「这个 bot 是谁」。
---

**做什么**：bots 目录下的任何文件写入都先问你一次，**并且开了自动放行也照样问**。

**为什么不是拒绝**：bot 就是 markdown 文件，「帮我起草一个 bot」是个完全正当的请求，
一刀拒绝会把它一起挡掉。询问既保住了这条路，又保证「改写一份你自己的文件」不会在你看不见
的时候发生。

**为什么盖不住自动放行**：bot 文件是 agent 唯一会**改自己**的那份文件。它的正文进的是
这条 bot 会话的系统提示词，而 bot 被要求自己保持它是最新的 —— 一条说过的偏好、一次纠正、
一个费了力气才弄清楚的事实。这次编辑发生在它答你话的中途，并且会在之后每一场对话里生效。
一次悄悄改写人设、或者把它记得的东西删掉一半的编辑，正是这张卡要摆到你面前的东西。

**做不到什么**：

- 它只管文件工具。bot 会话自己的 agent 根本不能执行命令，但它派出去的子会话可以 ——
  而 bash 写文件不看路径策略。那一侧的兜底是审计记录，以及子会话本身就是一段你打得开的
  可见对话。
- 它不管读取。bot 正文本来就已经在它的系统提示词里了。
