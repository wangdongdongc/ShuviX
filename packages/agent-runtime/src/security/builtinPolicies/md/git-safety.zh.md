---
shuvix: policy v1
shuvix-builtin: true
name: git-safety
shuvix-displayName: 重要 Git 操作执行前询问
description: 内置 git 工具的重要操作（init / restore / checkout --force / branch -d）执行前向你询问。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [gitTool]
shuvix-policy-rules:
  - effect: ask
    match: >-
      object.gitAction in ['init', 'restore']
      || (object.gitAction == 'checkout' && object.force)
      || (object.gitAction == 'branch' && object.delete)
    prompt: 这类 git 操作会丢弃未提交的改动或删除分支（init、restore、checkout --force、branch -d），应用内没有撤销。
---

**它做什么**：本策略只覆盖**内置 git 工具**。它的日常操作（add、commit、diff……）
在工作区内自由运行，但重要操作会先问你 —— 建仓（`init`）、吞掉改动（`restore`、
`checkout --force`）、删分支（`branch -d`）。

**它不做什么**：

- 通过命令跑的 `git` 命令**不归本策略管** —— 如果你允许了，智能体通过执行命令也可以执行任意 git 操作。
- 只拦上面列出的操作；git 工具的其余操作在工作区内不弹窗。
- 指向工作区之外目录的 git 工具操作，还会另走正常的路径询问。
- 当你打开免询问的开关后，另一条内置的 session-auto-allow 策略将生效并跳过询问。

**想调整**：创建覆盖副本后编辑调整
