---
shuvix: okf v0.2
type: Guide
title: 'Bot 文件（shuvix: bot v2）'
description: 'ShuviX bot 文件的完整规范 —— 三个身份键、人设与记忆正文、bot 会话怎样绑定它、bot 能做与不能做什么，以及 bot 怎样维护自己的文件。'
tags: [shuvix, bot, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/bot/botFile.ts
    title: botFile.ts —— 解析器（事实源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/subagent/builtinAgents/md/bot.md
    title: bot.md —— bot 会话运行所依据的 `bot` 基座人格
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/security/builtinPolicies/md/protect-bot-files.md
    title: protect-bot-files —— bot 文件上的恒询问门
---

# Bot 文件

一个 **bot** 是绑在一条普通聊天会话上的一份 markdown：**三个身份键 + 一篇正文**。正文是这个 bot 的
**人设与记忆** —— 它是谁、怎么说话、对用户了解到了什么 —— 每一场与这个 bot 的对话都会把它追加到系统
提示词末尾。格式就这些：bot 文件不声明工具、模型或管线。bot *怎么*干活由内置的 `bot` 人格决定；
它跑在*什么*上（模型、扩展能力）是会话的事。

- 位置：`~/.shuvix/bots/<name>.md`。
- 标记：`shuvix: bot v2`。读取可选，但**类型不符即拒绝**：一份 agent 文件掉进 `bots/` 会被拒收，
  不会被当成人设读进去。版本不检查。
- 存在即生效，没有内置 bot，没有启用开关。

## 示例

```markdown
---
shuvix: bot v2
name: mentor
shuvix-displayName: Mentor
description: A patient writing coach who remembers what I am working on.
---

## Who I am

You are Mentor, a writing coach. You ask before you rewrite, you quote the sentence you are
talking about, and you never pad feedback with praise.

## What I remember

- The user is drafting a novel set in 1920s Shanghai; chapters live in ~/Documents/novel.
- Prefers feedback on structure first, prose second.
```

## frontmatter 键

| 键                    | 类型     | 必填 | 含义                                                                                              |
| --------------------- | -------- | ---- | ------------------------------------------------------------------------------------------------- |
| `shuvix`              | `bot v2` | 否   | 文件类型标记。类型不符 → 整份拒绝。                                                               |
| `name`                | 字符串   | 否   | bot 的稳定身份 —— bot 会话存在 `settings.bot` 里的就是它。缺省取文件基础名。                      |
| `shuvix-displayName`  | 字符串   | 否   | 侧栏与会话头部的标签。缺省 = `name`。给了必须是字符串。                                            |
| `description`         | 字符串   | 否   | 列表与「新建 bot 会话」选择框里的一句话。纯展示。给了必须是字符串。                                |

其余键一律忽略，只有一个例外：已退役的 v1 键 `shuvix-bot-pipeline`（管线时代 bot 点名一条 workflow
的那一块）照常解析，但会得到一条**请你删掉它**的警告 —— 它看起来像配置，其实什么都不控制。所以
`shuvix: bot v1` 文件仍然能用；只是那块残留是噪音。

非法（整份拒绝，在 Bots 分组里列为无法解析）：没有 frontmatter、YAML 语法错、frontmatter 不是映射、
`shuvix` 标记是别的类型，或 `shuvix-displayName` / `description` 不是字符串。

## 正文 —— 人设与记忆

去首尾空白后的正文会原样注入到绑定这个 bot 的每条会话的**根 agent**，套在
`<bot_profile name="…" file="…">` 围栏里，前面是一小段宿主前言，说明自我维护的规矩（见下）。
系统提示词在滚动压缩之外，所以这段注入在整场对话里都有效。

- **只有根 agent 拿到它。** bot 开出的子会话、派发出去的 agent 都按自己的 agent 文件生成系统提示词，
  从不看到 bot 的正文。「人设决定怎么说话，不决定怎么干活」是结构上的保证。
- 正文可以为空（刚建出来的 bot 就是），但至少保留新建模板预置的两个小标题（**我是谁** / **我记得什么**）：
  bot 用 `edit` 维护自己的文件，而 `edit` 需要既有文本来锚定。第一段归用户写，第二段归 bot。

## Bot 会话

**bot 会话**是带着 `settings.bot = <name>` 建出来的会话（侧栏 → 某个项目组的菜单 → 「新建 Bot 会话」→
选一个 bot）。绑定在创建那一刻定死、**永不改变** —— 换 bot 就是另开一条会话，因为历史全是那个 bot
说的话。除此之外它是一条普通有根会话：模型选择、扩展能力、压缩、导出、子会话与后台自动续跑一应照常。

它的根人格是内置的 **`bot`** 基座，工具列表刻意收窄：`read, ls, grep, glob, ask, edit, session, agent,
knowledge, artifact, skill:builtin:drawing` —— 没有 `bash`、`write`，也不声明内置能力服务器
`mcp:ssh` / `mcp:browser` / `mcp:database`（用户仍可在这条会话的扩展里勾上它们，那是用户自己的选择）。bot 看得见、
动不了：任何要改动或执行的事都得开一条子会话（编程活 → `agent_profile: coding`）。`edit` 只为一件事留着 —— 维护自己的文件 ——
而 `~/.shuvix/bots/` 下的每次写入都经内置策略 **protect-bot-files**，即使开了免询问也会问用户。
与 `notebook` 一样，这个基座声明项目感知但不读指令文件（AGENTS.md / CLAUDE.md 是给真正写代码的
子会话看的约定）。基座与任何内置 agent 一样可以按名字覆盖（`~/.shuvix/agents/bot.md`）。

## 生命周期备注

- **编辑** bot = 在 ShuviX 里打开它的文件（Bots 分组那一行），是一条笔记本会话：live preview、属性卡、
  自动保存。没有 bot 页面，没有保存按钮。
- **改名**：通过 frontmatter 的 `name` 改名后，ShuviX 下一次扫描目录时会把绑在旧名字上的会话迁过去
  （它比对每份文件这次的名字与上次看到的）；ShuviX 关着时做的改名，或者旧名 / 新名此刻仍被别的文件占用时，
  不迁。
- **删除**文件不动它的会话（会话是用户的）；会话头部的胶囊会显示 bot 已不在，会话就此跑在没有人设的
  基座上。
- 同名副本按 `shuvix-files` 条目里的规则处理 —— 输的那几份显示在胜出者下面，带删除线。
