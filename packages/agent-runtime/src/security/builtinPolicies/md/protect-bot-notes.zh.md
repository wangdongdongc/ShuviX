---
shuvix: policy v1
shuvix-builtin: true
name: protect-bot-notes
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
      这次写入落在一份 bot 的定义文件上 —— 它的人设和它的笔记。请看 diff：分界线以上
      全是你自己写的东西，而「重写自己的人设」不属于整理笔记。
---

**做什么**：bots 目录下的任何文件写入都先问你一次，**并且开了自动放行也照样问**。

**为什么不是拒绝**：bot 就是 markdown 文件，「帮我起草一个 bot」是个完全正当的请求，
一刀拒绝会把它一起挡掉。询问既保住了这条路，又保证「改写一份你自己的文件」不会在你
看不见的时候发生。

**为什么盖不住**：这是 agent 唯一一份**关于它自己**的文件。笔记段是节流跑的，在对话
结束很久之后 —— 那时你并不在看。一次整文件重写悄悄丢掉半份笔记、或者动了分界线以上的
人设，正是这张卡片要拦在你面前的东西。

**不做什么**：

- 它只管文件工具。能跑命令的 agent 可以绕开这里写文件 —— 真正的兜底是审计记录，
  以及这些文件在设置页里看得见。
- 它不管读。bot 文件本来就是提示词，它自己的正文早已在它的上下文里。

**想调整**：新建一份覆盖副本改它。等你信得过之后，按 `subject.profile == 'bot-notes'`
把笔记段放行是个合理的改法 —— 那是关于你自己文件的决定。
