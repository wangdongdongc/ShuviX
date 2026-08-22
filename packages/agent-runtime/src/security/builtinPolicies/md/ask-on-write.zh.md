---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: 文件写入前询问
description: 任何位置的文件写入/编辑都会先问过你。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [write]
    prompt: 写入会直接改写磁盘上的内容。放行前先确认目标路径与改动范围。
---

**它做什么**：智能体要写入或编辑文件时 —— 无论在不在工作目录内 —— 都会先问你。

**它不做什么**：

- 只拦文件工具；如果你允许了，智能体通过执行命令也可以写文件。
- 当你打开免询问的开关后，另一条内置的 session-auto-allow 策略将生效并跳过询问。

**想调整**：创建覆盖副本后编辑调整
