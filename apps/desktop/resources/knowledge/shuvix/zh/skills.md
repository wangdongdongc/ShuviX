---
shuvix: okf v0.2
type: Guide
title: 'Skill（SKILL.md）在 ShuviX 里怎么被读取'
description: 'ShuviX 怎样发现、解析、启用与投递 skill —— 它真正读取的 SKILL.md frontmatter、三个 skill 来源（全局、项目、外部目录）、`.config.json`、斜杠命令展开、`skill` 工具，以及 agent 文件与会话扩展能力里的 `skill:<name>`。'
tags: [shuvix, skills, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/services/skillService.ts
    title: skillService.ts —— 发现、解析、启用状态、斜杠命令展开（事实源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/apps/desktop/src/main/services/skillTool.ts
    title: skillTool.ts —— 按需加载 skill 的 `skill` 工具
---

# Skill

一个 **skill** 是可复用的指令包：一个目录，里面一份 `SKILL.md`，可选地带伴随文件（脚本、模板、参考
资料）。ShuviX 用的是社区的 **Agent Skills** 布局 —— 同一批文件在别的工具里也能用 —— 格式上不加任何
东西；ShuviX 特有的是 skill *在哪里*被找到、*怎样*启用、*怎样*送到 agent 手里。

## 文件

```markdown
---
name: conventional-comments
description: Use when reviewing code or writing review comments — the conventional-comments labels (praise, nitpick, suggestion, issue, …) and when each applies.
---

# Conventional comments

Prefix every review comment with a label…
Scripts for this skill live in ${CLAUDE_SKILL_DIR}/scripts.
```

ShuviX 恰好读两个 frontmatter 键，用的是**按行**的解析器（不是 YAML 解析器）：

| 键            | 必填   | 含义                                                                                                                                                            |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | **是** | skill 的名字 —— 斜杠命令，以及 `skill:<name>` 里用的值。单行；外层引号会被剥掉。保持简单的标识符（字母、数字、`-`）。                                              |
| `description` | 否     | 一行。`skill` 工具给模型看的、斜杠命令弹层给用户看的都是它 —— 写成*什么时候该用这个 skill*，用用户或模型会去搜的词。单行，引号会被剥掉。                           |

解析器的规则：文件必须以 `---` 开头；frontmatter 到下一个 `---` 结束；每行按第一个 `:` 切分；**不支持**
多行值。缺 `name` 时 frontmatter 整个不被认出：目录名成为名字，**整份文件（含 frontmatter 文字）**成为
skill 的内容。闭合 `---` 之后的全部内容是 skill 的正文。

ShuviX 只读 `SKILL.md`。伴随文件留给 agent 在加载 skill 之后用 `read` 打开；用相对于 skill 基础目录的
路径引用它们。

## Skill 在哪里

| 来源       | 路径                                        | ShuviX 看到的名字     | 启用状态                                                     |
| ---------- | ------------------------------------------- | --------------------- | ------------------------------------------------------------ |
| 全局       | `~/.shuvix/skills/<dir>/SKILL.md`           | `<name>`              | 缺省开启；可禁用                                             |
| 项目       | `<project>/.claude/skills/<dir>/SKILL.md`   | `<name>`              | 对该项目里的会话**恒开启**；名字撞车时优先                   |
| 外部目录   | 设置 → Skills 里注册的任意文件夹            | `<dirName>:<name>`    | 缺省开启；整个目录或单个 skill 都可禁用                      |

目录名与 `name` 可以不同；ShuviX 按 `name` 匹配。没有内置 skill。启用状态存在
`~/.shuvix/skills/.config.json`：

```json
{ "disabled": ["<name>", "<dirName>:<name>"], "disabledDirs": ["<dirName>"], "dirs": [{ "name": "<dirName>", "path": "/abs/path" }] }
```

经设置 → Skills 改它；这份文件是 ShuviX 的，不是手改的地方。

## Skill 怎样到达模型

1. **斜杠命令** —— 在输入框输入 `/<name>`，skill 作为消息插入：`Base directory for this skill: <abs dir>`
   一行后跟正文，`${CLAUDE_SKILL_DIR}` 替换成 skill 目录、`${CLAUDE_SESSION_ID}` 替换成当前会话 id。
   整段正文以用户文本的身份进入对话。
2. **`skill` 工具** —— 会话（或 agent 文件）启用了 `skill:<name>` 条目时，agent 得到一个 `skill` 工具，
   其描述把启用的 skill 列成 `<name> / <description> / file://<dir>`；模型带 `name` 调用 `skill`，收到
   完整的 `SKILL.md` 正文加伴随文件的抽样清单，再自行读需要的。这是惰性的：模型不要就什么都不注入，
   长 skill 没用到时零成本。
   - **按会话**：会话配置的扩展能力一节（以及输入框的工具选择器）—— 存在会话的 `settings.enabledTools`
     里，形如 `skill:<name>`；项目自己的缺省会种进新会话；这份选择在会话的 agent 创建时读一次，agent
     存在期间只读。
   - **按 agent 文件**：agent md 里 `shuvix-tools: …, skill:<name>` —— 不管会话选了什么，那个 agent
     总有这个 skill。
   - 项目级 skill 对在该项目里工作的任何根 agent 的 `skill` 工具都可见。
3. **当作文件读** —— 没有什么拦着 agent 直接读 `SKILL.md`；上面两条机制只是省掉找路径这一步。

## 给 ShuviX 写一份好 skill

- 触发条件放 `description`，操作步骤放正文。模型在决定加载之前唯一能看到的就是描述。
- 正文自含、用祈使句；伴随文件用相对路径引用，文本会当斜杠命令用时用 `${CLAUDE_SKILL_DIR}`。
- 目录名与 skill 同名（`conventional-comments/SKILL.md`），两者永不漂移。
- 建完告诉用户去设置 → Skills 看（或者输入框里 `/<name>` 已经出现了）；全局 skill 下一次扫描即被读到，
  不用重启。
