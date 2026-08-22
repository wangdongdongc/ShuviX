---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-command
shuvix-displayName: 命令执行前询问
description: bash/ssh 每条命令都逐条询问用户；唯一豁免是会话级免询问开关。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    prompt: 放行后命令以你的完整系统权限运行，可读写任意文件、访问网络。放行前先看清它实际做什么。
---

**它做什么**：智能体要运行的每条命令都需要向你询问。

**它不做什么**：

- 询问是闸门：你一旦放行，命令就以你的完整系统权限运行。
- 当你打开免询问的开关后，另一条内置的 session-auto-allow 策略将生效并跳过询问。

**想调整**：创建覆盖副本后编辑调整
