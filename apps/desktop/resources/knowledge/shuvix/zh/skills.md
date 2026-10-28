---
shuvix: okf v0.2
type: Guide
title: 'Skill（SKILL.md）在 ShuviX 里怎么被读取'
description: 'ShuviX 怎样发现、解析、启用与投递 skill —— 它真正读取的 SKILL.md frontmatter、各个 skill 来源（全局、项目、共用、外部目录）、`.config.json`、斜杠命令展开、`skill` 工具，以及哪些 agent 带着它。'
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

ShuviX 读四个 frontmatter 键，用的是**按行**的解析器（YAML 只帮多行的 `description`，见下）：

| 键            | 必填   | 含义                                                                                                                                                            |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | **是** | skill 的名字 —— 斜杠命令，以及 `skill` 工具列出的名字。单行；外层引号会被剥掉。保持简单的标识符（字母、数字、`-`）。                                              |
| `description` | 否     | 最好一行（YAML 的 `>` 多行块也读得到）。`skill` 工具给模型看的、斜杠命令弹层给用户看的都是它 —— 写成*什么时候该用这个 skill*，用用户或模型会去搜的词。 |
| `disable-model-invocation` | 否 | 写 `true` 就不上 `skill` 工具：只有用户能用 `/<name>` 调它。与 Claude Code 同一个键。 |
| `user-invocable` | 否 | 写 `false` 就不进 `/` 菜单：只有模型能加载它。与 Claude Code 同一个键。 |

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
其中有 `builtin:drawing` —— 内联 SVG 作图的手艺 —— 与 `builtin:widget` —— 构建与维护小组件。它们和别的
启用着的 skill 一样，在每个带 `skill` 工具的 agent 的货架上：`work`、`chat`、`coding`、`bot`、`notebook`、
`tab` 几个 agent 在 `shuvix-tools` 里写了它。关掉 `builtin:drawing`，之后新建的 agent 的系统提示里也就没有
作图那一段。

启用状态存在 `~/.shuvix/skills/.config.json`：

```json
{ "disabled": ["<name>", "<dirName>:<name>"], "disabledDirs": ["<dirName>"], "enabledDirs": ["agents"], "dirs": [{ "name": "<dirName>", "path": "/abs/path" }] }
```

`enabledDirs` 与 `disabledDirs` 方向相反，只管缺省关着的共用目录。

经侧栏「技能」分组改它（行菜单里的启用 / 停用）；这份文件是 ShuviX 的，不是手改的地方。

**读 skill 从不询问，改 skill 要问。** 内置 skill、`~/.shuvix/skills`、每个没被禁用的外部目录以及每个打开了的共用目录，都是
每条会话权限表里只读的行（`policy-md` 条目里的 `vars.aclRead`）：文件工具读它们不问，沙箱里的命令也能读。
往那里写要问 —— skill 是智能体自己要遵守的指令 —— 所以替用户新建或修改全局 / 外部 skill 要经过一次审批。
项目级 skill 在工作目录里，和项目里的其他文件一样对待。

## Skill 怎样到达模型

1. **斜杠命令** —— 在输入框输入 `/<name>`，skill 作为消息插入：`Base directory for this skill: <abs dir>`
   一行后跟正文，`${CLAUDE_SKILL_DIR}` 替换成 skill 目录、`${CLAUDE_SESSION_ID}` 替换成当前会话 id。
   整段正文以用户文本的身份进入对话。
2. **`skill` 工具** —— `shuvix-tools` 里写了 `skill` 的 agent 得到一个 `skill` 工具，其描述把**每个启用着的
   skill**（去掉写了 `disable-model-invocation: true` 的）列成 `<name> / <description> / file://<dir>`；模型带
   `name` 调用 `skill`，收到完整的 `SKILL.md` 正文加伴随文件的抽样清单，再自行读需要的。这是惰性的：模型
   要之前只列名字和描述，长 skill 没用到时几乎不占成本。用法与 Claude Code、Codex 相同：
   - **没有按会话、按项目的选择**：会话配置、输入框的工具选择器和项目设置里都没有技能一栏。不想让模型用某个
     skill，就在侧栏把它（或它所在的目录）关掉。
   - **在 agent 创建时定下**：货架在会话的 agent 创建时读入，跟着这个 agent 走。开关某个 skill 对之后新建的
     agent 生效；正在运行的 agent 保持原来的货架，直到它被重建（agent 标签上的 X），提示词缓存因此不会断。
   - **按 agent 文件**：写了 `skill` 就带上整个货架；agent 文件不能挑单个 skill（旧写法 `skill:<name>` 读作
     `skill`）。
   - 项目级 skill 在该项目里工作的 agent 的货架上。
3. **当作文件读** —— 没有什么拦着 agent 直接读 `SKILL.md`；上面两条机制只是省掉找路径这一步。

## 给 ShuviX 写一份好 skill

- 触发条件放 `description`，操作步骤放正文。模型在决定加载之前唯一能看到的就是描述。
- 正文自含、用祈使句；伴随文件用相对路径引用，文本会当斜杠命令用时用 `${CLAUDE_SKILL_DIR}`。
- 目录名与 skill 同名（`conventional-comments/SKILL.md`），两者永不漂移。
- 建完告诉用户去侧栏「技能」分组看（或者输入框里 `/<name>` 已经出现了）；全局 skill 下一次扫描即被读到，
  不用重启。
