---
shuvix: okf v0.2
type: Guide
title: 'Agent 定义文件（shuvix: agent v1）'
description: 'ShuviX agent 文件的完整规范 —— 每个 frontmatter 键、工具白名单的写法、正文里的 `{{shuvix:*}}` 占位符、什么会让文件非法、内置 agent 有哪些，以及一个 agent 怎样被用起来。'
tags: [shuvix, agent, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/definitionFile.ts
    title: definitionFile.ts —— 解析器（事实源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/promptVars.ts
    title: promptVars.ts —— `{{shuvix:*}}` 占位符
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/subagent/builtinAgents/md
    title: 内置 agent，一种语言一份 md
---

# Agent 定义文件

一个 **agent** = 一段人格 + 一份工具白名单。ShuviX 里的每个 agent —— 它自带的与用户自己写的 ——
都是这个格式的一份 markdown：YAML frontmatter 放身份与开关，正文就是这个 agent 的**系统提示词**。

- 位置：`~/.shuvix/agents/<name>.md`（一个 agent 一份文件；目录可能还不存在）。
- 标记：首键 `shuvix: agent v1`。ShuviX 写出时恒带；读取时可选（早先手写的文件没有它也能加载）。
- 存在即生效：用到时才读文件。不用注册，不用重启。

## 示例

```markdown
---
shuvix: agent v1
name: reviewer
description: Reads a change set and reports risks without editing anything.
shuvix-displayName: Code reviewer
shuvix-tools: read, ls, grep, glob, bash, skill:conventional-comments
shuvix-model: anthropic/claude-sonnet-4-5
shuvix-instruction-files: AGENTS.md, CLAUDE.md
shuvix-project-awareness: true
---

You are a code reviewer working in {{shuvix:workingDirectory}} on {{shuvix:date}}.
Read the diff the caller points you at, then report: correctness risks first, then
style, each with file and line. Never modify files.
```

## frontmatter 键

| 键                          | 类型             | 必填 | 含义                                                                                                                                                                                                                                       |
| --------------------------- | ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shuvix`                    | `agent v1`       | 否   | 文件类型标记。ShuviX 写出恒带；读取可选。                                                                                                                                                                                                  |
| `name`                      | 字符串           | 否   | agent 的身份 —— `agent` 工具、hook 的 `shuvix-hook-agent`、子会话的 `agent_profile` 点名的就是它。缺省取文件基础名（`reviewer.md` → `reviewer`）。                                                                                          |
| `description`               | 字符串           | 否   | 给人看的一句话，显示在 agent 列表里。不给模型看。                                                                                                                                                                                          |
| `shuvix-displayName`        | 字符串           | 否   | 界面上的标签。缺省 = `name`。                                                                                                                                                                                                              |
| `shuvix-tools`              | 逗号分隔的字符串 | 否   | 工具白名单（见下）。**是字符串，不是 YAML 列表** —— 写成列表会让文件非法。省略 = 一个工具都没有。                                                                                                                                          |
| `shuvix-model`              | 字符串           | 否   | 这个 agent 用哪个模型：`<providerId>/<modelId>`（界面写出的形式）或裸 `<modelId>`。省略 = 跟随所在会话（或派发它的那一方）。设置里未启用的模型按没写处理。                                                                                 |
| `shuvix-instruction-files`  | 逗号分隔的字符串 | 否   | 这个 agent 读哪些项目指令文件：**相对工作目录**的路径，按优先级排列 —— 第一个存在且非空的被注入，至多一个。绝对路径、`..` 段或布尔值都让文件非法。省略 = 不注入。                                                                            |
| `shuvix-project-awareness`  | 布尔             | 否   | `true` = 让 agent 知道自己在哪个项目里：项目提示词与项目记忆索引追加到它的系统提示词（按根会话的项目解析；会话不属于项目时什么也不注入）。必须是真正的 YAML 布尔值。缺省 `false`。                                                       |
| `shuvix-builtin`            | 布尔             | 否   | ShuviX 自带文件的自述标记。解析器不读；不要加进用户文件。                                                                                                                                                                                  |

**被忽略**的键（按未知键读，不报错、无效果）：通用的 `tools` 键（别的应用对工具名的含义会被误读 ——
用 `shuvix-tools`），以及已退役的 `whenToUse`、`displayName`、`shuvix-dispatch-only`、
`shuvix-session-awareness`、`shuvix-prompt-sections`、`shuvix-project-prompt`、`shuvix-project-memory`。

### `shuvix-tools` —— 白名单

一个逗号分隔的字符串。每一项是下面之一：

- **内置工具名** —— 大小写不敏感，归一为小写：`bash`、`read`、`write`、`edit`、`ls`、`glob`、`grep`、
  `ask`、`browser`、`database`、`git`、`session`、`knowledge`、`artifact`；
- `agent` —— 选择加入用 `agent` 工具**派发子代理**（受嵌套上限约束：被派发的 agent 只在深度上限
  —— 缺省 2 —— 允许时才能继续派发）；
- `mcp:<server>` —— 该 MCP 服务器的全部工具（服务器名按设置里配置的写；前缀后的大小写保留；创建
  agent 时才惰性连接）；
- `skill:<name>` —— 那个 skill（带命名空间的 skill 写成 `skill:<dir>:<name>`；ShuviX 自带的技能写成
  `skill:builtin:<name>`）。

条目按顺序去重。本机上不存在的名字静默丢弃 —— agent 照常创建，只是没有它。**列表里写了的都恒生效**，
无论这个 agent 以哪种方式被用上。它做会话的根时，其中的 `mcp:` / `skill:` 项在这条会话的扩展能力
选择器里显示为已勾、锁住（悬停会说是哪个 agent 声明的）；会话自己的勾选只能在其上叠加，要去掉一项
就得覆盖这个 agent。**收窄工具列表不是 ShuviX 表达角色的方式**：一个没有 `grep` 的 agent 只会拿
`bash` 去 grep。内置的 `work`、`chat`、`coding` 三者刻意共用一份列表（`bash, read, write, edit, ask,
browser, ls, grep, glob, database, agent, session, knowledge, artifact, skill:builtin:drawing`），
只在正文上有区别。

### 正文 —— 系统提示词

frontmatter 之后的全部内容（去首尾空白）就是系统提示词。可以内嵌 `{{shuvix:name}}` 形式的**占位符**，
创建 agent 时替换。桌面端可用：

| 占位符                          | 值                                                            |
| ------------------------------- | ------------------------------------------------------------- |
| `{{shuvix:workingDirectory}}`   | 会话工作目录的绝对路径                                        |
| `{{shuvix:isGitRepo}}`          | `Yes` / `No` —— 该目录下有没有 `.git`                          |
| `{{shuvix:platform}}`           | `darwin` / `win32` / `linux`                                   |
| `{{shuvix:shell}}`              | `zsh` / `bash` / `fish` / shell 的路径                          |
| `{{shuvix:os}}`                 | 操作系统类型与版本                                            |
| `{{shuvix:date}}`               | 今天，`YYYY-MM-DD`                                             |
| `{{shuvix:language}}`           | 界面语言，如 `中文 (zh)` / `English (en)`                       |
| `{{shuvix:appVersion}}`         | ShuviX 版本                                                    |
| `{{shuvix:projectName}}`        | 项目名，不在项目里为空                                        |
| `{{shuvix:notebookPath}}`       | 笔记本会话绑定的文件（只有笔记本会话的根 agent 有）              |

未知占位符原样保留（并记一条警告）；空值会把周围的空行收敛掉，所以建立在空变量上的一句话会干净地消失。
这套语法与 i18n 模板互不冲突。正文的其余部分就是普通文字 —— 没有别的模板语法。

## 什么会让文件非法

出现下列情况时解析器拒绝**整份文件**（被跳过、列在设置 → Agent 的「无法解析」下、永远不遮蔽同名内置）：

- 没有 YAML frontmatter 块，或 YAML 解析不了，或它不是映射；
- `shuvix-tools` / `shuvix-model` / `shuvix-instruction-files` 不是字符串（写成 YAML 列表是最常见的错）；
- `shuvix-project-awareness` 不是布尔；
- `shuvix-instruction-files` 的某一项是绝对路径或用 `..` 越出工作目录，或这个键写成了 2026 年之前的
  布尔形式（`shuvix-instruction-files: true` —— 改列文件名）。

空 frontmatter（`---` 紧跟 `---`）合法：所有字段取缺省值。

## 内置 agent 与覆盖

随应用发布（按界面语言一份，同一个解析器读）：四个**基座**人格 `work`（项目内会话的根）、`chat`
（不属于任何项目的会话的根）、`notebook`（笔记本会话的根）、`bot`（bot 会话的根）—— 加上任务型
agent `coding`、`browser`、`explore`、`widget`、`wiki`、`wiki-writer`、`titler`、
`knowledge-writer`。

- **会话的根人格由会话形态推导，从不选择**：笔记本 → `notebook`，bot 会话 → `bot`，在项目里 →
  `work`，否则 → `chat`。没有设置项，没有选择器。想改主对话的行为，**按名字覆盖基座**：
  `~/.shuvix/agents/work.md` 整个取代内置的 `work`（设置 → Agent → 「创建覆盖副本」给你当前文本作起点）。
- 任何 `name` 与内置同名的用户文件都取代那个内置。用户文件之间的同名按 `shuvix-files` 条目里的规则
  裁决；输的那几份列为已被覆盖。写坏的覆盖永远不会遮蔽内置。
- 基座**从不被派发、从不被点名**：`agent` 工具、hook 的 `shuvix-hook-agent`、子会话的 `agent_profile`
  都拒绝 `work` / `chat` / `notebook` / `bot`。

## 一个 agent 怎样被用起来

1. **经 `agent` 工具派发为子代理**（调用方自己的列表须含 `agent`）：`name` = 本文件的 `name`，外加
   `prompt` 与一句 `description`。子代理在内存里作为根 agent 的同级运行，除非 `shuvix-model` 另有声明
   否则继承会话的模型与思考等级，拿到同样的指令文件 / 项目注入（按根会话的项目解析），最后把最终文本
   返回。这个工具**不会**向模型列举可用的 agent —— 名字得来自提示词或用户。
2. **作为子会话的人格** —— `session` 工具的 `agent_profile`（任何不是基座的 agent）。子会话保留从
   父会话抄来的扩展能力；该 agent `shuvix-tools` 里的 `mcp:` / `skill:` 条目和列表里的其余各项一样
   恒生效，叠加在上面。
3. **作为 hook 的 agent**（`shuvix-hook-agent` —— 见 `hook-md` 条目）。
4. **作为基座覆盖**（见上）。

上下文注入在每种情况下都成立：`shuvix-instruction-files` 与 `shuvix-project-awareness` 读的是**本文件**，
而只要工具列表里有 `knowledge`，知识库引导就会被注入。
