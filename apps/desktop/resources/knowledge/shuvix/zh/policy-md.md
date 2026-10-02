---
shuvix: okf v0.2
type: Guide
title: '安全策略文件（shuvix: policy v1）'
description: 'ShuviX 安全策略的完整规范 —— 规则看到的请求文档（subject / action / tool / object / env / vars）、五个条件键、CEL `match`、效力及其优先序、询问由谁回答（先自动审查、再你）、`lets`、什么会让文件非法、两份内置策略，以及怎样放宽一道门或加一道自己的门。'
tags: [shuvix, policy, security, format, spec, cel]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/policyFile.ts
    title: policyFile.ts —— 解析器（事实源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/celMatch.ts
    title: celMatch.ts —— CEL 环境、`inDir`、`hasShortFlags`、strict 语义
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md
    title: 内置策略，一种语言一份 md
---

# 安全策略文件

ShuviX 的权限系统是**询问模型，不是沙箱**。每次工具调用都在进程内对照一组规则，得到
**放行 / 询问 / 拒绝**之一，而规则是用户能读、能覆盖、能删除的 markdown 文件。第一原则是
**无策略 = 放行**：命中不了任何规则的操作自由执行；ShuviX 自带的每道防护都是一份看得见的策略。
策略本身不是操作系统级隔离，那是另一样东西——**命令沙箱**：macOS 上开着设置 → LLM 工具 → bash →
沙箱时，每条 `bash` 命令由操作系统圈住运行。它把文件访问收进本会话自己的目录（工作目录、它的临时目录、
它的 artifacts 和工具结果、给它勾选的知识库，加上你「允许并记住」的路径）：受限的命令能在那里读写，
能读技能目录和 ShuviX 说明书，能读家目录以外，别的都不行。它也打不开应用、不能给别的进程发信号、
连不上 Docker 这类本地服务。git、装依赖、构建，
以及其他要读家目录里配置或缓存的工具，本来就该到沙箱外跑。宿主把这次执行是否真的被圈住作为命令的
`sandboxed` 属性上报，内置策略据此判断：圈住的命令直接运行；没圈住的——沙箱关闭或不可用、智能体申请了
完全访问、每条 `ssh` 命令——要询问，放行后以用户的完整权限运行。

`ask` 并不直接交给用户。开着**自动审查**时（设置 → 通用 → 安全，缺省开），一个审查 agent 先回答它 —— 它在独立
的上下文里只看用户写的东西和操作本身：放行日常的工作，拒绝明显有害的，其余的摆到用户面前，并把自己的
意见附在卡片上。审查员是过滤器，不是边界 —— 边界是沙箱，以及你自己写的 `deny` 规则。`force-ask` 永远交给用户。审查员
就是内置 hook `auto-review` 与 agent `permission-reviewer`；它看得到什么、怎么改，见 `hook-md` 条目。

- 位置：`~/.shuvix/policies/<name>.md`。
- 标记：`shuvix: policy v1`；读取可选，写出恒带。
- 存在即生效，会话装配规则时重新读取。`name` 与内置同名的用户文件**取代**它；非法的用户文件永远不
  遮蔽内置。

## 示例

```markdown
---
shuvix: policy v1
name: protect-drafts
shuvix-displayName: 草稿永不覆盖
description: agent 对 ~/Documents/drafts 下的文件只能读、不能写。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [path]
  env.host: [desktop]
shuvix-policy-lets:
  drafts: "[vars.home + '/Documents/drafts']"
shuvix-policy-rules:
  - effect: deny
    action: [write]
    match: inDir(object.path, drafts)
    prompt: 写入被拒 —— 草稿目录对 agent 只读；要改的话，请用户先把文件移出来。
---

**它做什么**：`~/Documents/drafts` 下的任何写入都被拒绝，即使答过「允许并记住」也一样。
正文只是写给人看的说明 —— 引擎从不读它。
```

## frontmatter 键

