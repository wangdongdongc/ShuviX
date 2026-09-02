---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-sub-session
shuvix-displayName: 开子会话前询问
description: agent 要开一条子会话时先问你 —— 那是一场会自己跑、自己花钱的新对话。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [invocation]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: "tool.name == 'session' && tool.operation == 'create-sub-session'"
    prompt: 这会开出一场自己跑的新对话，之后不再逐条问你，token 也照花。
---

**这条策略做什么**：agent 想开一条子会话时，先问你一句。

子会话不是一次工具调用，而是**一整场对话** —— 它有自己的模型、自己的工具，由 agent
自己驱动，中途不会再问你。这值得你在开始时做一次决定。

**它不做什么**：

- 不拦已经开出来的子会话后续收到的消息，也不拦等待/读取它们的答复 —— 那些是你在这里
  已经做过的决定的延续。
- 不拦子会话**里面**干了什么：它每一次工具调用照常在那条会话里过同一套策略。
- 打开免询问开关之后，另一条内置策略 session-auto-allow 接管，这道询问被跳过。

**想调整**：创建覆盖副本后编辑。把 rules 清空即可让子会话不经询问直接开。
