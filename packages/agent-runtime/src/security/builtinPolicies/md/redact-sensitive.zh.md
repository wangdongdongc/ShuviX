---
shuvix: policy v1
shuvix-id: policy:builtin:redact-sensitive
shuvix-builtin: true
name: redact-sensitive
shuvix-displayName: 发给模型的敏感内容换成占位符
description: 新的工具结果、触发器和 hook 发的消息里的密钥和个人信息，以占位符存下并发给模型；工具和它写的文件里是真值。只对新产生的内容生效，不碰对话已有的内容。
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: allow
    action: [send]
    object.type: [modelRequest]
    disposition: detect
    prompt: 给模型的新内容都要脱敏。
  - effect: allow
    action: [disclose]
    object.type: [sensitive]
    match: "!(object.category in ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET'])"
    disposition: redact
    prompt: 密钥和个人信息以占位符存下并发给模型。
---

**作用**：工具结果、bot 触发器或 hook 发的消息写进对话之前，ShuviX 会认出其中的密钥和个人信息（API key、
令牌、私钥、密码、邮箱、手机号、身份证号、银行卡号……），存成 `{{REDACTED_API_KEY_k3v7x2mq}}` 这样的占位符；真值
加密存在这条会话自己的对照表里。工具执行时，参数里的占位符换回真值，命令照常工作、文件里写的是真实内容。对话里
存的就是模型收到的：发请求时不再改写任何内容。

**只对新内容生效**：这份策略只管从现在起新产生的对话内容，按对话当时在用的模型判定。**它不会处理历史对话记录**：
对话记录里已有的敏感信息照原样留着、继续照原样发出，之前的占位符也还是占位符，不管你这里怎么改、换成哪个模型。
想去掉已经发出去的内容，就开一条新会话。

- **规则 1**（`modelRequest`，`send`）：给每个模型的新内容都要脱敏（`detect`）；
- **规则 2**（`sensitive`，`disclose`）：认出的每一处存成占位符（`redact`）—— 除了四类：家目录里的用户名
  （`USERNAME`）、`user@host`（`HOSTNAME`）、公网 IP（`IP`）、云存储桶（`BUCKET`）。这四类几乎每个编程请求里都有，
  模型又必须原样抄写，所以照原样存、照原样发。

不检查的内容：你在输入框里打的字（用 + → 添加敏感信息自己藏）、别的会话发来的消息、agent 自己的回复、指令文件和
系统提示词。

**对象**：`object.provider` 是设置里显示的服务商名字，`object.model` 是模型 id。认出的一处有
`object.category`（上面那些类别）、`object.rule`（命中的检测规则）和 `object.value`（真值本身）。

**调整**——自己写一份策略，不要改这一份：

- 某个模型不脱敏（给它的新内容照原样存，不做检测）：`force-allow`，`action: [send]`、`object.type: [modelRequest]`，
  `match: "object.provider == '家里的服务器'"`；
- 某一类照发：`force-allow`，`action: [disclose]`、`object.type: [sensitive]`，
  `match: "object.category == 'EMAIL'"`；
- 测试 key 照发：同上，`match: "object.value.startsWith('sk-test-')"`；
- 某一类即使别的规则放行也存成占位符：`deny`，`match: "object.category == 'PRIVATE_KEY'"`；
- 用到还原后秘密的命令在沙箱外运行时只由你来回答（`ask-on-command` 本来就会问；`force-ask` 让自动审查
  不碰它）：`force-ask`，`object.type: [command]`，`match: "size(tool.restored) > 0 && !object.sandboxed"`。

不带 `disposition` 的 `force-allow` 压过这份策略的 `allow`，所以它命中的部分就不再脱敏。停用这份策略就关掉了
自动脱敏：新内容按真值存、按真值发。对话里已有的占位符还在，工具照样能还原。
