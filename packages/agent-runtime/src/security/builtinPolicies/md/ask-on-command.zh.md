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
LLM 工具 → bash），普通命令是受限运行的——只能改动 ask-on-write 本来就不问的地方
（项目、临时目录和工具缓存），碰不到 protect-credentials 列出的凭据，也跳不出沙箱——
所以直接运行、不再询问。仍然会询问的是：

- 智能体明确申请完全访问的命令，因为它在受限环境里跑不起来（打开应用、`osascript`、
  docker、`sudo`、新建 git 仓库、推送到私有远端……）；
- 沙箱关闭或在这台电脑上不可用时的每条命令（目前的 Windows 和 Linux，或 ShuviX 本身
  运行在另一个沙箱里）；
- 每条 ssh 命令——它在远端机器上运行，本地的沙箱管不到。

是否询问看宿主为这次执行报告的 `sandboxed` 属性，而不是看命令文本长什么样。

**是什么让受限命令跳不出去** —— 沙箱自己的围栏。没有它，一条命令就能布置好一样东西，
以后在沙箱外被执行，这里的其他检查也就都落空了：

- 不能写 git 自己的元数据（`.git/hooks`、`.git/config` ……）—— git 以及每个在后台跑
  `git status` 的编辑器都会执行它；
- 不能写 ShuviX 自己的文件（`~/.shuvix` 里除知识库、小组件、产物以外的部分，以及 ShuviX
  的应用数据）—— 这些策略、沙箱开关、Chrome 为扩展启动的程序都在里面；
- 只能连 ShuviX 自己的命令行 socket 和系统 DNS，连不上别的本地服务（Docker、ssh-agent ……）；
- 不能打开应用、跑 AppleScript、安排后台任务（`open`、`osascript`、`launchctl`），
  只能给自己启动的进程发信号；
- 工作目录或写授权覆盖了家目录时，干脆不套沙箱 —— 那里的每条命令都询问。

其余的有意放开：受限命令可以读凭据清单以外的任何文件，也可以访问网络。

**它不做什么**：

- 询问是闸门：你一旦放行一条不受限的命令，它就以你的完整系统权限运行。
- 受限的命令仍然能改动项目里的任何东西——删掉整个项目也在沙箱允许范围内。
  block-catastrophic-commands 照样拒绝它那几条毁掉整台机器的命令。
- 它不一定摆到你面前：开着自动审查时，审查 agent 先回答 —— 放行日常的工作，
  拒绝明显有害的，其余的附上它的意见交给你。
- 当你打开免询问的开关后，另一条内置的 session-grants 策略将生效并跳过询问，
  申请完全访问的命令也一样。

**想调整**：创建覆盖副本后编辑调整。删掉 `match` 那一行，就回到每条命令都询问。