| 键                      | 类型                        | 必填   | 含义                                                                                                                                                                                                     |
| ----------------------- | --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`                | `policy v1`                 | 否     | 文件类型标记。                                                                                                                                                                                           |
| `name`                  | 字符串                      | 否     | 身份（覆盖按它匹配）。缺省取文件基础名。                                                                                                                                                                 |
| `shuvix-displayName`    | 字符串                      | 否     | 侧栏「安全策略」分组与询问卡片上的标签。缺省 = `name`。                                                                                                                                                           |
| `description`           | 字符串                      | 否     | 列表里的一句话。                                                                                                                                                                                         |
| `shuvix-policy-scope`   | 映射                        | 否     | 本策略**每条规则**共用的条件（AND 进每一条）。键与规则条件相同。某条规则自己的条件与 scope 矛盾（交集为空）会让文件非法。                                                                                   |
| `shuvix-policy-lets`    | 映射 名字 → CEL 字符串      | 否     | 从 `{vars}` 算一次的具名值，以顶层名字注入每条规则的 `match`。名字必须是标识符，且不能是 `subject`、`action`、`tool`、`object`、`env`、`vars` 或 `inDir`。惰性求值，用到才算。                                |
| `shuvix-policy-rules`   | 规则列表                    | **是** | 引擎唯一评估的东西。可以是空列表（用 `[]` 覆盖即关掉一道内置门）。                                                                                                                                       |

裸的 `rules:`、`lets:`、`scope:` 键让文件非法 —— 写错的键名不能静默变成「没有规则」。其他不带前缀的
未知键忽略。

### 一条规则

| 规则键                                                         | 含义                                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `effect`                                                       | **必填**：`allow`、`force-allow`、`ask`、`force-ask` 或 `deny`。                                                                                                               |
| `subject.kind`、`action`、`object.type`、`env.host`、`tool.name` | 结构化条件：字符串或字符串列表（列表内 OR，键之间 AND）；`'*'` = 任意；空列表或空串非法。**`subject.kind` 必填**，写在规则上或 scope 里 —— 要「任意主体」就有意地写 `'*'`。            |
| `match`                                                        | 可选的 CEL 表达式，对请求文档（见下）求值，与条件 AND。语法错让文件非法。                                                                                                        |
| `prompt`                                                       | 可选的一句话。`ask` 时显示在询问卡片上；`deny` 时作为拒绝原因回给 agent；放行类规则只在策略的属性卡上显示。最长 1000 字符。唯一永远不会让文件非法的键。                                    |

规则里出现任何别的键都让文件非法（包括旧的嵌套 `object:` / `subject:` / `when:` 匹配器）。

### 效力与优先序

所有策略里命中的全部规则中，最强的效力胜出：

```
deny  >  force-ask  >  force-allow  >  ask  >  allow  >  （什么都没命中 = allow）
```

- `ask` 先把这次调用交给自动审查，审查答不了才摆到用户面前；`allow` 直接放行；`deny` 拒绝（agent 收到
  `prompt` 作为原因）。
- `force-allow` 是压得过一切 `ask` 的放行 —— 不动发问的那份策略、给某一处免去询问，就用它。
  `force-allow` 不经过审查员。
- `force-ask` 是连 `force-allow` 也跳不过、而且只由用户回答的询问，它的卡片上也没有「允许并记住」——
  「这道门既不接受豁免，也不接受审查员」。
- `deny` 压过一切。

条件编译成原生谓词，在 CEL **之前**求值，所以条件不命中的规则永远不会跑它的 `match`，也不会触发该策略
的 `lets`。

## 请求文档

每次检查是一份五段式请求；`match` 看到的是：

```
subject  { kind: 'agent' | 'user', agentKind: 'root' | 'spawned', profile: <agent 名>, sessionId, depth }
action   'read' | 'write' | 'execute'
tool     { name: <工具名>, operation: <工具特定的操作，没有则为 ''> }
object   { type: <客体类型>, ...属性 }        ← 开放的属性文档
env      { host: 'desktop' | 'extension', platform: 'darwin' | 'win32' | 'linux' }
vars     宿主变量表（见下）+ 会话授权
```

工具调用的 `subject.kind` 是 `agent`，界面自己的被动检查是 `user` —— 所以每条内置规则都带
`subject.kind: [agent]`。

### 客体类型与属性

| `object.type`  | 由谁发起                                                   | `action`         | 属性                                                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`         | `read`、`write`、`edit`、`ls`、`grep`、`glob`、`knowledge` 工具、文件预览 | `read` / `write` | `path`（路径真正通向的位置：绝对路径；桌面端展开符号链接，`..` 取真实的父目录 —— 与系统打开它时一样）、`requestedPath`（工具请求时的绝对路径 —— 中间隔着链接或 `..` 时与 `path` 不同）、`displayPath`（模型写的原样，用于提示文案） |
| `command`      | `bash`、`powershell`、`ssh`                                | `execute`        | `command`（原文）、`channel`（`bash` / `powershell` / `ssh`）、`sandboxed`（布尔 —— 宿主真的把这次执行圈进了命令沙箱；恒有值，`ssh` 与没有沙箱的地方为 `false`）、`unconfinedReason`（没圈住的原因：圈住了为 `''`，`escalated` = agent 申请了完全访问，`disabled` = 沙箱被关掉，`unsupported` = 这个平台或这种 shell 没有沙箱，`unavailable` = 这一次沙箱套不上，`remote` = `ssh`），以及由 shell 解析器惰性提供的（`powershell` 命令由 ShuviX 自己的 PowerShell 扫描器读：`base` 是规范化的命令名 —— 别名解析成 cmdlet 名、去掉路径与 `.exe` / `.com`、大小写保持原样，比较前先 `lowerAscii()` —— `-Name:value` 拆成两项）：`parsed`（布尔）、`commands`（`{ base, argv, wrappers, complete, depth }` 的列表 —— `base` 是剥掉 `sudo` / `env` / `timeout` 之后真正的程序，动态词是 `''`）、`writes`（重定向目标，绝对路径）              |
| `gitTool`      | `git` 工具                                                 | `execute`        | `gitAction`、`command`、`force`（布尔）、`delete`（布尔）                                                                                                                                                                                                                            |
| `database`     | 内置 `database` 服务器的 `query` 工具                      | `execute`        | `sql`、`credential`、`dbType`、`readonly`（布尔 —— 连接是否只读）                                                                                                                                                                                                                   |
| `url`          | 内置 `browser` / `chrome` 服务器：每次导航；在 `chrome` 里还有每个站点的第一次使用 | `navigate`       | `url`、`scheme`、`host`（小写、去掉结尾的点）、`origin`、`browser`（`app` = ShuviX 里的浏览器面板，`chrome` = 你自己的 Chrome）；`file://` 不是 url 客体 —— 按读那个路径判定 |
| `invocation`   | **每一次**工具调用，执行之前                               | `execute`        | 无 —— 按 `tool.name` / `tool.operation` 判（如 `session` / `create-sub-session`）。这里的规则必须点名工具；不指定工具的 invocation 询问会拦住每一次调用。                                                                                                                              |

