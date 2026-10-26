---
shuvix: policy v1
shuvix-id: policy:builtin:redact-sensitive
shuvix-builtin: true
name: redact-sensitive
shuvix-displayName: 发给模型的敏感内容换成占位符
description: 密钥和个人信息以占位符发给模型；agent 的工具、它写的文件和你看到的仍是真值。
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: allow
    action: [send]
    object.type: [modelRequest]
    disposition: detect
    prompt: 发给模型的每个请求都经过脱敏。
  - effect: allow
    action: [disclose]
    object.type: [sensitive]
    match: "!(object.category in ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET'])"
    disposition: redact
    prompt: 密钥和个人信息以占位符发给模型。
---

**作用**：任何内容写进对话记录之前，ShuviX 会认出其中的密钥和个人信息（API key、令牌、私钥、
密码、邮箱、手机号、身份证号、银行卡号……），存成 `{{REDACTED_API_KEY_k3v7x2mq}}` 这样的占位符；真值加密
存在这条会话自己的对照表里。工具执行时，参数里的占位符换回真值，命令照常工作、文件里写的是真实内容；
界面上在那个位置显示一个标记。模型收到什么由这份策略决定：

- **规则 1**（`modelRequest`，`send`）：发给模型的每个请求都适用脱敏（`detect`）：ShuviX 还会在
  对话记录之外的内容里（指令文件、系统提示词）再找一遍；
- **规则 2**（`sensitive`，`disclose`）：认出的每一处保持占位符（`redact`）—— 除了四类：家目录里的
  用户名（`USERNAME`）、`user@host`（`HOSTNAME`）、公网 IP（`IP`）、云存储桶（`BUCKET`）。这四类
  几乎每个编程请求里都有，模型又必须原样抄写，所以按原样发出，对话记录里也照原样存。

**对象**：`object.provider` 是设置里显示的服务商名字，`object.model` 是模型 id。认出的一处有
`object.category`（上面那些类别）、`object.rule`（命中的检测规则）和 `object.value`（真值本身）。

**调整**——自己写一份策略，不要改这一份：

- 信任某个模型（它看到真值，不做检测）：`force-allow`，`action: [send]`、`object.type: [modelRequest]`，
  `match: "object.provider == '家里的服务器'"`；
- 某一类照发：`force-allow`，`action: [disclose]`、`object.type: [sensitive]`，
  `match: "object.category == 'EMAIL'"`；
- 测试 key 照发：同上，`match: "object.value.startsWith('sk-test-')"`；
- 某一类绝不发（整个请求不发）：`deny`，`match: "object.category == 'PRIVATE_KEY'"`；
- 用到还原后秘密的命令在沙箱外运行时只由你来回答（`ask-on-command` 本来就会问；`force-ask` 让自动审查
  不碰它）：`force-ask`，`object.type: [command]`，`match: "size(tool.restored) > 0 && !object.sandboxed"`。

不带 `disposition` 的 `force-allow` 压过这份策略的 `allow`，所以它命中的部分就不再脱敏。停用这份
策略后，发给所有模型的都是真值；对话记录里存的仍是占位符。
