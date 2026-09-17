---
shuvix: okf v0.2
type: Guide
title: '知识库条目（shuvix: okf v0.2）'
description: 'ShuviX 知识库里一条笔记的完整规范 —— 什么是库、「读宽写严」、OKF profile 的每个 frontmatter 键、链接与 `shuvix://` 引用、文件命名、`knowledge` 工具的动作、校验分档，以及保留名。'
tags: [shuvix, knowledge, okf, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/conceptFile.ts
    title: conceptFile.ts —— 条目模型与构建器（事实源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/validate.ts
    title: validate.ts —— 校验分档
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/knowledgeTool.ts
    title: knowledgeTool.ts —— `knowledge` 工具
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/chat-protocol/src/knowledge.ts
    title: knowledge.ts —— type 与 status 词汇表
---

# 知识库条目

一个**知识库**是一个装 markdown 的目录；一条**条目**是其中的一份 `.md`。ShuviX 遵循 Open Knowledge
Format（OKF）v0.2，外加一个小小的自有 profile：frontmatter 是元数据，正文是知识，保留名只有
`index.md` 与 `log.md`。

## 库在哪里

| 库                  | 目录                                                                                      | 在 `knowledge` 工具里叫 |
| ------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| 用户自己的          | `~/.shuvix/knowledge/<name>/` —— **每个非隐藏子目录都是一个库**；不需要标记文件            | 目录名                  |
| 本项目的            | `~/.shuvix/knowledge-shuvix/projects/<projectId>/`（经工具写入，不手改）                    | `project`（保留名）     |
| ShuviX 的说明书     | 在应用内（只读，按界面语言）                                                              | `shuvix`（保留名）      |

一个库除了目录什么都不需要：把一个笔记文件夹拷进去，它就是一个库。隐藏的文件与目录（`.obsidian/`、
`.trash/`、`.git/`）永远不算库的内容。每个库各自有 git 历史：ShuviX 观察到的第一次写入会 `git init`
（若文件夹本无仓库），以文件夹当时的原貌为基线；之后每次观察到的改动都提交为 `kb(<op>): /path`，
带 `Knowledge-Op` / `Knowledge-Actor` trailer。

**一条会话用哪几个库由用户选择**（会话配置 → 知识库；项目配置设置其新会话的缺省）。没设过时缺省是
全部用户库 + 本项目的库（在项目里时）+ `shuvix`。选择是硬边界：`bases` 只列启用的，点名其他任何名字
都被拒绝。系统提示词里的 `<knowledge_bases>` 围栏列的也是同一批名字。

## 读宽写严

- 库里**每一份**非隐藏的 `.md` 都是一条**笔记**：出现在侧栏、可检索、可读 —— 标题依次取 frontmatter
  `title` → 第一个 `# 标题` → 文件名。不要求任何元数据，ShuviX 也从不为了补元数据改写用户的笔记。
- 一条笔记同时是一份 **OKF 条目（概念）**，当它的 frontmatter 能解析成映射、有非空字符串 `type`，
  且不带*别家的* `shuvix:` 标记（库里一份 `shuvix: agent v1` 文件是笔记，不是概念）。只有 `knowledge`
  工具 `create` 写出的东西**保证**合规。
- `index.md` 与 `log.md` 是 OKF 的保留名。ShuviX 不再生成它们；早先生成的按形状隐藏，而用户手写的
  同名文件是普通笔记（永远不是概念）。

## frontmatter 键（ShuviX profile）

按 `create` 写出的顺序：

| 键              | 类型                                                       | 必填                | 含义                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`        | `okf v0.2`                                                 | 否                  | 自述：「这是一份 OKF 条目，按 OKF v0.2 写」。笔记本据它选属性卡；没有它的笔记照样解析。任何别的 `shuvix:` 类型都表示「不是概念」。                                                                                                |
| `type`          | 字符串                                                     | **是**（概念必填）  | 这是哪一类东西。ShuviX 的开放词汇表：`Memory`、`Concept`、`Entity`、`Decision`、`Guide`、`Source` —— 其他值也允许，原样显示。                                                                                                     |
| `title`         | 字符串                                                     | 否                  | 显示标题。缺省：去掉 `.md` 的文件名。                                                                                                                                                                                            |
| `description`   | 字符串                                                     | 否                  | **一句话说明什么时候值得打开这条** —— `list` 与 `search` 显示的就是它，后来的会话据此决定要不要读。                                                                                                                                |
| `resource`      | 字符串                                                     | 否                  | 这条条目所代表的外部定位符（少见）。                                                                                                                                                                                             |
| `tags`          | 字符串列表（逗号分隔的字符串也能读）                       | 否                  | 自由标签。                                                                                                                                                                                                                       |
| `status`        | `draft` \| `stable` \| `deprecated`                        | 否                  | **生命周期**，缺省 `stable`：`draft` = 尚不完整，`stable` = 可以依赖，`deprecated` = 只为链接与历史留着（检索里剔除）。`create` 会显式写出。它**不是**审阅标志。                                                                    |
| `stale_after`   | `YYYY-MM-DD`                                               | 否                  | 过了这个日期条目需要重新核实（侧栏打徽标）。                                                                                                                                                                                     |
| `sources`       | `{ id?, resource, title?, author?, last_modified? }` 的列表（也可以是裸定位符字符串） | 否 | 结论来自哪里。`resource` 是自含的定位符：绝对路径（可带 `#symbol`）、完整 URL、`<remote-url>@<commit>:<path>`，或 `shuvix://session/<id>`。`id` 用于脚注引用 `[^id]`。                                                            |
| `generated`     | `{ by, at }`                                               | 否                  | **宿主章** —— 最后写这份文件的是谁（`shuvix-<agent>/<model>`）、何时（ISO 8601）。由 `create` 写下、每次 agent 编辑时由写钩子刷新。永远不要手写；侧栏的「新建条目」刻意不写它。                                                       |
| `verified`      | `{ by, at }` 或它们的列表                                  | 否                  | **审阅轴**：用户核实过这条的记录。只有界面动作才能写 —— **agent 永远不写**。信任档（未核实 / 机器确认 / 人工审阅）与「核实后又改过」徽标（`verified.at` 早于 `generated.at`）都由它推出。                                            |

未知键原样保留。形状不对的值报警告并取缺省；只有缺 frontmatter 或 `type` 缺失 / 为空才让一份文件
「不是概念」。

## 正文

Markdown。链接**同一个库**里的其他条目用 bundle 绝对的 markdown 链接 ——
`[Agent 定义文件](/agent-md.md)`，根是库目录；校验会对库内解析不到的链接发警告。要指向
**另一个库**里的东西或某条会话，用 `shuvix://` URI 而不是路径（链接检查跳过任何带 scheme 的目标）。
标题、代码围栏、脚注都是普通 markdown；开头的 `# 标题` 对没有 frontmatter 的笔记兼作标题。

## 文件名

`create` 从标题派生文件名：任何文字的字母与数字保留，其余连续字符变成 `-`，ASCII 转小写，截到 60 个
字符；名字已被占用则加 `-2`、`-3`……（保留名也算占用）。条目一律落在库的**根**；文件夹是用户自己组织
用的，也是侧栏「新建条目」的落点。

## 条目怎么写、怎么改

- **用 `knowledge` 工具新建**（`action: create`，带 `base`、`type`、`title`、`description`、`body`，
  可选 `tags` / `sources` / `stale_after` / `status`）。宿主拼 frontmatter（自述行、键序、归一的
  `type` / `status`、`generated`）、派生文件名、提交，并回一个绝对路径。永远不要用 `write` 新建条目 ——
  元数据就得你自己拼对。
- **用 `edit` 改动**，路径用 `search` / `list` / `read` / `create` 给的绝对路径 —— 一段精准 diff 胜过
  重发整篇正文。编辑之后写钩子会校验文件（诊断随工具结果回来）、刷新 `generated`、提交，侧栏跟着更新。
  之后跑一次 `validate`。
- **手写**（Obsidian、ShuviX 笔记本、任何编辑器）：不需要元数据；库下的人工编辑在下一次扫描时被读到，
  随下一次观察到的写入一起提交。侧栏的**新建条目**写的元数据与 `create` 相同（`type: Memory`、
  `status: draft`），只是不带 `generated`，署名 `human`。

**找一条条目分两步。** `search` 的索引里只有条目的**门面** —— 标题、描述、标签、type，外加正文里的
**标题行**，散文一概不进。所以结果只说「哪几条可能相关」，不说它们讲了什么：看标题与描述挑出真正对路
的那几条，再用 `read` 取正文。（早先把整篇正文入了索引：一个常见词就能拉回半个库，每条命中还拖一段
正文，真正要的那条反而被埋掉。）要在正文里找一个字面串 —— 报错信息、某个符号、一条 URL —— 用 `grep`
搜库的目录，每条清单都印着它的绝对路径。

`knowledge` 工具的其他动作：`bases`（本会话能点名哪些）、`search`（自由文本；不给 `base` 就搜启用的
全部库，按库分组 —— 各库索引独立、分数不跨库可比；中日文文本入索引前先分词）、`list`（一个库的全部
笔记）、`read`（按 bundle 相对路径读一条，如 `/foo.md`）、`validate`（一条笔记或整个库）。说明书库
`shuvix` 只读：在那里 `create` 被拒绝，往里写文件也被策略拒绝。

## 校验分档

- 带自述行的条目、或任何有 `type` 的笔记：严格的 OKF 检查 —— 缺 frontmatter 或 `type` 为 **error**；
  缺 `title` / `description`、非法 `status`、非日期的 `stale_after`、形状不对的 `generated` /
  `verified` / `sources`、库内解析不到的链接为 **warning**；
- 其他笔记：只在 YAML frontmatter 写坏时提醒；
- 生成的 `index.md` / `log.md`：从不检查。

校验是回执不是准入：写坏的条目照样写进去、照样列出。

## 该记什么

会被再查的东西：一个决定及其理由、一个花过时间的坑、代码里没写明的约定、一件费力才确认的事实 ——
记进这个主题所属的库。先搜，修订已经覆盖这个主题的那条，而不是加一条近似的重复；不要记仓库本身
已经写明的，也不要记只对当前这场对话有意义的。
