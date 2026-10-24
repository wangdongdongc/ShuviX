---
shuvix: okf v0.2
type: Guide
title: '远程访问的策略 —— 谁能连进来、每台设备能做什么'
description: '怎样给 ShuviX 的远程访问写安全策略：network 主体与请求带来的每一项事实、四个点位（socket、request、channel、path）、按 scope（管哪一块，15 个）与 access（read / write / admin）写细粒度的规则、`inCidr`、为什么 `ask` 会拒绝、内置的 `network-admission` 与怎样替换它、常见需求的写法、装之前用 `shuvix policy check` 核对草稿，以及策略做不到的事（没有认证、设备 ID、SSH 隧道、经由 agent 绕过）。'
tags: [shuvix, policy, security, network, remote-access]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/frontend/network/policyGate.ts
    title: policyGate.ts —— 点位与它们上报的事实
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/network-admission.md
    title: network-admission.md —— 内置的准入策略
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/shared/channelAccess.ts
    title: channelAccess.ts —— 每条通道的 scope 与访问级别，按 key 定的设置项
---

# 远程访问的策略

**远程访问**（设置 → 通用 → 网络访问，或 `shuvix --headless`）让浏览器经网络使用 ShuviX —— 能做 ShuviX
在这台电脑上能做的一切，而且**没有密码**。ShuviX 自己只做三道写死的检查：发送方必须在私有网络里（或就是这台
电脑）、`Host` 头必须是 IP 地址或 `localhost` 加 ShuviX 的端口、WebSocket 必须来自 ShuviX 自己提供的页面。
**其余全是安全策略**，写在与管 agent 的那些门同一种策略文件里（完整格式见 `policy-md` 条目）。没有别的访问
控制；没有策略就是没有限制。

ShuviX 只出厂一份网络策略 `network-admission`：**只有这台电脑能连接**。要让其他设备进来，就替换它。

## 与用户配合

用户请你设置远程访问时：

1. 一轮问清你需要的：会有哪些设备连进来（手机、笔记本、一整个网段？）、经什么方式 —— 同一局域网、SSH
   隧道、VPN；每台设备需要做什么 —— 能碰哪几块（会话、文件、终端、设置……，见「scope 与 access」）、每块到哪一档
   （只看、能改、能管）；怎样认出每台设备 —— 按地址、按网段，还是按设备 ID（见下）。不要猜地址。
2. 先在**你的工作目录里写草稿**，文件名就是装进去时的名字 —— `network-admission.md`（**同名**才能替换内置那份；
   `deny` 压过一切 allow，另写一份策略放不开它）。更多限制可以写在同一份文件里，也可以写成别的策略。不要直接写进
   `~/.shuvix/policies/`：那里的策略几秒内生效，写错的准入策略会把用户正在和你对话的那台设备当场断开。`write` 的
   结果会说这份文件解析过没过、列出解析器的警告。
3. **核对草稿**：`shuvix policy check network-admission.md`（bash）。它按「装进去之后」判，打印一张表 —— 这台电脑、
   连着的与最近被拒的设备、一个外网地址 × 页面 / 读 / 写 / 管理 —— 拒绝的格子后面标着是哪条规则。拿**每一行**
   对照用户的要求。规则写在 scope 上时再加 `--scopes`：每个 scope 一行、每台设备一列，格子是 read / write / admin
   三档各自的结果（这一档的每一条调用都判一遍）—— 拿每一格对照用户说的「这台设备能碰哪几块、到哪一档」；只给一台
   设备时加 `--from <ip>`（或 `--device <id>`）。表上没有的（还没出现过的设备、某个具体通道、某项设置、某个文件
   路径）逐个查：
   `shuvix policy check network-admission.md --from 192.168.1.23 --channel agent:prompt --expect allow`
   （按设备认的加 `--device <id>`；还有 `--setting <key>`、`--page`、`--read`、`--write`）。改**规则**，直到每一行、
   每一格、每个期望都对上；这台电脑必须一直是 `allow`。`shuvix policy check --help` 列出全部参数。
