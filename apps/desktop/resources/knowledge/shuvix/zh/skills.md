---
shuvix: okf v0.2
type: Guide
title: 'Skill（SKILL.md）在 ShuviX 里怎么被读取'
description: 'ShuviX 怎样发现、解析、启用与投递 skill —— 它真正读取的 SKILL.md frontmatter、各个 skill 来源（全局、项目、共用、外部目录）、`.config.json`、斜杠命令展开、`skill` 工具，以及 agent 文件与会话扩展能力里的 `skill:<name>`。'
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

ShuviX 恰好读两个 frontmatter 键，用的是**按行**的解析器（YAML 只帮多行的 `description`，见下）：

| 键            | 必填   | 含义                                                                                                                                                            |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | **是** | skill 的名字 —— 斜杠命令，以及 `skill:<name>` 里用的值。单行；外层引号会被剥掉。保持简单的标识符（字母、数字、`-`）。                                              |
| `description` | 否     | 最好一行（YAML 的 `>` 多行块也读得到）。`skill` 工具给模型看的、斜杠命令弹层给用户看的都是它 —— 写成*什么时候该用这个 skill*，用用户或模型会去搜的词。 |

解析器的规则：文件必须以 `---` 开头；frontmatter 到下一个 `---` 结束；每行按第一个 `:` 切分。写成多行的
`description` —— YAML 的 `>` / `|` 块，或者一句话折到下一行缩进接着写 —— 在 frontmatter 是合法 YAML 时
经 YAML 读出；其余的值（`name` 永远在内）都照按行读到的样子。缺 `name` 时 frontmatter 整个不被认出：目录名成为名字，**整份文件（含 frontmatter 文字）**成为
skill 的内容。闭合 `---` 之后的全部内容是 skill 的正文。

ShuviX 只读 `SKILL.md`。伴随文件留给 agent 在加载 skill 之后用 `read` 打开；用相对于 skill 基础目录的
路径引用它们。

## Skill 在哪里

| 来源       | 路径                                        | ShuviX 看到的名字     | 启用状态                                                     |
| ---------- | ------------------------------------------- | --------------------- | ------------------------------------------------------------ |
| 全局       | `~/.shuvix/skills/<dir>/SKILL.md`           | `<name>`              | 缺省开启；可禁用                                             |
| 项目       | `<project>/.claude/skills/<dir>/SKILL.md`   | `<name>`              | 对该项目里的会话**恒开启**；名字撞车时优先                   |
| 共用目录   | `~/.claude/skills/<dir>/SKILL.md`、`~/.agents/skills/<dir>/SKILL.md` | `claude:<name>`、`agents:<name>` | **缺省关闭**；在目录行的菜单里整个打开 |
| 外部目录   | 从侧栏「技能」分组添加的任意文件夹          | `<dirName>:<name>`    | 缺省开启；整个目录或单个 skill 都可禁用                      |
| 内置       | 随应用发布，只读                            | `builtin:<name>`      | 缺省开启；可禁用                                             |

两个**共用目录**是别的智能体工具在用的：`~/.claude/skills` 是 Claude Code 的，`~/.agents/skills` 是
Agent Skills 的跨工具约定位置（Codex、pi 读它，`npx skills add -g` 把真目录放在这里）。ShuviX 不用添加
就列出它们 —— 里面有 skill 时各占一行，这一行移不掉 —— 但在用户把目录打开之前一直**关着**，因为里面的
东西是为别的工具装的。里面的 skill 是用户自己的文件，点开是可编辑的笔记。技能目录里的符号链接不算 skill，
所以 `npx skills add` 链进 `~/.claude/skills` 的那份只在 `agents` 下出现一次。同一个文件夹早先已经加成
外部目录的，归那一条。

目录名与 `name` 可以不同；ShuviX 按 `name` 匹配。内置 skill 随应用发布（按界面语言一个目录），不能编辑；
目前只有一个 `builtin:drawing` —— 内联 SVG 作图的手艺 —— `work`、`chat`、`coding`、`bot`、`notebook`、
`coedit`、`tab` 几个 agent 在 `shuvix-tools` 里点了它的名。启用状态存在 `~/.shuvix/skills/.config.json`：

```json
{ "disabled": ["<name>", "<dirName>:<name>"], "disabledDirs": ["<dirName>"], "enabledDirs": ["agents"], "dirs": [{ "name": "<dirName>", "path": "/abs/path" }] }
```

`enabledDirs` 与 `disabledDirs` 方向相反，只管缺省关着的共用目录。

经侧栏「技能」分组改它（行菜单里的启用 / 停用）；这份文件是 ShuviX 的，不是手改的地方。

**读 skill 从不询问，改 skill 要问。** 内置 skill、`~/.shuvix/skills`、每个没被禁用的外部目录以及每个打开了的共用目录，都是
每条会话的只读目录（`policy-md` 条目里的 `vars.sessionReadDirs`）：文件工具读它们不问，沙箱里的命令也能读。
往那里写要问 —— skill 是智能体自己要遵守的指令 —— 所以替用户新建或修改全局 / 外部 skill 要经过一次审批。
项目级 skill 在工作目录里，和项目里的其他文件一样对待。

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
     存在期间只读。会话的 agent 文件声明的条目也列在那里，显示为已勾、锁住：不管怎么选，它们都开着。
   - **按 agent 文件**：agent md 里 `shuvix-tools: …, skill:<name>` —— 不管会话选了什么，那个 agent
     总有这个 skill。
   - 项目级 skill 对在该项目里工作的任何根 agent 的 `skill` 工具都可见。
3. **当作文件读** —— 没有什么拦着 agent 直接读 `SKILL.md`；上面两条机制只是省掉找路径这一步。

## 给 ShuviX 写一份好 skill

- 触发条件放 `description`，操作步骤放正文。模型在决定加载之前唯一能看到的就是描述。
- 正文自含、用祈使句；伴随文件用相对路径引用，文本会当斜杠命令用时用 `${CLAUDE_SKILL_DIR}`。
- 目录名与 skill 同名（`conventional-comments/SKILL.md`），两者永不漂移。
- 建完告诉用户去侧栏「技能」分组看（或者输入框里 `/<name>` 已经出现了）；全局 skill 下一次扫描即被读到，
  不用重启。
