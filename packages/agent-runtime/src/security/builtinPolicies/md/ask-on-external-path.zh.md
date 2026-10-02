---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-external-path
shuvix-displayName: 访问会话目录以外的文件前询问
description: 文件工具在本会话自己的目录里自由读写；读家目录里的其他地方、或往其他任何地方写，先问你。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      inDir(object.path, vars.home)
      && !inDir(object.path, vars.sessionDirs)
      && !inDir(object.path, vars.sessionReadDirs)
      && !inDir(object.path, vars.grantedRead)
      && !inDir(object.path, vars.grantedWrite)
    prompt: 这个文件在本会话的目录之外。读到的内容会进入模型上下文，之后的对话与工具调用都可能把它带出去。
  - effect: ask
    action: [write]
    match: >-
      !inDir(object.path, vars.sessionDirs)
      && !inDir(object.path, vars.grantedWrite)
    prompt: 这次写入在本会话的目录之外。允许之前请看清目标路径和改动。
---

**它做什么**：文件工具（read、write、edit、ls、grep、glob……）在本会话自己的目录里自由使用：

- 工作目录 —— 除非它是 `/`、覆盖了整个家目录，或是 ShuviX 自己的配置或应用数据；
- 本会话的临时目录（它的命令里的 `$TMPDIR`）、它的 artifacts（`~/.shuvix/artifacts/<会话>/`）
  和工具结果（长输出与后台任务日志）；
- 你给本会话勾选的知识库 —— 知识库的每次改动都会提交进它自己的 git，可以回退；
- 你答过「允许并记住」的路径 —— 写授权同时覆盖读取。

技能目录（内置的和你启用的）以及内置的 ShuviX 说明书是**只读**的会话目录：读不问，改要问 ——
技能是智能体自己要遵守的指令。

在这些目录之外：**读家目录里的文件要问**，**往任何地方写都要问**。读家目录以外的地方
（系统目录、`/opt/homebrew`、`/Applications`）不问。

这条线和命令沙箱划的完全一样：受限的命令能读写同样这些会话目录、能读家目录以外，别的都不行。
两边的清单出自同一处（宿主按本会话的设置算出的 `vars.sessionDirs` 与 `vars.sessionReadDirs`，
不是谁要维护的清单），所以智能体从文件工具换成 `cat`、
`echo >` 也占不到便宜。`~/.ssh` 这类凭据在家目录里，不用再单列一份清单。

**它不做什么**：

- 命令由 ask-on-command 和沙箱管。没有沙箱时（Windows、Linux，或沙箱关着），文件工具照样按这条线，
  每条命令都询问。
- 它不一定摆到你面前：开着自动审查时，审查 agent 先回答 —— 放行日常的工作，
  拒绝明显有害的，其余的附上它的意见交给你。
- 「允许并记住」只在本会话有效；记住的路径列在会话配置面板里，可以逐条删。

**想调整**：创建覆盖副本后编辑调整。删掉读取那条规则，文件工具在哪儿读都不再问
（沙箱照样把受限的命令挡在家目录之外）。
