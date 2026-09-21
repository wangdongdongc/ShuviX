---
shuvix: okf v0.2
type: Guide
title: 'ShuviX 的自定义文件 —— 放在哪里、共用哪些规则'
description: '被要求新建、修复或解释任何 ShuviX markdown（agent、bot、policy、hook、知识库条目）或 skill 时先读这一篇 —— 目录地图、`shuvix:` 标记、同名遮蔽，以及文件怎样生效。'
tags: [shuvix, files, overview, format]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/chat-protocol/src/shuvixMdContract.ts
    title: shuvixMdContract.ts —— `shuvix:` 标记
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/registryShadowing.ts
    title: registryShadowing.ts —— 同名裁决
---

# ShuviX 的自定义文件

ShuviX 靠 **`~/.shuvix/` 下的 markdown 文件**定制。没有要建的数据库记录、没有「启用」开关、不用重启：
**一份存在且解析得过的文件，下一次用到时就已生效**。本篇是地图；每种文件在本知识库里各有一篇，
逐键给出完整规范。

## 目录地图

| 是什么                                                    | 放在哪里                                                                       | 标记行                   | 条目              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------ | ----------------- |
| **Agent** —— 一个 agent 运行所依据的人格 + 工具白名单     | `~/.shuvix/agents/<name>.md`                                                   | `shuvix: agent v1`       | `agent-md`        |
| **Bot** —— 绑在一条 bot 会话上的人设 + 记忆               | `~/.shuvix/bots/<name>.md`                                                     | `shuvix: bot v2`         | `bot-md`          |
| **安全策略** —— 一次工具调用是放行、询问还是拒绝           | `~/.shuvix/policies/<name>.md`                                                 | `shuvix: policy v1`      | `policy-md`       |
| **Hook** —— 会话事件发生时派发一个 agent                  | `~/.shuvix/hooks/<name>.md`                                                    | `shuvix: hook v1`        | `hook-md`         |
| **知识库条目** —— 用户某个知识库里的一条笔记               | `~/.shuvix/knowledge/<base>/**/*.md`                                           | `shuvix: okf v0.2`       | `knowledge-entry` |
| **Skill** —— 可复用的指令包（Agent Skills 格式）           | `~/.shuvix/skills/<name>/SKILL.md`、`<project>/.claude/skills/<name>/SKILL.md` | 无（要求 `name:`）       | `skills`          |

`~/.shuvix/` 下的其他东西是 ShuviX 自己的，不该手改：`knowledge-shuvix/`（ShuviX 维护的知识 bundle，
一个项目一个 —— 经 `knowledge` 工具写入）、`skills/.config.json`（哪些 skill 被禁用、注册了哪些额外
skill 目录）、`widgets/`、`tts/`、`cli-token`。旧的 `memory/`、`wikis/`、`workflows/` 是已退役的格式，
不再读取。

**内置的东西在应用里，不在磁盘上。** ShuviX 自带内置 agent（`work`、`chat`、`notebook`、`bot`、
`coding`、`explore`、`widget`、`titler`、`knowledge-writer`）、内置安全策略与一个内置 hook（`auto-title`）。没有内置 bot，也没有内置 skill。
内置的不能编辑，但可以**覆盖**：一份 `name` 与内置同名的用户文件会整个取代它（设置页各标签提供
「创建覆盖副本」，把内置的当前文本写进你的目录作为起点）。

## `shuvix:` 标记

每份 ShuviX 契约文件都以一段 YAML frontmatter 开头，其**第一个键**是文件类型标记：

```yaml
---
shuvix: agent v1
name: scout
---
```

值的形状是 `<type> v<version>`。type 说明这是什么文件（`agent`、`bot`、`policy`、`hook`，知识库条目是
`okf`）；version 是该格式自己的修订号（`v1`、`v2`），知识库条目则是它遵循的 OKF 规范版本（`v0.2`）。
解析器**只按 type 判别**，版本缺失或更新都容忍。

标记要求得多严，各类型不同 —— 精确规则在各自条目里：