4. 装上：把同样的内容写进 `~/.shuvix/policies/network-admission.md`（别的策略文件放在它旁边），再不带文件跑一次
   `shuvix policy check`，确认此刻生效的就是它。
5. 用大白话逐条讲规则，说清它**防不住**什么（见最后两节），告诉用户怎么核对（见「核对」）。

绝不要把密码或令牌写进策略，也绝不要说结果「安全」了：这是没有认证的访问控制。

## 请求文档

每一次网络检查都是一个 `subject.kind` 为 `network` 的请求。除了主体的固定字段，网络主体还带着下面这些属性 ——
**每一次检查都给齐**，还拿不到的给空值（socket 检查时还没有请求头）：

| `subject.` 属性 | 类型   | 含义                                                                 | 可信                                 |
| --------------- | ------ | -------------------------------------------------------------------- | ------------------------------------ |
| `address`       | string | 发送方的 IP 地址（IPv4 映射的 IPv6 写成 IPv4）                       | 是 —— 来自 TCP 连接                  |
| `port`          | int    | 发送方的端口                                                         | 是                                   |
| `localAddress`  | string | 连接进来的、这台电脑的地址                                           | 是                                   |
| `localPort`     | int    | ShuviX 的端口                                                        | 是                                   |
| `family`        | string | `ipv4` 或 `ipv6`                                                     | 是                                   |
| `interface`     | string | `localAddress` 所在的网卡（`en0`、`eth1`）；不知道时为 `''`          | 是                                   |
| `headers`       | map    | 全部请求头，名字小写；同名多值以 `, ` 连接；HTTP 之前为 `{}`         | **否** —— 浏览器（或任何人）自己写的 |
| `cookies`       | map    | 请求带的 cookie                                                      | **否**                               |
| `device`        | string | 浏览器的设备 ID（见下）；浏览器还没有时为 `''`                       | **否** —— 见「设备 ID」              |
| `userAgent`     | string | `User-Agent` 头                                                      | **否**                               |
| `connection`    | string | channel 与文件通道检查时是那条 WebSocket 连接（`ws:7`）；其余为 `''` | 是                                   |

`env.host` 是 `desktop`（无头运行也是）。`vars` 里是 `policy-md` 条目那张表中与会话无关的宿主变量 —— `home`、
`shuvixConfigDirs`、`botsDir`、`skillsDirs` …… —— 没有会话权限表（`aclRead` / `aclWrite`）。

### 四个点位

| 时机                              | `object.type` | `action`         | 客体属性                                                                                                 | 被拒时                                    |
| --------------------------------- | ------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| TCP 连接刚建立、HTTP 还没读       | `socket`      | `connect`        | 无                                                                                                       | 连接直接关掉，什么也不回                  |
| 每个 HTTP 请求，含 WebSocket 升级 | `request` | `request` | `method`、`path`（URL 路径）、`query`（map，同名取第一个）、`route`（见下）、`scope`、`access` | HTTP 403，正文是规则的 `prompt` 与设备 ID |
| WebSocket 上的每一次调用 | `channel` | `invoke` | `channel`（`agent:prompt`）、`group`（`agent`）、`scope`、`kind`（`invoke` / `send`）、`access`、`size`、`args` | 调用失败，错误码 `denied`，带 `prompt` |
| 网络读写的一个文件 | `path` | `read` / `write` | `path`（真正通向的位置）、`requestedPath`、`displayPath`、`scope`（恒为 `files`）、`access`（同 `action`）；`tool.name` / `tool.operation` 见下 | 403，或文件不显示 / 不保存 |

`route` 取值：`page`（`/`）、`asset`（页面的脚本与样式）、`media`、`preview`、`download`（文件路由）、`lib`
（图表库）、`widget`（`/w/…`）、`socket`（每个页面都会发起的 `/ws` 升级）。`path` 检查覆盖文件路由（`tool.name`
为 `files`，`tool.operation` 为 `media` / `preview` / `download`），以及能读写磁盘上任意文件的几条通道：
`files:read` / `files:write`（`files`，`read` / `write`）与 `fs:listDirectories`（`fs`，`listDirectories`）。
ShuviX 本身不限制这些路径。

