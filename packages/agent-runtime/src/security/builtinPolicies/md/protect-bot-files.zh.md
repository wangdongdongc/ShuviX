---
shuvix: policy v1
shuvix-builtin: true
name: protect-bot-files
shuvix-displayName: agent 改动 bot 定义前必问
description: 写入 bot 定义文件一律询问 —— 自动放行开关也盖不住它。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: force-ask
    action: [write]
    match: inDir(object.path, [vars.botsDir])
    prompt: >-
      这次写入落在一份 bot 的定义文件上 —— 它的人设和它记住的东西，从此每一个替这个 bot
      做事的 agent 都会把它当作系统提示词的一部分读进去。请看 diff：写进一条新的偏好或
      事实正是这份文件的用途；改写人设则是在改「这个 bot 是谁」。
---

**做什么**：bots 目录下的任何文件写入都先问你一次，**并且开了自动放行也照样问**。

**为什么不是拒绝**：bot 就是 markdown 文件，「帮我起草一个 bot」是个完全正当的请求，
一刀拒绝会把它一起挡掉。询问既保住了这条路，又保证「改写一份你自己的文件」不会在你
看不见的时候发生。

**为什么盖不住**：bot 的文件是 agent 唯一一份**关于它自己**的文件。它的正文会被追加到
每一个替这个 bot 做事的 agent 的系统提示词末尾，而 bot 被要求自己把它维护好 —— 一条
明说的偏好、一次纠正、一个关于项目的事实。这种改动发生在回答你的半途，并且会延续到
之后的每一次对话。一次悄悄改写人设、或丢掉一半已知内容的编辑，正是这张卡片要拦在你
面前的东西。

**不做什么**：

- 它只管文件工具。能跑命令的 agent 可以绕开这里写文件 —— 真正的兜底是审计记录，
  以及这些文件在设置页里看得见。
- 它不管读。bot 的正文早已在 agent 的系统提示词里，宿主在派发时就把这份文件标记为
  已读，所以自我编辑不需要先 `read`。

**想调整**：新建一份覆盖副本改它。等你信得过之后，按 `subject.profile == '<agent 名>'`
给某个任务段 agent 放行是个合理的改法 —— 那是关于你自己文件的决定。
