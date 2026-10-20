---
shuvix: policy v1
shuvix-id: policy:builtin:ask-on-command
shuvix-builtin: true
name: ask-on-command
shuvix-displayName: 未受限的命令执行前询问
description: 没有被圈进沙箱的 bash / PowerShell / ssh 命令逐条询问用户（分类模型很有把握地判为只读的除外）；圈在沙箱里的命令直接运行。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [command]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: "(!has(object.sandboxed) || !object.sandboxed) && !(has(object.risk) && object.risk.category == 'read_only' && object.risk.readOnly >= 0.9)"
    prompt: 这条命令没有受限——放行后它以你的完整系统权限运行，可读写任意文件、访问网络。放行前先看清它实际做什么。
---

**它做什么**：一条要以你的完整权限运行的命令，必须先问你。在 macOS 上开着沙箱时
（设置 → LLM 工具 → bash），命令默认在沙箱里运行 —— 只能读写本会话权限表里的路径（工作目录、
它的临时目录、artifacts 和工具结果、你授予的路径……；技能目录这类只读的行只能读），能读家目录以外的
系统位置，也能访问网络 —— 所以不问就直接运行。会询问的：

- 智能体放到沙箱外运行的命令（`dangerouslyDisableSandbox`）。沙箱只用来跑项目里的简单活；
  git、装依赖、要读家目录里配置或缓存的构建与工具、docker、`open`、`sudo`……本来就该到沙箱外跑、
  走到这里；
- 沙箱关着或这台电脑上用不了时（目前是 Windows 和 Linux，或者 ShuviX 自己跑在另一个沙箱里）的
  每一条命令；
- 每一条 ssh 命令 —— 它跑在远端机器上，本地的沙箱管不到。

选了分类模型时，以上任何一种里被分类器判为明摆着只读的命令都直接运行（见下）。

问不问看宿主为这次运行上报的 `sandboxed` 属性；如果你在「设置 → 通用」里选了分类模型，还看它的
分类：分类器把命令归为 `read_only`（只读）且概率不低于 0.9 时，直接运行，不问也不走自动审查
（`object.risk.category` / `object.risk.readOnly`）。没选分类模型，或者分类失败、超时、答案不完整，
客体上就没有 `object.risk`，照旧询问。分类器只判断这条命令是哪一类动作 —— 看不到脚本内容，也不知道你
让它做什么 —— 所以凡不是明摆着只读的都照样问。每一次分类都列在「设置 → 监控 → 分类器」里。

**除了文件边界，让受限命令出不去的**：它不能打开应用、发 Apple Events、提交计划任务
（`open`、`osascript`、`launchctl`），只能给自己起的进程发信号，只能连 ShuviX 自己的命令行
socket 和 DNS，连不上其他本地服务（Docker、ssh-agent……）。没有这几条，一条命令就能在沙箱外
起一个进程，文件边界也就形同虚设。

**它不做什么**：

- 询问是闸门：你一旦放行一条不受限的命令，它就以你的完整系统权限运行。
- 受限的命令仍然能改动工作目录里的任何东西，包括那里 git 自己的文件。
- 它不一定摆到你面前：开着自动审查时，审查 agent 先回答 —— 放行日常的工作，
  拒绝明显有害的，其余的附上它的意见交给你。

**想调整**：创建覆盖副本后编辑调整。删掉 `match` 那一行，就回到每条命令都询问；删掉 `object.risk`
那一段，选了分类模型也照样逐条询问；把 0.9 调高调低，就是改它要多有把握。