`scope` 与 `access` 见下一节。`args` 是这次调用原样发来的参数（一个列表）；读它会把规则绑在 ShuviX 的内部 API
上，而它在版本之间会变 —— 规则写在 `scope` 与 `access` 上，要开个别例外时点名 `channel`。

## scope 与 access：管哪一块、到哪一档

除了 socket，每次检查的客体都带两个事实：`object.scope` —— 这次请求管的是 ShuviX 的**哪一块**；`object.access` ——
做到**哪一档**。细粒度的规则都写在这两个上：「这台设备只能碰 sessions」「preferences 能改、security 只能看」。以后
版本新加的通道也会归进某个 scope、带上某一档，照样被这样的规则管住；一张通道名单会漏掉它们。

### 15 个 scope

scope 按**它管的是什么**分，不按它在设置页的哪个 tab（「通用」里同时有外观、默认模型、命令分类器、网络访问）。

| `scope` | 管什么 | 界面上在哪 |
| --- | --- | --- |
| `app` | 页面每次加载都要的读取（设置值、字段说明、版本）与应用外壳（窗口、右键菜单、通知、悬浮聊天） | 处处 |
| `sessions` | 会话列表与内容、和 agent 对话（发消息、中止、回答询问卡）、子会话、后台任务、斜杠命令、日历与日报 | 侧栏会话、聊天区、日历 |
| `projects` | 项目的建、改、删、列 —— 项目带着环境变量，所以列项目是 `admin` | 侧栏项目、项目设置 |
| `files` | 工作目录里文件的列、读、写、预览、下载，笔记本，Artifacts，目录浏览 | 文件树、预览、笔记本 |
| `terminal` | 终端（只有 `write` 一档） | 底部终端面板 |
| `browser` | 内置浏览器：标签页、浏览、截图、DevTools、站点数据与 Cookie、证书例外；它的设置项 | 内置浏览器，设置 → MCP → browser |
| `widgets` | Widgets 的列、开、改名、归档、删、导出，独立窗口 | 侧栏 Widgets，设置 → 已归档 |
| `knowledge` | 知识库与条目的列、建、开 | 侧栏知识库，输入框里的 @ |
| `agents` | 智能体档案与 Bot，默认智能体 | 侧栏智能体 / Bots |
| `extensions` | 工具列表、MCP 服务器、技能、数据库连接、Chrome 扩展 | 设置 → LLM 工具 / MCP，侧栏技能 |
| `models` | 提供商（含 API key 与订阅登录）、模型、默认模型与思考档位；`read` 只是模型列表，不含 key | 设置 → 提供商，通用 → 默认模型，输入框的模型选择 |
| `security` | 安全策略、hooks（自动审查是一个 hook）、会话权限表、命令沙箱、命令分类器、远程访问本身 | 侧栏安全策略 / Hooks，设置 → 通用 → 网络访问，LLM 工具 → bash |
| `preferences` | 外观、语言、字号、缩放、通知开关、语音与 TTS | 设置 → 通用（外观部分）、语音 |
| `telegram` | Telegram Bot 的登记与改删 | 设置 → Telegram Bot |
| `system` | 应用更新、配置导入导出、监视器日志（LLM 请求日志、分类器日志） | 设置 → 关于、监视器 |

每个 scope 含哪些通道、哪些 HTTP 路由、哪些设置项，逐条列在 `network-channels` 条目里。

### 三档 access

- `read` —— 看，不含机密，没有副作用。
- `write` —— 改用户的数据，或让事情发生：给 agent 发消息、建删会话、写文件、用终端、换主题。
- `admin` —— 改 ShuviX 本身（安全策略、hooks、agent、模型服务、MCP、网络访问、更新……），或者返回值带机密（API
  key、项目环境变量、Cookie）。

三档是三类，**不是一档包含一档**：放开 `admin` 不等于放开 `write`，每档单独判。HTTP 请求：GET / HEAD / OPTIONS 是
`read`，别的方法是 `write`。文件读写（`path`）的 `access` 就是它的 `action`。

