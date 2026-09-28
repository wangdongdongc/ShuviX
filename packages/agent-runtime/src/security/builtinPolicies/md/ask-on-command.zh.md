---
shuvix: policy v1
shuvix-builtin: true
name: ask-on-command
shuvix-displayName: 未受限的命令执行前询问
description: 没有被圈进沙箱的 bash / PowerShell / ssh 命令逐条询问用户；圈在沙箱里的命令直接运行。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: '!has(object.sandboxed) || !object.sandboxed'
    prompt: 这条命令没有受限——放行后它以你的完整系统权限运行，可读写任意文件、访问网络。放行前先看清它实际做什么。
---

**它做什么**：会以你完整权限运行的命令，需要先向你询问。macOS 上开着沙箱时（设置 →
LLM 工具 → bash），普通命令是受限运行的——只能改动项目、临时目录和工具缓存里的文件，
读不到凭据和你的个人资料目录——所以直接运行、不再询问。仍然会询问的是：

- 智能体明确申请完全访问的命令，因为它在受限环境里跑不起来（打开应用、`osascript`、
  docker、`sudo`、新建 git 仓库、推送到私有远端……）；
- 沙箱关闭或在这台电脑上不可用时的每条命令（目前的 Windows 和 Linux，或 ShuviX 本身
  运行在另一个沙箱里）；
- 每条 ssh 命令——它在远端机器上运行，本地的沙箱管不到。

是否询问看宿主为这次执行报告的 `sandboxed` 属性，而不是看命令文本长什么样。

**它不做什么**：

- 询问是闸门：你一旦放行一条不受限的命令，它就以你的完整系统权限运行。
- 受限的命令仍然能改动项目里的任何东西——删掉整个项目也在沙箱允许范围内。
  block-catastrophic-commands 照样拒绝它那几条毁掉整台机器的命令。
- 它不一定摆到你面前：开着自动审查时，审查 agent 先回答 —— 放行日常的工作，
  拒绝明显有害的，其余的附上它的意见交给你。
- 当你打开免询问的开关后，另一条内置的 session-grants 策略将生效并跳过询问，
  申请完全访问的命令也一样。

**想调整**：创建覆盖副本后编辑调整。删掉 `match` 那一行，就回到每条命令都询问。
