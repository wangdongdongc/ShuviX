---
shuvix: okf v0.2
type: Guide
title: '安全策略文件（shuvix: policy v1）'
description: 'ShuviX 安全策略的完整规范 —— 规则看到的请求文档（subject / action / tool / object / env / vars）、五个条件键、CEL `match`、效力及其优先序、`lets`、什么会让文件非法、内置策略有哪些，以及怎样放宽或收紧一道门。'
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
（放行了的 `bash` 命令以用户的完整权限运行 —— 这里没有任何操作系统级隔离。）

- 位置：`~/.shuvix/policies/<name>.md`。
- 标记：`shuvix: policy v1`；读取可选，写出恒带。
- 存在即生效，会话装配规则时重新读取。`name` 与内置同名的用户文件**取代**它；非法的用户文件永远不
  遮蔽内置。

## 示例

```markdown
---
shuvix: policy v1
name: protect-drafts
shuvix-displayName: Never overwrite my drafts
description: Files under ~/Documents/drafts can be read but never written by an agent.
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
    prompt: Write refused — the drafts folder is read-only for agents; ask the user to move the file out first.
---

**What it does**: any write under `~/Documents/drafts` is refused, even with auto-allow on.
The body is documentation only — the engine never reads it.
```

## frontmatter 键

| 键                      | 类型                        | 必填   | 含义                                                                                                                                                                                                     |
| ----------------------- | --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`                | `policy v1`                 | 否     | 文件类型标记。                                                                                                                                                                                           |
| `name`                  | 字符串                      | 否     | 身份（覆盖按它匹配）。缺省取文件基础名。                                                                                                                                                                 |
| `shuvix-displayName`    | 字符串                      | 否     | 设置 → 策略与询问卡片上的标签。缺省 = `name`。                                                                                                                                                           |
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
| `prompt`                                                       | 可选的一句话。`ask` 时显示在询问卡片上；`deny` 时作为拒绝原因回给 agent；放行类规则只在设置页显示。最长 1000 字符。唯一永远不会让文件非法的键。                                    |

规则里出现任何别的键都让文件非法（包括旧的嵌套 `object:` / `subject:` / `when:` 匹配器）。

### 效力与优先序

所有策略里命中的全部规则中，最强的效力胜出：

```
deny  >  force-ask  >  force-allow  >  ask  >  allow  >  （什么都没命中 = allow）
```

- `ask` 把这次调用摆到用户面前；`allow` 直接放行；`deny` 拒绝（agent 收到 `prompt` 作为原因）。
- `force-allow` 是压得过一切 `ask` 的放行 —— ShuviX 用它表达会话授权（「免询问」与「允许并记住」）。
- `force-ask` 是连 `force-allow` 也跳不过的询问 —— 「这道门不接受会话级同意」（bot 文件那道门就是）。
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
| `path`         | `read`、`write`、`edit`、`knowledge` 工具、文件预览        | `read` / `write` | `path`（解析后的绝对路径）、`displayPath`                                                                                                                                                                                                                                           |
| `command`      | `bash`、`ssh`                                              | `execute`        | `command`（原文）、`channel`（`bash` / `ssh`），以及由 shell 解析器惰性提供的：`parsed`（布尔）、`commands`（`{ base, argv, wrappers, complete, depth }` 的列表 —— `base` 是剥掉 `sudo` / `env` / `timeout` 之后真正的程序，动态词是 `''`）、`writes`（重定向目标，绝对路径）              |
| `gitTool`      | `git` 工具                                                 | `execute`        | `gitAction`、`command`、`force`（布尔）、`delete`（布尔）                                                                                                                                                                                                                            |
| `database`     | 内置 `database` 服务器的 `query` 工具                      | `execute`        | `sql`、`credential`、`dbType`、`readonly`（布尔 —— 连接是否只读）                                                                                                                                                                                                                   |
| `invocation`   | **每一次**工具调用，执行之前                               | `execute`        | 无 —— 按 `tool.name` / `tool.operation` 判（如 `session` / `create-sub-session`）。这里的规则必须点名工具；不指定工具的 invocation 询问会拦住每一次调用。                                                                                                                              |

**strict 语义**：读取客体没有的属性（如对 `command` 取 `object.path`）是错误，而错误**按效力 fail-safe**
—— `deny` / `ask` 规则算命中（外加警告），放行类规则算不命中。永远用类型守住：
`object.type == 'path' && inDir(object.path, …)`，或把 `object.type` 写成条件。

### `match` 里可用的函数

- `inDir(path, dirs)` —— `dirs` 是字符串或列表；`path` 落在其中某个目录内（按路径段边界：`/foo`
  不命中 `/foobar`）时为真；空条目与非字符串条目永远不命中。
- `hasShortFlags(argv, 'rf')` —— `argv` 里 GNU 风格的短选项簇是否带齐这些字母（`-rf`、`-fr`、`-r -f`
  都算）。
- 常规的 CEL 运算符、`in`、`startsWith`、`has(...)`、字符串与列表函数。

### `vars` —— 宿主变量表

| 名字                         | 类型     | 含义                                                                            |
| ---------------------------- | -------- | ------------------------------------------------------------------------------- |
| `workspace`                  | string   | 会话的工作目录                                                                  |
| `home`                       | string   | 用户主目录                                                                      |
| `toolResultsBase`            | string   | 大体积工具结果落盘的位置                                                        |
| `skillsDirs`                 | string[] | skill 目录（全局、内置、注册的外部目录）                                        |
| `memoryDirs`                 | string[] | 旧项目记忆的根                                                                  |
| `botsDir`                    | string   | `~/.shuvix/bots`                                                                |
| `builtinKnowledgeDir`        | string   | ShuviX 随应用发布的只读知识库（就是本库）                                       |
| `systemDirs`                 | string[] | 额外的操作系统目录（Windows 的系统 / 程序目录）                                 |
| `autoAllow`                  | boolean  | 会话的「免询问」开关                                                            |
| `grantedRead`、`grantedWrite` | string[] | 用户在本会话里答过「允许并记住」的路径（写授权隐含读）                          |

宿主没有供给、且某条规则**只**把它当 `inDir` 目录参数用的 `vars.x`，按「没有这个目录」处理（正向的
`inDir` 命中不了；取反的为真，即规则多问）。缺失变量的其他用法都按错误进 fail-safe。

## 什么会让文件非法

出现下列情况整份拒绝（被跳过、列在设置 → 策略的「无法解析」下、永远不遮蔽内置）：没有 frontmatter /
YAML 语法错 / 不是映射；裸的 `rules` / `lets` / `scope` 键；`shuvix-policy-rules` 不是列表；某条规则带
未知键、未知 `effect`、非法的条件值、解析不了的 `match`；某条规则没有 `subject.kind`（规则或 scope）；
某条规则的条件与 scope 交集为空；非法的 `lets`（名字不合法、保留名、非字符串或解析不了的表达式）。
`match` 读了 `object.*` 却没声明 `object.type` 的，接受但记警告。

## 内置策略

随应用发布十四份（按界面语言一份；**规则恒取英文文件**，翻译只改人读的文字）：

| 名字                            | 门                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `protect-credentials`           | 拒绝写、询问读凭据目录（`.ssh`、`.aws`……）                                                                    |
| `protect-system`                | 拒绝写操作系统目录                                                                                            |
| `block-catastrophic-commands`   | 拒绝一小撮毁灭整机的命令，按解析结构判（`rm -rf /`、`mkfs`、`dd` 到设备……）                                    |
| `protect-bot-files`             | `~/.shuvix/bots` 下任何写入 **force-ask**                                                                     |
| `protect-builtin-knowledge`     | 拒绝写入 ShuviX 的内置知识库                                                                                  |
| `ask-on-read`                   | 在工作区、工具结果、skill 目录与本说明书之外的读取询问                                                        |
| `ask-on-write`                  | 每次文件写入询问，带 diff 预览                                                                                |
| `review-memory-writes`          | 写旧记忆存储 force-ask                                                                                        |
| `ask-on-command`                | 每条 `bash` / `ssh` 命令询问                                                                                  |
| `git-safety`                    | 危险的 git 操作询问（`init`、`restore`、强制 checkout、删分支）                                               |
| `ask-on-database`               | 可写数据库连接上的每条语句询问                                                                                |
| `ask-on-sub-session`            | 开子会话时询问一次（`tool.name == 'session' && tool.operation == 'create-sub-session'`）                        |
| `session-auto-allow`            | 会话的免询问开关打开时 `force-allow` 一切                                                                     |
| `session-path-grants`           | 用户答过「允许并记住」的路径下的读 / 写 `force-allow`                                                          |

设置 → 策略逐份显示其规则；「创建覆盖副本」把当前文本写到 `~/.shuvix/policies/<name>.md`。

## 放宽与收紧

- **关掉一道门**：按名字覆盖，`shuvix-policy-rules: []`。
- **给某处免去询问**而不动内置：新建一份策略，写一条 `force-allow` 规则（`force-allow` 压过 `ask`），
  例如某个目录下的写入。
- **加一道硬停**：一条 `deny` 规则 —— 压过一切，包括免询问。
- **让一道门跳不过去**：`force-ask`。
- 规则要窄：deny 无法按次豁免，所以一条在日常工作里误触发的规则，比一条漏掉的更糟。

## 不在文件里的

引擎从不读正文（只给人看的理由）。没有按工具的 schema，没有对命令原文的正则匹配（结构化的
`commands` / `writes` 就是为此而设），也没有办法改变工具*做什么* —— 策略只决定一次调用能否进行。