### 按这一次调用定的两处

- **`settings:set`（改一项设置）按要改的 key 定**：只影响外观和个人习惯的是 `write`；改变 agent 能做什么、花谁的钱、
  连到哪、谁能进来的是 `admin`。

  | key | `scope` | `access` |
  | --- | --- | --- |
  | 主题、语言、字号、缩放（`general.theme`、`general.language` ……），`appearance.*`、`notification.*`、`voice.*` | `preferences` | `write` |
  | `browser.*`（地址栏的搜索引擎等） | `browser` | `write` |
  | `tool.browser.*`（内置浏览器忽略证书错误） | `browser` | `admin` |
  | 默认提供商、默认模型、默认思考档位 | `models` | `admin` |
  | 默认智能体 | `agents` | `admin` |
  | `sandbox.*`、命令分类器（`general.classifierProvider` / `general.classifierModel`）、`network.*` | `security` | `admin` |
  | `httpLog.*`、`updates.*`，以及不认识的 key | `system` | `admin` |

  完整的表在 `network-channels` 条目。查一项：`shuvix policy check <草稿> --from <ip> --setting general.theme`。
- **回答询问卡时勾了「允许并记住」**（`agent:respondToInput`）会往会话权限表里加一行，所以按 `security` + `admin`
  判；不勾时是 `sessions` + `write`。

### 写的时候

- 读 `object.scope` / `object.access` 的规则要写 `object.type: [request, channel, path]`（或其中几个）：socket 点位
  还没有这两个事实，读它会出错，而出错的 `deny` 按命中算。
- **别拒 `app` 的 `read`**：没有它页面打不开。想让一台设备完全进不来，拒它的 `request`（准入）。
- 在 `deny` 的 `match` 里：`object.access != 'read'` 拒掉「能改的」；`!(object.scope in [...])` 拒掉「这几块以外的」；
  `object.access != 'read' && !(object.scope in [...])` 就是「这几块能改，别的只能看」。
- `object.group`（通道的技术分组，如 `agent`、`provider`）与 `object.channel` 也在，用来开个别例外；分组随版本会变，
  规则的主体写在 scope 上。

## 网络检查上的效力

网络点位上没有人可问。引擎照对 agent 那样结算（deny > force-ask > force-allow > ask > allow；没有规则 =
allow），然后把结算为 `ask` 或 `force-ask` 的请求当作**拒绝**。请直接写 `deny` —— `subject.kind` 只有
`network` 的 `ask` 规则，解析器会给警告。`force-allow` 照样压过 `ask`，与别处一样。

`match` 求值出错的规则，对 `deny` 按命中算（fail-safe），所以一个马虎的表达式会拒掉一切。最常见的原因是缺键：
请求没带某个头时 `subject.headers['x-real-ip']` 会报错 —— 写成 `'x-real-ip' in subject.headers && …`。
`has()` 在下标之后不起作用（`has(object.args[0].x)` 是错误）。

## 写出能算的规则

`match` 求值出错的 `deny` 会拒掉它管的**每一个**请求 —— 包括这台电脑自己。三个习惯能避免：

- **把这台电脑放在最前面，用 `&&` 连接：** `!inCidr(subject.address, ['127.0.0.0/8', '::1']) && …`。对这台
  电脑左边为假，后面根本不会算，写错了也不会把它关在外面。
- **`lets` 只看得到 `vars`。** 读了 `subject`、`object`、`action`、`tool` 或 `env` 的 let 会让整份文件非法。
  常量（`phone: "'Xq3…'"`、一组网段）放进 `lets`；凡是关于请求的条件写进规则的 `match`。
- **看 `write` 的结果。** 对每条管 `network` 主体的规则，解析器会拿它覆盖的每种请求的样例试算 `match`；
  出现「the match fails on a sample … request」就表示这条规则会拒掉它管的一切。收尾之前改好它。

## `inCidr(ip, cidrs)`