**strict 语义**：读取客体没有的属性（如对 `command` 取 `object.path`）是错误，而错误**按效力 fail-safe**
—— `deny` / `ask` 规则算命中（外加警告），放行类规则算不命中。永远用类型守住：
`object.type == 'path' && inDir(object.path, …)`，或把 `object.type` 写成条件。

### `match` 里可用的函数

- `inDir(path, dirs)` —— `dirs` 是字符串或列表；`path` 落在其中某个目录内（按路径段边界：`/foo`
  不命中 `/foobar`）时为真；空条目与非字符串条目永远不命中。桌面端两边都按**真正通向的位置**比：
  `path` 与每个目录都先解析（符号链接、`..`、盘上的大小写）再比较 —— 工作区里一条指向
  `~/.ssh/id_rsa` 的链接算在 `~/.ssh` 里；`~/.ssh` 本身是链进 dotfiles 仓库的链接时照样命中。
  相对路径的目录按写法比较。
- `hasShortFlags(argv, 'rf')` —— `argv` 里 GNU 风格的短选项簇是否带齐这些字母（`-rf`、`-fr`、`-r -f`
  都算）。
- 常规的 CEL 运算符、`in`、`startsWith`、`has(...)`、字符串与列表函数。

### `vars` —— 宿主变量表

