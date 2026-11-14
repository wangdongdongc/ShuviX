---
shuvix: okf v0.2
type: Guide
title: 'Agent 定义文件（shuvix: agent v1）'
description: 'ShuviX agent 文件的完整规范 —— 每个 frontmatter 键、工具白名单的写法、ShuviX 在正文之后追加的提示词块、什么会让文件非法、内置 agent 有哪些，以及一个 agent 怎样被用起来。'
tags: [shuvix, agent, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/definitionFile.ts
    title: definitionFile.ts —— 解析器（事实源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/agentProfile/promptBlocks.ts
    title: promptBlocks.ts —— 正文之后追加的块
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/chat-protocol/src/agentPromptBlocks.ts
    title: agentPromptBlocks.ts —— `shuvix-prompt-blocks` 的词表
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
shuvix-tools: read, ls, grep, glob, bash, skill
shuvix-model: anthropic/claude-sonnet-4-5
shuvix-thinking: low
shuvix-prompt-blocks: environment, agents_md, claude_md, project_prompt
---

You are a code reviewer. Read the diff the caller points you at, then report:
correctness risks first, then style, each with file and line. Never modify files.
```

## frontmatter 键

| 键                          | 类型             | 必填 | 含义                                                                                                                                                                                                                                       |
| --------------------------- | ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shuvix`                    | `agent v1`       | 否   | 文件类型标记。ShuviX 写出恒带；读取可选。                                                                                                                                                                                                  |
| `name`                      | 字符串           | 否   | agent 的身份 —— `agent` 工具、hook 的 `shuvix-hook-agent`、子会话的 `agent_profile` 点名的就是它。缺省取文件基础名（`reviewer.md` → `reviewer`）。                                                                                          |
| `description`               | 字符串           | 否   | 给人看的一句话，显示在 agent 列表里。不给模型看。                                                                                                                                                                                          |
| `shuvix-displayName`        | 字符串           | 否   | 界面上的标签。缺省 = `name`。                                                                                                                                                                                                              |
| `shuvix-tools`              | 逗号分隔的字符串 | 否   | 工具白名单（见下）。**是字符串，不是 YAML 列表** —— 写成列表会让文件非法。省略 = 一个工具都没有。                                                                                                                                          |
| `shuvix-model`              | 字符串           | 否   | 这个 agent 用哪个模型：`<providerId>/<modelId>`（界面写出的形式）或裸 `<modelId>`。写在基座（`work` / `chat` / `notebook` / `bot`）上时，它是这类会话在会话里选定模型之前用的模型，先于设置里的默认模型。省略 = 跟随所在会话（或派发它的那一方）。设置里未启用的模型按没写处理。                                                                                 |
| `shuvix-thinking`           | 字符串           | 否   | 这个 agent 的思考深度：`off` / `low` / `medium` / `high` / `xhigh` / `max`（大小写不限）。派发出去的 agent 按它跑；被子会话的 `agent_profile` 点名时，它是那条子会话的初始档位（之后可在会话里改）；写在基座上时，它是这类会话在会话里选定档位之前用的档位。省略 = 跟随派发它的一方（子会话跟随父会话）。别的值让文件非法。 |
| `shuvix-prompt-blocks`      | 逗号分隔的字符串 | 否   | ShuviX 在正文之后往系统提示词里追加哪几块（见下）：`document`、`drawing`、`environment`、`agents_md`、`claude_md`、`project_prompt` 中的任意几个。**是字符串，不是 YAML 列表。** 省略 = 一块都不追加。 |
| `shuvix-user-words`         | 布尔             | 否   | `true` = 这个 agent 作为子会话时，父会话发给它的每条消息都附上用户在父会话里自己写的话（打的消息、对父会话提问的回答），由 ShuviX 原样引用、放在父会话写的那段之后，让它分得清哪些是用户的原话、哪些是父会话的转述。第一条附到目前为止的（首条与最近 10 条，每条至多 4000 字），之后只附新说的。只对父会话自己的子会话生效。必须是真正的 YAML 布尔值。缺省 `false`；内置的 `coding` 开着。 |
| `shuvix-builtin`            | 布尔             | 否   | ShuviX 自带文件的自述标记。解析器不读；不要加进用户文件。                                                                                                                                                                                  |
| `shuvix-id`                 | 字符串            | 否   | 对象 id —— 文件移到哪里，ShuviX 都凭它认出这份文件。ShuviX 新建的文件里是 UUID，自带文件里是 `<类型>:builtin:<名字>`；副本与原件共用同一个 id。由 ShuviX 写入，不要动。写错只发一条提示，不会让整份文件非法。                                                                                 |

**被忽略**的键（按未知键读，不报错、无效果）：通用的 `tools` 键（别的应用对工具名的含义会被误读 ——
用 `shuvix-tools`），以及已退役的 `whenToUse`、`displayName`、`shuvix-dispatch-only`、
`shuvix-session-awareness`、`shuvix-prompt-sections`、`shuvix-project-prompt`、`shuvix-project-memory`、
`shuvix-instruction-files`（现在是 `agents_md` / `claude_md` 两块）与 `shuvix-project-awareness`（现在是
`project_prompt` 块）。还带着后两个键的文件，在列出对应的块之前拿不到指令文件，也拿不到项目提示词。

### `shuvix-tools` —— 白名单

一个逗号分隔的字符串。每一项是下面之一：

- **内置工具名** —— 大小写不敏感，归一为小写：`bash`、`powershell`、`read`、`write`、`edit`、`move`、`delete`、`ls`、`glob`、
  `grep`、`ask`、`git`、`session`、`knowledge`、`artifact`；
- `agent` —— 选择加入用 `agent` 工具**派发子代理**（受嵌套上限约束：被派发的 agent 只在深度上限
  —— 缺省 2 —— 允许时才能继续派发）；
- `mcp:<server>` —— 该 MCP 服务器的全部工具（服务器名按设置里配置的写；前缀后的大小写保留；创建
  agent 时才惰性连接）。ShuviX 自带三台跑在进程内的：`mcp:browser`（ShuviX 自己的浏览器面板）、
  `mcp:ssh`（你 `~/.ssh/config` 里的主机）与 `mcp:database`（在 ShuviX 设置里保存的数据库连接）。
  内置 agent 都不声明它们 —— 会话需要时自己勾 —— 所以一个应当始终能用浏览器的 agent 要在列表里写上
  `mcp:browser`；
- `skill` —— `skill` 工具。它的货架是侧栏「技能」里**开着的全部技能**（ShuviX 自带的也在内），加上会话
  所在项目的 `.claude/skills`，去掉 `SKILL.md` 写了 `disable-model-invocation: true` 的；任务对得上某个
  技能的描述时，模型自己加载它。agent 文件不逐个挑技能，会话也不挑 —— 与 Claude Code、Codex 一样。
  旧文件里的 `skill:<name>` 条目读作 `skill`。

**平台特定工具**只在部分平台上存在：`bash` 在 macOS 和 Linux 上，`powershell` 在 Windows 上
（设置 → LLM 工具里会在它们后面标出平台）。把每个平台的版本都列上 —— 内置 agent 把 `bash` 和
`powershell` 都写上了 —— 每台机器只装配它有的那一个，于是同一份文件在哪台机器上都成立。只列了 `bash`
的 agent 在 Windows 上就没有命令工具。

条目按顺序去重。本机上不存在的名字静默丢弃 —— agent 照常创建，只是没有它。**列表里写了的都恒生效**，
无论这个 agent 以哪种方式被用上。它做会话的根时，其中的 `mcp:` 项在这条会话的扩展能力选择器里显示为
默认勾上（悬停会说是哪个 agent 声明的）。会话可以再勾别的服务器，也可以只为自己取消声明的某一台；取消在
会话的勾选里记成 `-mcp:<server>`，项目的缺省也可以带着它，agent 文件不动。要让每条会话都去掉一项，仍然是
覆盖这个 agent。内置工具名取消不了。技能根本不在选择器里：不想让模型用某个技能，就在侧栏把它关掉 ——
对之后新建的 agent 生效；正在运行的 agent 保持它创建时的那批技能，直到你重建它（agent 标签上的 X）。
**收窄工具列表不是 ShuviX 表达角色的方式**：一个没有 `grep` 的 agent 只会拿
`bash` 去 grep。内置的 `work`、`chat`、`coding` 三者刻意共用一份列表（`bash, powershell, read, write, edit, ask,
suggest, update_plan, show_image, ls, grep, glob, agent, session, knowledge, artifact, widget, tool_search, shuvix, skill`），
只在正文上有区别。`tool_search` 与 `update_plan` 只给会话的根 agent：派发出去的 agent 即使文件里写了也拿不到 —— `tool_search` 开启的是整条会话的选择，`update_plan` 维护的任务列表只显示在这条会话自己的对话里。

### 正文 —— 系统提示词

frontmatter 之后的全部内容（去首尾空白）就是系统提示词，原样发给模型。它是普通文字 —— 没有模板语法。
早先版本的 `{{shuvix:name}}` 占位符不再替换：留在正文里的会原样到模型那里，所以把它删掉，改为列出带着
同样信息的那一块。

### `shuvix-prompt-blocks` —— ShuviX 在正文之后追加什么

跟会话有关的内容（agent 在哪里干活、今天几号、项目自己的指令……）不写在正文里。ShuviX 把它们渲染成**块**，
每块包在一个 XML 标签里，追加在正文后面；文件只说要哪几块。

| 块               | 追加成                                       | 内容                                                                                                                                                                                       | 什么时候不追加                                                         |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `document`       | `<document>`                                 | 笔记本会话打开的那份文档（相对工作目录的路径）。它是 ShuviX 自己的文件（安全策略、hook、智能体档案、bot、技能、知识库条目）时：它是什么、保存后何时生效、规范在说明书哪一条。                 | 这个 agent 不是笔记本会话的根 agent。                                  |
| `drawing`        | `<drawing>`                                  | 怎么作图：画第一张图之前先加载内置的作图技能。在聊天里还会说明图是回复的一部分；改文档的 agent（持有 `doc_edit`）只拿到「先加载」那一句。                                                   | 这个 agent 没有 `skill` 工具，或内置作图技能被关掉了。                 |
| `environment`    | `<environment>`                              | 一份清单，一行一项：工作目录与本会话的临时目录（只给持有文件工具或命令工具的 agent）；Git 仓库、Shell、OS（只在有 `bash` / `powershell` 时）；Platform、当前日期、用户语言、ShuviX 版本（恒有）。 | ——                                                                     |
| `agents_md`      | `<project_instructions file="AGENTS.md">`    | 工作目录下 `AGENTS.md` 的内容。                                                                                                                                                             | 文件不存在或为空。                                                     |
| `claude_md`      | `<project_instructions file="CLAUDE.md">`    | 工作目录下 `CLAUDE.md` 的内容。                                                                                                                                                             | 文件不存在或为空，或同时列了 `agents_md` 而两个文件内容相同。          |
| `project_prompt` | `<project_prompt>`                           | 项目提示词（项目设置里的那段文字）。                                                                                                                                                       | 会话不属于项目，或项目没有提示词。                                     |

- **列表是集合。** 写的先后无所谓，名字大小写不限：ShuviX 恒按上表的次序追加，写回这个键时也按这个次序。
- **列了不等于一定出现。** 条件不满足的块整块不出，所以提示词不会指向 agent 手里没有的东西。
- **两个指令文件都读。** `agents_md` 与 `claude_md` 都列、两个文件都在，就都进提示词，`AGENTS.md` 在前。
  内容完全相同（一个是另一个的副本或链接）时只留一份，算作 `AGENTS.md`。
- **不认识的名字被忽略**并发一条提示；不会让文件非法。省略这个键 = 什么都不追加。
- 派发出去的 agent 拿到同样的块，按派发它的那条会话解析：那条会话的工作目录、临时目录与项目。`document`
  只给笔记本会话的根 agent。
- 只属于某个工具的说明跟着工具走，不在这张表里：持有 `knowledge` 的 agent 拿到 `<knowledge_bases>`
  （这条会话有哪些知识库、什么时候用），持有 `tool_search` 的根 agent 拿到 `<extensions>`（这条会话可以开启什么）。

块在创建 agent 时渲染。会话的根 agent 此后整场对话都保持这份系统提示词 —— 之后再改 agent 文件、
`AGENTS.md` / `CLAUDE.md` 或项目提示词都不会改变它，直到你重建（输入框里用量环前面的小图标会在来源变了时
提示，并提供「重建系统提示词」）。

## 什么会让文件非法

出现下列情况时解析器拒绝**整份文件**（被跳过、以琥珀色行列在侧栏「智能体」分组末尾、悬停可见原因，永远不遮蔽同名内置）：

- 没有 YAML frontmatter 块，或 YAML 解析不了，或它不是映射；
- `shuvix-tools` / `shuvix-model` / `shuvix-prompt-blocks` 不是字符串（写成 YAML 列表是最常见的错）；
- `shuvix-thinking` 不是 `off` / `low` / `medium` / `high` / `xhigh` / `max` 之一（写成 `false` 也不行 —— 写 `off`）；
- `shuvix-user-words` 不是布尔。

空 frontmatter（`---` 紧跟 `---`）合法：所有字段取缺省值。

## 内置 agent 与覆盖

随应用发布（按界面语言一份，同一个解析器读）：五个**基座**人格 `work`（项目内会话的根）、`chat`
（不属于任何项目的会话的根）、`notebook`（笔记本会话的根 —— 主窗口里的笔记，或在单独窗口里打开的 md
文件 —— 只经 `doc_read` / `doc_edit` / `doc_insert` 改那份文档）、`bot`（bot 会话的根）、`tab`（Chrome
侧边栏对话的根，唯一带 `mcp:chrome` —— 用户自己的 Chrome —— 的一个）—— 加上任务型
agent `coding`、`explore`、`titler`，以及两个只由 ShuviX 派发的 agent：`permission-reviewer`
—— 它替自动审查回答审批请求（见 `policy-md` 条目），和 `knowledge-writer` —— 知识库管理员，唯一写
知识库的 agent，收录别的 agent 经 `knowledge` 工具提交的内容（见 `knowledge-entry` 条目）。

- **会话的根人格由会话形态推导，从不选择**：笔记本或 md 窗口 → `notebook`，bot 会话 → `bot`，Chrome 侧边栏 →
  `tab`，在项目里 → `work`，否则 → `chat`。没有设置项，没有选择器。想改主对话的行为，**按名字覆盖基座**：
  `~/.shuvix/agents/work.md` 整个取代内置的 `work`（侧栏「智能体」分组里内置行菜单的「创建覆盖副本」给你当前文本作起点）。
- 任何 `name` 与内置同名的用户文件都取代那个内置。用户文件之间的同名按 `shuvix-files` 条目里的规则
  裁决；输的那几份列为已被覆盖。写坏的覆盖永远不会遮蔽内置。
- 基座**从不被派发、从不被点名**：`agent` 工具、hook 的 `shuvix-hook-agent`、子会话的 `agent_profile`
  都拒绝 `work` / `chat` / `notebook` / `bot` / `tab`。`permission-reviewer` 同样被 `agent` 工具与
  `agent_profile` 拒绝 —— 能随手调用自己审查员的 agent，可以一遍遍换说法直到某一种能过 —— 但 hook 可以点名它。

- **不复制覆盖也能定模型与思考档位：ShuviX 设置。** 从侧栏「智能体」分组打开一份内置 agent 的 md，虽然文件本身只读，
  属性里的**模型**与**思考档位**两行照样能改：选的值存在 ShuviX 里（那一行的值以强调色加点状下划线显示，悬停可见来源），按文件的 `shuvix-id` 挂，
  并且只**补**文件没写的键 —— 文件里写了的永远以文件为准，那一行也照旧只读。所以像 `explore` 这样的内置 agent
  不用复制覆盖文件就能换一个便宜的模型，每次更新照样拿到随包发布的新正文。覆盖副本沿用内置 id，因此共用同一套设置。
  在你自己的 agent 文件里，这两行照常改文件。agent 改不了 ShuviX 设置 —— 只有你能改。

## 一个 agent 怎样被用起来

1. **经 `agent` 工具派发为子代理**（调用方自己的列表须含 `agent`）：`name` = 本文件的 `name`，外加
   `prompt` 与一句 `description`。子代理在内存里作为根 agent 的同级运行，继承会话的模型与思考等级
   （`shuvix-model` / `shuvix-thinking` 声明了的以声明为准），拿到它自己文件里列的那几块（按根会话的工作目录与项目解析），最后把最终文本
   返回。这个工具**不会**向模型列举可用的 agent —— 名字得来自提示词或用户。
2. **作为子会话的人格** —— `session` 工具的 `agent_profile`（任何不是基座的 agent）。子会话保留从
   父会话抄来的 MCP 服务器；该 agent `shuvix-tools` 里的 `mcp:` 条目和列表里的其余各项一样生效，叠加在
   上面 —— 抄来的勾选里取消了的除外。
3. **作为 hook 的 agent**（`shuvix-hook-agent` —— 见 `hook-md` 条目）。
4. **作为基座覆盖**（见上）。

这些块在每种情况下都成立：`shuvix-prompt-blocks` 读的是**本文件**，而只要工具列表里有 `knowledge`，
知识库引导就会被追加。