`ip` 落在 `cidrs` —— 一个字符串，或由 `a.b.c.d/n`、`x::/n`、单个地址组成的列表 —— 中的任一个里时为真。IPv4
映射的 IPv6 按 IPv4 算；格式不对的项永不命中，`ip` 不是地址时也不命中。

```
inCidr(subject.address, ['127.0.0.0/8', '::1'])                  # 这台电脑
inCidr(subject.address, ['192.168.1.0/24', '10.8.0.0/16'])       # 两个网段
inCidr(subject.address, '192.168.1.23')                          # 一个地址
```

## 内置的 `network-admission`

```yaml
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1'])"
```

其他设备的每个 HTTP 请求都被拒，对方看到一页告诉他该怎么办；SSH 隧道进来的地址是 `127.0.0.1`，能进。用一份同
`name` 的用户文件替换它（侧栏的「创建覆盖副本」会把当前文本写出来当起点）。解析失败的替换文件什么也替换不了 ——
内置那份照样拒人 —— 它会以琥珀色列在侧栏「安全策略」里。停用内置那份（而不是替换它）会让局域网里每台设备都能
进来。设置 → 通用 → 网络访问会显示此刻生效的是哪一份。

## 常见需求的写法

每段都是 `~/.shuvix/policies/network-admission.md` 的 frontmatter（再加上 `shuvix: policy v1` 与
`name: network-admission`）。始终把这台电脑留在里面（`127.0.0.0/8`、`::1`）。

**一个或几个网段：**

```yaml
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1', '192.168.1.0/24', '10.8.0.0/16'])"
    prompt: 只有这台电脑与家里、VPN 网段里的设备能连接。
```

**指定的设备。** 浏览器第一次来、哪怕被拒，也会拿到一个设备 ID，拒绝页上会显示它（`Device: …`）；设置 →
网络访问里也列着连着的与最近被拒的设备的 ID。向用户要这些 ID，然后：

```yaml
shuvix-policy-scope:
  subject.kind: [network]
  object.type: [request]
shuvix-policy-rules:
  - effect: deny
    action: [request]
    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && !(subject.device in ['Xq3…', 'Pb9…'])"
    prompt: 这台设备不在名单上。请让主人把它的设备 ID 加进去。
```

下面几段是加在准入规则后面的规则（同一个 `shuvix-policy-rules` 列表里，或另一份策略）。每段先在 `match` 里认出
设备，再按 scope 与 access 判。

**只读的设备** —— 一条规则管住三个点位：能改的通道、文件写入、widget 的写请求：

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [network]
    object.type: [request, channel, path]
    match: "inCidr(subject.address, '192.168.1.0/24') && object.access != 'read'"
    prompt: 这台设备只能看。
```

页面为了显示东西也会调几条非 `read` 的通道（打开会话时的 `agent:getInfo` 之类）；只读设备的页面不对劲时，看「最近
被拒」，在 `match` 里把那些通道名排除掉（`&& !(object.channel in ['…'])`）。项目列表（`projects` 的 `admin`）
带着环境变量的值：只有这些值可以被看见时才放开它。

**只能和 agent 对话的手机** —— 只给 `app` 与 `sessions`：

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [network]
    object.type: [request, channel, path]
    match: "inCidr(subject.address, '192.168.1.23') && !(object.scope in ['app', 'sessions'])"
    prompt: 这台手机只能和 agent 对话。
```

它看不到文件、终端、设置，但「能和 agent 对话」本身就是很大的权力（见「策略做不到的事」）。要让它在输入框里换
模型，再放开 `models` 的 `read`（只是模型列表）：把 `match` 的后半写成
`!(object.scope in ['app', 'sessions'] || (object.scope == 'models' && object.access == 'read'))`。

**几块能改、别的只能看** —— 家里的平板可以用会话、文件、知识库，能换外观，别的只能看：

```yaml
shuvix-policy-rules:
  - effect: deny
    subject.kind: [network]
    object.type: [request, channel, path]
    match: "inCidr(subject.address, '192.168.1.0/24') && object.access != 'read' && !(object.scope in ['app', 'sessions', 'files', 'knowledge', 'preferences'])"
    prompt: 这台设备在这里只能看。
```

