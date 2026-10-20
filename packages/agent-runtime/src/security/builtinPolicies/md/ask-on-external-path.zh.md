---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-external-path
shuvix-builtin: true
name: ask-on-external-path
shuvix-displayName: 访问会话目录以外的文件前询问
description: 文件工具在本会话权限表里的路径上自由读写；读家目录里的其他地方、或往其他任何地方写，先问你。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: >-
      inDir(object.path, vars.home)
      && !inDir(object.path, vars.aclRead)
    prompt: 这个文件不在本会话的权限表里。读到的内容会进入模型上下文，之后的对话与工具调用都可能把它带出去。
  - effect: ask
    action: [write]
    match: '!inDir(object.path, vars.aclWrite)'
    prompt: 这次写入不在本会话的权限表里。允许之前请看清目标路径和改动。
---

**它做什么**：文件工具（read、write、edit、ls、grep、glob……）在本会话**权限表**里的路径上自由使用。
每个会话创建时就生成自己的权限表，在会话设置里可以看到：

- 工作目录 —— 除非它是 `/`、覆盖了整个家目录，或是 ShuviX 自己的配置或应用数据；
- 本会话的临时目录（它的命令里的 `$TMPDIR`）、它的 artifacts（`~/.shuvix/artifacts/<会话>/`）
  和工具结果（长输出与后台任务日志）；
- 你给本会话勾选的知识库 —— 知识库的每次改动都会提交进它自己的 git，可以回退；
- 技能目录（内置的和你启用的）以及内置的 ShuviX 说明书，**只读** —— 技能是智能体自己要遵守的指令，
  改它要问；
- 你授予的路径：在询问卡片上「允许并记住」，或在权限表里手动添加 —— 写授权同时覆盖读取。

前四类跟着会话设置走（勾上一个知识库它的那一行就出现，取消勾选那一行就去掉）；工作目录可以改成只读。
授予的行一直留着，直到你删掉。

在权限表之外：**读家目录里的文件要问**，**往任何地方写都要问**。读家目录以外的地方
（系统目录、`/opt/homebrew`、`/Applications`）不问。

这条线和命令沙箱划的完全一样：受限的命令能读表里的路径、能写表里可写的路径、能读家目录以外，别的都不行。
两边读的是同一张表（宿主按本会话的设置与授权算出的 `vars.aclRead` 与 `vars.aclWrite`，
不是谁要维护的清单），所以智能体从文件工具换成 `cat`、
`echo >` 也占不到便宜。`~/.ssh` 这类凭据在家目录里，不用再单列一份清单。

**它不做什么**：

- 命令由 ask-on-command 和沙箱管。没有沙箱时（Windows、Linux，或沙箱关着），文件工具照样按这条线，
  每条命令都询问。
- 它不一定摆到你面前：开着自动审查时，审查 agent 先回答 —— 放行日常的工作，
  拒绝明显有害的，其余的附上它的意见交给你。
- 授权属于一个会话。子会话创建时复制父会话的授权，fork 复制源会话的；之后各管各的。

**想调整**：创建覆盖副本后编辑调整。删掉读取那条规则，文件工具在哪儿读都不再问
（沙箱照样把受限的命令挡在家目录之外）。