| 名字                         | 类型     | 含义                                                                            |
| ---------------------------- | -------- | ------------------------------------------------------------------------------- |
| `workspace`                  | string   | 会话的工作目录                                                                  |
| `sessionDirs`                | string[] | 本会话可读写的目录：工作目录（除非它是 `/`、覆盖了整个家目录，或是 ShuviX 自己的配置或应用数据）、它的临时目录、它的 artifacts、工具结果，以及给它勾选的知识库（库的每次改动都提交进库自己的 git）。由宿主按会话设置算出 —— 和命令沙箱圈住命令用的是同一份清单 |
| `sessionReadDirs`            | string[] | 本会话只读的目录：技能目录（内置的、`~/.shuvix/skills`、每个启用的外部技能目录），以及勾选了的 ShuviX 说明书。读不问，写要问 —— 技能是智能体自己要遵守的指令。由宿主算出；受限的命令也能读它们 |
| `home`                       | string   | 用户主目录                                                                      |
| `toolResultsBase`            | string   | 大体积工具结果落盘的位置                                                        |
| `skillsDirs`                 | string[] | skill 目录（全局、内置、注册的外部目录）                                        |
| `memoryDirs`                 | string[] | 旧项目记忆的根                                                                  |
| `botsDir`                    | string   | `~/.shuvix/bots`                                                                |
| `builtinKnowledgeDir`        | string   | ShuviX 随应用发布的只读知识库（就是本库）                                       |
| `sessionArtifactsDir`        | string   | 本会话自己的产物目录 `~/.shuvix/artifacts/<会话>`                               |
| `shuvixConfigDirs`           | string[] | `~/.shuvix/policies`、`agents`、`hooks` 与 `skills` —— ShuviX 自己的配置        |
| `systemDirs`                 | string[] | 额外的操作系统目录（Windows 的系统 / 程序目录）                                 |
| `grantedRead`、`grantedWrite` | string[] | 用户在本会话里答过「允许并记住」的路径（写授权隐含读）。授权不是一条规则：它只往这两份清单里填路径，策略要认它，就在自己的 `match` 里把它们排除掉 —— ask-on-external-path 就是这么做的 |

宿主没有供给、且某条规则**只**把它当 `inDir` 目录参数用的 `vars.x`，按「没有这个目录」处理（正向的
`inDir` 命中不了；取反的为真，即规则多问）。缺失变量的其他用法都按错误进 fail-safe。

## 什么会让文件非法

出现下列情况整份拒绝（被跳过、以琥珀色行列在侧栏「安全策略」分组、永远不遮蔽内置）：没有 frontmatter /
YAML 语法错 / 不是映射；裸的 `rules` / `lets` / `scope` 键；`shuvix-policy-rules` 不是列表；某条规则带
未知键、未知 `effect`、非法的条件值、解析不了的 `match`；某条规则没有 `subject.kind`（规则或 scope）；
某条规则的条件与 scope 交集为空；非法的 `lets`（名字不合法、保留名、非字符串或解析不了的表达式）。
`match` 读了 `object.*` 却没声明 `object.type` 的，接受但记警告。

## 内置策略

随应用发布两份（按界面语言一份；**规则恒取英文文件**，翻译只改人读的文字）。默认尽可能少问，所以两份都是
普通的 `ask` 规则 —— `deny`、`force-ask` 与 `force-allow` 留给你自己的策略：

