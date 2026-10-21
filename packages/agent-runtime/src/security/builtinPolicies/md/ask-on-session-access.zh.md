---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-session-access
shuvix-builtin: true
name: ask-on-session-access
shuvix-displayName: 使用别的会话前询问
description: 智能体可以自由使用自己的子会话和本会话权限表里的会话；查看别的会话、或与它对话，先问你。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [session]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      !object.ownTurn
      && !(object.sessionId in vars.aclSessionRead)
    prompt: 这会把另一条会话的对话 —— 它的答复和它做过的事 —— 带进本会话。那条会话可能属于别的项目。
  - effect: ask
    action: [write]
    match: >-
      !object.ownTurn
      && !(object.sessionId in vars.aclSessionWrite)
    prompt: 这会往另一条会话里发一条消息，它会用自己的文件夹和自己的权限表去做。允许之前请看清这条消息。
---

**它做什么**：智能体可以经 `session` 工具和别的会话打交道 —— 你在输入框里 @ 一条会话，智能体就能用它的 id
找到它。下面这些不问：

- **它自己的子会话** —— 它自己开的那些；
- **它在别的会话里发起的那一轮**：收这一轮的答复、回答这一轮里的提问、往里插话、停下它 —— 发起这一轮时已经
  过了这道门；
- **本会话权限表里的会话** —— 在询问卡片上「允许并记住」就在表里写下一行。一行要么是**查看**（读它的答复、
  看它里面发生了什么、等它），要么是**对话**（给它发消息、插话、回答它的提问、停下自己发起的那一轮 ——
  对话包含查看）。

其余的**都要问**：查看别的会话，以及每一条发进去的消息。只允许一次的会话下次还会问；记住它就不再问了。
这些行在会话设置里，可以在查看与对话之间切换，也可以删掉。

**为什么要问**：另一条会话有自己的工作目录和自己的权限表 —— 往往是另一个项目。让智能体和它对话，等于让它
够得着那条会话够得着的一切；查看它，会把它的对话搬进本会话。

**它不做什么**：

- 自动审查不回答这类询问：内置的 `auto-review` hook 把会话访问留给你，每张卡片都会摆到你面前。
- 消息发进去之后，那条会话做什么不归它管 —— 由那条会话自己的策略和权限表管，与你在那里亲手打字一样。
- 授权属于一个会话。子会话创建时复制父会话的授权，fork 复制源会话的。

**想调整**：创建覆盖副本后编辑调整。删掉查看那条规则，智能体只要知道 id，查看任何会话都不再问。
