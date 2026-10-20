---
shuvix: policy v1
shuvix-id: policy:builtin:network-admission
shuvix-builtin: true
name: network-admission
shuvix-displayName: 远程访问只允许本机
description: 远程访问开着时，只有这台电脑上的浏览器能连接；其他设备一律被拒，直到你用自己的 network-admission 替换这份策略。
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1'])"
    prompt: 这台 ShuviX 只接受来自它所在电脑的连接。要让这台设备连进来，请在那台电脑上（或经 SSH 隧道）打开 ShuviX，到 设置 → 通用 → 网络访问 里设置谁可以连接。
---

**它做什么**：远程访问让浏览器经网络使用 ShuviX —— 能做 ShuviX 在这台电脑上能做的一切，
而且没有密码。这份策略把它限制在这台电脑上的浏览器：发送方不是这台电脑（`127.0.0.1`
或 `::1`）的 HTTP 请求一律被拒，对方设备看到的是上面那句话，而不是 ShuviX。经 SSH
隧道进来的连接地址是 `127.0.0.1`，所以能进。

**要让其他设备连进来**：替换这份策略 —— 写一份你自己的
`~/.shuvix/policies/network-admission.md`（`name` 相同）。另写一份带 `allow` 规则的策略
不够：`deny` 压过一切 allow。设置 → 通用 → 网络访问 里有一个按钮，会开一个新会话并填好
提示词：agent 会问清哪些设备要连、每台能做什么，读 ShuviX 知识库的 `network-policy`
条目，然后写好这份文件。

**它不做什么**：

- 它不是密码。替换之后，谁能进由你的策略决定 —— 按地址、网段、设备，或请求带着的
  任何别的东西。
- 不管策略怎么写，有三道检查始终在：发送方必须在私有网络里（或就是这台电脑）、
  `Host` 头必须是 IP 地址或 `localhost` 加 ShuviX 的端口、WebSocket 必须来自 ShuviX
  自己提供的页面。
- 停用这份策略（而不是替换它）会让局域网里的每台设备都能连进来。