- **agent、policy、知识库条目**：读取时可选（手写文件漏了它照样加载）；ShuviX 自己写出这类文件时恒带。
- **bot**：可选，但**类型不符即拒绝** —— 一份 agent 文件掉进 `bots/` 会被拒收，而不是被当成人设读进去。
- **hook**：**必需** —— 没有它的文件不是 hook。

各类型共用的相关规则：

- frontmatter 必须是**文件开头的第一样东西**（容忍 BOM 与前导空行），由两行 `---` 围起。里面是真正的
  YAML，用完整的 YAML 解析器读 —— 引号、多行字符串、注释都能用。正文中段出现的 `---` 块只是正文。
- `name` 缺省取**文件的基础名**（`scout.md` → `scout`），frontmatter 里可以覆盖。`shuvix-displayName`
  是界面上显示的人读标签。
- ShuviX 自有的键带 `shuvix-` 前缀（如 `shuvix-tools`、`shuvix-policy-rules`、`shuvix-hook-on`）。
  前缀是刻意的：同一份 markdown 被别的应用打开时，不该误读 `tools` 这类通用键。不带前缀的未知键一律忽略；
  未知的 `shuvix-` 键怎么处理因类型而异（hook 会拒绝）。
- `shuvix-builtin: true` 出现在 ShuviX 自带的文件里。解析器不读它，它只声明「这段文本出自内置集」。
  不要加进用户文件 —— 什么都不做。

## 非法文件整份拒绝

agent、bot、policy、hook 四个解析器共用一条哲学：结构非法的文件（没有 frontmatter、YAML 语法错、
frontmatter 不是映射、某个键类型不对、一条永远命中不了的规则……）**整份拒绝，绝不半生效**。被拒的
用户文件：

- 被运行时跳过 —— 永远不会遮蔽同名的内置；
- 在对应的设置页标签里列在「无法解析」下，附解析器给出的原因（侧栏 Bots 分组同样这样列出非法的 bot 文件）；
- 在它的笔记本属性卡上实时显示同一判定，边改边看。

知识库条目是有意的例外（「读宽写严」）：不是合规 OKF 概念的笔记仍然是一条笔记 —— 见 `knowledge-entry`。

## 同名遮蔽

几份文件写着同一个 `name` 时，恰有一份生效，其余列为**已被覆盖**（绝不静默跳过）：

1. 用户文件压过内置；
2. 同为用户文件，**文件名就是这个名字**的那份胜出（`scout.md` 压过 `scout copy.md`；文件名按新建文件
   时同一套净化规则比较 —— `\ / : * ? " < > |` 变成 `-`、去掉前导点 —— 且大小写不敏感）；
3. 其次文件名短的；
4. 最后按文件名的码点序（永远不按目录枚举顺序）。

运行时的生效集与设置页的列表是同一次裁决的两个视图，所以列表上标着生效的那一行就是真正在用的那份。

## 编辑与核对

在 ShuviX 里打开这类文件，打开的是一条**笔记本会话**：带 live preview 的 markdown 编辑器，frontmatter
有属性卡（已知键给下拉与选择器，解析器判定显示为徽标），自动保存。没有单独的编辑器，也没有保存按钮；
磁盘上的文件就是事实源，用任何编辑器改动都在下一次使用时被读到。

替用户新建或修改这类文件时：

- 用 `write` 工具按上表的确切路径写整份文件（或 `edit` 既有文件）；目录可能还不存在 —— 建出来。做覆盖
  副本时，以内置的当前文本（设置页「创建覆盖副本」，或本库各条目里引用的内置 `md`）为蓝本。
- 对带 `shuvix:` 标记的文件做 `write` / `edit`，工具结果会附上解析器的判定（文件照样写进去了 ——
  判定是回执，不是准入）。读它、把文件修好，而不是直接报告完成。
- 告诉用户文件会出现在哪里：设置 → Agent / 策略 / Hook，侧栏 Bots 分组、知识库分组，或 Skills 标签。