| 名字                            | 门                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ask-on-external-path`          | 文件工具读家目录里、本会话目录（`vars.sessionDirs`、`vars.sessionReadDirs`）以外的文件前询问，往可读写的那些（`vars.sessionDirs`）以外的任何地方写之前也询问，带 diff 预览；答过「允许并记住」的路径不在其列（`vars.grantedRead` / `vars.grantedWrite`）。读家目录以外的地方不问 |
| `ask-on-command`                | 每条没被圈进沙箱的命令询问（`object.sandboxed` 为 false：沙箱关闭或不可用、申请了完全访问、`ssh`）                           |

两份划的是同一条线：文件工具要问的，恰好就是受限命令碰不到的，所以智能体从 `read` 换成 `cat` 也占不到
便宜。两份清单都跟着会话勾的东西走（它的知识库、启用的技能目录），不用谁手工维护。`~/.ssh`、`~/.aws`
这类凭据在家目录里，读它们和读那里的任何文件一样要问。

侧栏「安全策略」分组逐份列出（点一行打开那份 md，规则在属性卡上）；内置行菜单的「创建覆盖副本」把当前文本写到
`~/.shuvix/policies/<name>.md`。

早先的版本出厂带的门更多：拒绝写操作系统目录、拒绝一小撮毁灭整机的命令，写 bot 文件与 ShuviX 自己的
配置一律问用户，危险的 git 操作、可写数据库连接上的 SQL、开子会话、在你自己的 Chrome 里碰到新站点也都
要询问。后来几道路径门又并进了 ask-on-external-path：`protect-credentials`（一张凭据位置清单 —— 凭据都在
家目录里，如今和那里的其他文件一样询问）、`ask-on-write`（工作目录以外的写入）和 `session-grants`（给
「允许并记住」的 `force-allow` —— 记住的路径如今就是路径规则排除掉的那两个变量）。这些是有意删掉的，但
每个执行点都还在（就是上面那些客体类型），任何一道都能写成你自己的策略加回来。

## 放宽与收紧

- **关掉一道门**：按名字覆盖，`shuvix-policy-rules: []`。
- **给某处免去询问**而不动内置：新建一份策略，写一条 `force-allow` 规则（`force-allow` 压过 `ask`），
  例如 `action: [read]` 配 `match: inDir(object.path, vars.home + '/notes')`，文件工具读 `~/notes`
  就不再问。策略从不放宽命令沙箱 —— 受限的命令照样读不了那里；两边都管得到的是「允许并记住」。
- **加一道询问**：新建一份策略，对你在意的客体写一条 `ask` 规则 —— 见下面的示例。
- **加一道硬停**：一条 `deny` 规则 —— 压过一切，包括「允许并记住」。
- **让「允许并记住」对你自己的询问也生效**：你写的路径 `ask` 在「允许并记住」之后照样会问，除非它的
  `match` 像 ask-on-external-path 那样把授权排除掉（`&& !inDir(object.path, vars.grantedWrite)`，读的话
  再加上 `vars.grantedRead`）。
- **让一道门跳不过去**：`force-ask` —— `force-allow` 和自动审查都答不了它，它的卡片上也没有「允许并
  记住」。想让审查员不碰某一类操作，也是这样写，例如 `object.unconfinedReason == 'escalated'`，即
  「agent 想离开沙箱时一律问我」；
  或是 `vars.botsDir` / `vars.shuvixConfigDirs` 下的写入，即「agent 改 bot 文件或 ShuviX 自己的配置时
  一律问我」。
- 规则要窄：deny 无法按次豁免，所以一条在日常工作里误触发的规则，比一条漏掉的更糟。

例如，可写数据库连接上的每条 SQL 语句都先询问：

```markdown
---
shuvix: policy v1
name: ask-before-sql
description: 可写数据库连接上的每条语句都先询问。
shuvix-policy-scope:
  subject.kind: [agent]
  object.type: [database]
shuvix-policy-rules:
  - effect: ask
    action: [execute]
    match: '!object.readonly'
    prompt: 这条连接可写 —— 这条语句可能改动或删除服务器上的数据。
---
```

危险的 git 操作也是同一个形状：`object.type: [gitTool]`，`match` 写成
`object.gitAction == 'restore' || (object.gitAction == 'checkout' && object.force)` 之类。

## 不在文件里的

引擎从不读正文（只给人看的理由）。没有按工具的 schema，没有对命令原文的正则匹配（结构化的
`commands` / `writes` 就是为此而设），也没有办法改变工具*做什么* —— 策略只决定一次调用能否进行。
