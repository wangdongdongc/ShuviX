---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-write
shuvix-displayName: 文件写入前询问
description: 文件写入/编辑会先问过你 —— 本会话自己的产物除外；沙箱开着时，受限命令本来就能改动的地方也除外。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: ask
    action: [write]
    match: >-
      !inDir(object.path, vars.sessionArtifactsDir)
      && !(inDir(object.path, vars.sandboxWritableRoots)
      && !inDir(object.path, vars.sandboxWriteDenied)
      && !vars.sandboxProtectedPatterns.exists(p, object.path.matches(p)))
    prompt: 写入会直接改写磁盘上的内容。放行前先确认目标路径与改动范围。
---

**它做什么**：智能体要写入或编辑文件时，会先问你 —— 有两个例外。

- **本会话自己的产物**（`~/.shuvix/artifacts/<会话>/`）：智能体为了修改而认领下来的图和
  交互块。它们是这场对话自己的文件、不在你的项目里，改一分钟前刚画的图也要逐次确认，
  只会把你训练成闭眼点允许。
- **沙箱开着时**，受限命令本来就能改动的地方：工作目录、临时目录和工具缓存。沙箱里的
  `bash` 已经能不经询问写这些位置，文件工具写同一个文件还要问，只会把智能体推向
  `echo > file`。其中受保护的位置照样询问，正如沙箱对命令照样拒绝它们：`.git/hooks`、
  `.git/config` 等 git 会自己执行的元数据，以及项目里的 `.vscode`、`.idea`、`.claude`、
  `.cursor`、`.codex`、`.zed`、`.mcp.json`、`.envrc`。

宿主只为命令真正受限运行的会话填写 `vars.sandboxWritableRoots`；沙箱关闭、平台没有沙箱，
或工作目录在 ShuviX 自己的数据目录里时，这个列表为空，产物之外的每次写入都照旧询问。

**它不做什么**：

- 只拦文件工具；命令由 ask-on-command 和沙箱管。
- 当你打开免询问的开关后，另一条内置的 session-grants 策略将生效并跳过询问。

**想调整**：创建覆盖副本后编辑调整。`match` 只留第一行，就回到「不论有没有沙箱，每次写入都问」。
