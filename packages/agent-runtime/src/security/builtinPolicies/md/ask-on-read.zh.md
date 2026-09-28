---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-read
shuvix-displayName: 文件读取前询问
description: 工作区与应用只读目录之外的读取需先询问；沙箱开着时，只有受限命令也读不到的敏感位置才询问。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      has(vars.sandboxActive) && vars.sandboxActive
      ? inDir(object.path, vars.sandboxReadDenied)
      && !inDir(object.path, vars.sandboxReadAllowed)
      : !inDir(object.path, vars.workspace)
      && !inDir(object.path, vars.toolResultsBase)
      && !inDir(object.path, vars.skillsDirs)
      && !inDir(object.path, vars.memoryDirs)
      && !inDir(object.path, vars.builtinKnowledgeDir)
      && !inDir(object.path, vars.sessionArtifactsDir)
    prompt: 读取这个文件，内容会进入模型上下文，之后的对话与工具调用都可能把它带出去。
---

**它做什么**取决于本会话的命令是否在沙箱里运行。

- **沙箱开着**：受限命令几乎什么都能读，所以文件工具也一样 —— `cat` 能白读的文件，
  `read` 却要问，只会把智能体推向 `cat`。仍然询问的，是沙箱对命令同样拒绝的那一份清单：
  ShuviX 自己的数据（其他对话、数据库、凭据密钥）、你的个人资料目录（文稿、桌面、下载、
  图片、影片、音乐、iCloud 云盘、邮件、信息、Safari、其他应用的容器）和凭据目录。
  工作目录和本会话自己的工具结果即使位于这些目录之中，也照样免询问。
- **沙箱关闭**（或这里没有沙箱）：智能体在你的工作目录，以及应用的只读目录 —— 工具结果、
  skills、项目记忆、ShuviX 自己的内置知识库（那份说明书发出来就是给它查的）和本会话自己的
  产物 —— 内自由读取；范围之外的任何内容都会先问你。

**它不做什么**：

- 只拦文件工具；命令由 ask-on-command 和沙箱管。
- 除上述清单外，本策略不会对文件的敏感性进行分析。
- 它不一定摆到你面前：开着自动审查时，审查 agent 先回答 —— 放行日常的工作，
  拒绝明显有害的，其余的附上它的意见交给你。
- 当你打开免询问的开关后，另一条内置的 session-grants 策略将生效并跳过询问。

**想调整**：创建覆盖副本后编辑调整。把 `match` 换成 `:` 之后的那一段，就回到「不论有没有
沙箱，工作区外都要问」。