**受限的设备不能改规则。** 凡是不完全信任的设备，都要拒绝 `security` 这一块与一切 `admin`，**以及**往 ShuviX 自己的
目录里写文件 —— 否则它能经 `files:write` 改写这份策略本身（文件写入的 scope 是 `files`，不是 `security`）：

```yaml
- effect: deny
  subject.kind: [network]
  object.type: [request, channel]
  match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && (object.scope == 'security' || object.access == 'admin')"
  prompt: 只有这台电脑能改安全设置与 ShuviX 的配置。
- effect: deny
  subject.kind: [network]
  object.type: [path]
  action: [write]
  match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && (inDir(object.path, vars.shuvixConfigDirs) || inDir(object.path, vars.botsDir))"
```

`object.scope == 'security'` 连看都拒（策略列表、会话权限表）；只想拒「改」时写
`object.scope == 'security' && object.access != 'read'`。

**照用户说的写，不多也不少。** 不要替用户加他没提的限制：用户说某台设备「什么都能做」，它就不是受限的设备，不要替它
加上面这两条（也不要拒它的 `admin`）；用户没说按设备 ID 认，就不要要求设备 ID；用户说能用的部分（会话、终端、选模型……）
一样都不能拒。担心风险就在讲规则时说出来，由用户决定；规则只写用户要的。

**只给一个文件夹里的文件：** 拒绝它以外的 `path` 读取（`!inDir(object.path, [vars.home + '/Shared'])`）。别处
文件的预览随之失效。

## 策略做不到的事

- **它不是认证。** 同一网络里谁都能占用一个地址；请求头、cookie 与 user agent 是发送方想写什么就写什么。
  **设备 ID** 是 ShuviX 放进 cookie（`shuvix_device`，浏览器对同一地址的每个请求都会自动带上）发给每个浏览器的
  随机值：它能认出一个浏览器，但能看到流量（明文 HTTP）或能用那个浏览器的人都能抄走它。清除网站数据或在无痕窗口
  里它会变，同一个浏览器对 `127.0.0.1` 与局域网地址也是两个不同的 ID。
- **SSH 隧道看起来就是这台电脑**：每条经隧道的连接都来自 `127.0.0.1`，按地址分不出是谁。
- **agent 是一条绕过的路。** 能调 `agent:prompt`（或 `agent:respondToInput` —— 回答 agent 的询问卡）的设备，能让
  agent 在这台电脑上做 agent 自己的策略允许的任何事。管 agent 的策略不知道消息是哪台设备发的。把「能和 agent
  对话」当作完全控制。
- **策略决定请求放不放行，不过滤它返回什么。** 允许调 `session:list` 的设备能看到每一条会话；能打开页面的设备
  都读得到全部设置值（`settings:getAll` 在 `app` 里；设置表里没有机密）。
- 公网地址永远连不进来（写死的私有网络检查在前），包括 Tailscale 的 `100.64.0.0/10` 这类 VPN 网段。

## 核对

- `shuvix policy check [<文件>]`（见「与用户配合」）：谁进得来、每台能做什么的一张表，与真实请求同一个引擎、
  同一套策略。标着 `ERROR` 的格子是求值出错的规则（表下列出原因）—— 它会拒掉每一个这样的请求。加 `--scopes`
  是每个 scope × 每台设备的矩阵：`r` / `w` / `a` 是这一档全放行，`-` 是全拒，`~` 是有放有拒（表下列出被拒的调用），
  `.` 是这个 scope 没有这一档，`E` 是有规则求值出错。
- 设置 → 通用 → 网络访问显示 `network-admission` 的状态、连着的浏览器与它们的设备 ID，以及**最近被拒**：什么被拒、
  它的 scope、从哪来、哪条规则 —— 看策略起没起作用最快的办法。
- 在那台设备上打开地址：被拒的请求会显示规则的 `prompt`、设备 ID 与地址。
- 改动几秒内生效；新规则拒绝的、已经连着的浏览器会被断开。
