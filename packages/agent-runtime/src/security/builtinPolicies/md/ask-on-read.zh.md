---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-read
shuvix-displayName: 文件读取前询问
description: 工作区与应用只读目录之外的读取需先询问；范围内读取自由。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      !inDir(object.path, vars.workspace)
      && !inDir(object.path, vars.toolResultsBase)
      && !inDir(object.path, vars.skillsDirs)
    prompt: 读取工作目录之外的文件，内容会进入模型上下文，之后的对话与工具调用都可能把它带出去。
---

**它做什么**：智能体在你的工作目录（以及应用的只读目录：工具结果、skills）内
自由读取；读取范围之外的任何内容 —— 其它位置、其他项目的文件 ——
都会先问你。

**它不做什么**：

- 只拦文件工具：如果你允许了，智能体通过执行命令也可以读文件。
- 本策略不会对文件的敏感性进行分析。
- 当你打开免询问的开关后，另一条内置的 session-auto-allow 策略将生效并跳过询问。

**想调整**：创建覆盖副本后编辑调整
