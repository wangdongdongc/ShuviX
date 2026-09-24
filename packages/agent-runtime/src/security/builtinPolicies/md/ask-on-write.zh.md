---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: 文件写入前询问
description: 任何位置的文件写入/编辑都会先问过你 —— 本会话自己的产物（artifact）除外。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [write]
    match: '!inDir(object.path, vars.sessionArtifactsDir)'
    prompt: 写入会直接改写磁盘上的内容。放行前先确认目标路径与改动范围。
---

**它做什么**：智能体要写入或编辑文件时 —— 无论在不在工作目录内 —— 都会先问你。

唯一不问的是本会话自己的产物（`~/.shuvix/artifacts/<会话>/`）：智能体为了修改而认领下来的
图和交互块。它们是这场对话自己的文件、不在你的项目里，改一分钟前刚画的图也要逐次确认，
只会把你训练成闭眼点允许。

**它不做什么**：

- 只拦文件工具；如果你允许了，智能体通过执行命令也可以写文件。
- 当你打开免询问的开关后，另一条内置的 session-grants 策略将生效并跳过询问。

**想调整**：创建覆盖副本后编辑调整
