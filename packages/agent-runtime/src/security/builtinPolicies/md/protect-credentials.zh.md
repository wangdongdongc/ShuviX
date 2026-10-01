---
shuvix: policy v1
shuvix-builtin: true
name: protect-credentials
shuvix-displayName: 保护部分凭据目录
description: 读取凭据目录需先询问；沙箱里的命令完全碰不到它们。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  credentialDirs: >-
    ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.shuvix/.session-state',
    'AppData/Local/Microsoft/Credentials',
    'AppData/Roaming/Microsoft/Credentials'].map(s, vars.home + '/' + s)
shuvix-policy-rules:
  - effect: ask
    action: [read]
    match: inDir(object.path, credentialDirs)
    prompt: 该路径存放凭据。读到的私钥或令牌会进入模型上下文，等同于把它交出去。
---

**它做什么**：对你的凭据位置（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.config/gh`、
`~/.netrc`，以及 `~/.shuvix/.session-state` —— ShuviX 加密你保存的 API Key 用的密钥）：

- **读取先询问** —— 读私钥等于泄露私钥，文件工具读取这些路径前要先问你。
- **沙箱里的命令读写都不行。** 命令沙箱的清单取自这条策略的 `credentialDirs`，
  在覆盖副本里改了清单，命令那边跟着变。

**它不做什么**：

- 只覆盖上面列出的路径。
- 不拒绝写入：往这里写是一次普通的写入，和工作目录之外的任何写入一样按 ask-on-write 询问。
- 在沙箱外运行的命令（沙箱关着或不可用，或智能体申请了完全访问）不逐个路径检查，
  而是整条命令按 ask-on-command 询问。
- 它不一定摆到你面前：开着自动审查时，审查 agent 先回答 —— 放行日常的工作，
  拒绝明显有害的，其余的附上它的意见交给你。

**想调整**：创建覆盖副本后编辑调整 —— 请慎重。
