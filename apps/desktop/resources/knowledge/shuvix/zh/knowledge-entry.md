---
shuvix: okf v0.2
type: Guide
title: '知识库条目（shuvix: okf v0.2）'
description: 'ShuviX 知识库里一条笔记的完整规范 —— 什么是库、「读宽写严」、OKF profile 的每个 frontmatter 键、链接与 `shuvix://` 引用、文件命名、`knowledge` 工具的动作、知识库管理员从一次提交里留什么、怎样让库保持整洁、校验分档，以及保留名。'
tags: [shuvix, knowledge, okf, format, spec]
status: stable
sources:
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/conceptFile.ts
    title: conceptFile.ts —— 条目模型与构建器（事实源）
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/validate.ts
    title: validate.ts —— 校验分档
  - resource: https://github.com/wangdongdongc/ShuviX/blob/main/packages/agent-runtime/src/knowledge/review.ts
    title: review.ts —— `submit` 交给知识库管理员的东西，以及它报上来的条目所盖的章
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
| 本项目的            | `~/.shuvix/knowledge-shuvix/projects/<projectId>/`（由知识库管理员写入，不手改）            | `project`（保留名）     |
| 本 bot 的           | `~/.shuvix/knowledge-shuvix/bots/<key>/`，`<key>` 由 bot 的身份算出 —— 它的 `shuvix-id`，文件没有时是 `name-<名字>`（由知识库管理员写入，不手改） | `bot`（保留名）         |
| ShuviX 的说明书     | 在应用内（只读，按界面语言）                                                              | `shuvix`（保留名）      |

一个库除了目录什么都不需要：把一个笔记文件夹拷进去，它就是一个库。隐藏的文件与目录（`.obsidian/`、
`.trash/`、`.git/`）永远不算库的内容。每个库各自有 git 历史：ShuviX 观察到的第一次写入会 `git init`
（若文件夹本无仓库），以文件夹当时的原貌为基线；之后每次观察到的改动都提交为 `kb(<op>): /path`，
带 `Knowledge-Op` / `Knowledge-Actor` trailer。

**属于项目的会话恒带本项目的库** `project`，排在最前 —— 关于这个项目学到的东西都记在那里，所以它不用勾
（配置卡里也不列它）。**其余的库由用户选择**（会话配置 → 扩展能力里的知识库一行，或输入框的工具选择器；
项目配置设置其新会话的缺省）。**bot 自己的会话同样恒带这个 bot 的库** `bot`，紧跟在 `project` 之后（见 `bot-md` 条目）：
bot 的定时运行、它的会话派出的 agent 也有它，bot 开的子会话没有。没设过时先跟父会话，再跟项目的缺省；谁都没选过，你自己的库一个都不启用。**每条会话还恒带 `shuvix`**，
排在最后：它和 `project`、`bot` 一样不用勾、配置卡里也不列，这样智能体随时查得到 ShuviX 自己的文件怎么写。选择是硬边界：`bases` 只列启用的，点名其他任何名字都被拒绝。系统提示词里的 `<knowledge_bases>` 围栏列的也是同一批名字。

**除知识库管理员以外的 agent 永远看不到库的目录。** 对它们来说，库就是它的名字，条目就是它在库里的
路径（`/auth/session.md`）：它们经 `knowledge` 工具 `search`、`list`、`read` 条目，把值得留下的东西
用 `submit` 交给管理员（见下）。这是工具与提示词的约定，不是锁：agent 若从别处找到了目录，没有什么拦得住它。

选择同时决定本会话碰什么不用问。启用的库是本会话权限表里**可读写**的一行（见 `policy-md` 条目里的
`vars.aclWrite`）—— 管理员就在发起提交的那条会话里运行、用文件工具写，所以在库里读、新建、挪动、删除
文件都不问；库的每次改动都提交进它自己的 git，可以回退。`shuvix` 是**只读**的一行（只在
`vars.aclRead` 里）。没启用的库和家目录里任何别的文件夹一样：读它要问。

## 读宽写严

- 库里**每一份**非隐藏的 `.md` 都是一条**笔记**：出现在侧栏、可检索、可读 —— 标题依次取 frontmatter
  `title` → 第一个 `# 标题` → 文件名。不要求任何元数据，ShuviX 也从不为了补元数据改写用户的笔记。
- 一条笔记同时是一份 **OKF 条目（概念）**，当它的 frontmatter 能解析成映射、有非空字符串 `type`，
  且不带*别家的* `shuvix:` 标记（库里一份 `shuvix: agent v1` 文件是笔记，不是概念）。只有知识库管理员
  在一次 `submit` 之后报上来、随后又过了严格检查的条目，才带 ShuviX 的机器确认。
- `index.md` 与 `log.md` 是 OKF 的保留名。ShuviX 不再生成它们；早先生成的按形状隐藏，而用户手写的
  同名文件是普通笔记（永远不是概念）。

## frontmatter 键（ShuviX profile）

按通常的顺序：

| 键              | 类型                                                       | 必填                | 含义                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shuvix`        | `okf v0.2`                                                 | 否                  | 自述：「这是一份 OKF 条目，按 OKF v0.2 写」。笔记本据它选属性卡；没有它的笔记照样解析。任何别的 `shuvix:` 类型都表示「不是概念」。                                                                                                |
| `type`          | 字符串                                                     | **是**（概念必填）  | 这是哪一类东西。ShuviX 的开放词汇表：`Memory`、`Concept`、`Entity`、`Decision`、`Guide`、`Source` —— 其他值也允许，原样显示。                                                                                                     |
| `title`         | 字符串                                                     | 否                  | 显示标题。缺省：去掉 `.md` 的文件名。                                                                                                                                                                                            |
| `description`   | 字符串                                                     | 否                  | **一句话说明什么时候值得打开这条** —— `list` 与 `search` 显示的就是它，后来的会话据此决定要不要读。                                                                                                                                |
| `resource`      | 字符串                                                     | 否                  | 这条条目所代表的外部定位符（少见）。                                                                                                                                                                                             |
| `tags`          | 字符串列表（逗号分隔的字符串也能读）                       | 否                  | 自由标签。                                                                                                                                                                                                                       |
| `status`        | `draft` \| `stable` \| `deprecated`                        | 否                  | **生命周期**，缺省 `stable`：`draft` = 尚不完整，`stable` = 可以依赖，`deprecated` = 只为链接与历史留着（检索里剔除）。提交时会显式写出。它**不是**审阅标志。                                                                    |
| `stale_after`   | `YYYY-MM-DD`                                               | 否                  | 过了这个日期条目需要重新核实（侧栏打徽标）。                                                                                                                                                                                     |
| `sources`       | `{ id?, resource, title?, author?, last_modified? }` 的列表（也可以是裸定位符字符串） | 否 | 结论来自哪里。`resource` 是自含的定位符：绝对路径（可带 `#symbol`）、完整 URL、`<remote-url>@<commit>:<path>`，或 `shuvix://session/<id>`。`id` 用于脚注引用 `[^id]`。                                                            |
| `generated`     | `{ by, at }`                                               | 否                  | **宿主章** —— 内容是谁写的（`shuvix-<agent>/<model>`）、何时（ISO 8601）。agent 每次编辑条目时由写钩子刷新；管理员在一次 `submit` 之后报上来的条目，改记为提交它的 agent。永远不要手写；侧栏的「新建条目」刻意不写它。 |
| `verified`      | `{ by, at }` 或它们的列表                                  | 否                  | **审阅轴**：谁检查过这条。人的核实（`by: human:…`）只由界面动作写；管理员在一次 `submit` 之后报上来的每一条，都得到它的机器确认（`by: shuvix-knowledge-writer/<model>`，取代早先那一条）。**agent 永远不写它。** 信任档 —— 机器确认或人工审阅，只算不早于 `generated.at` 的那几条 —— 与「核实后又被修改」徽标（每一条都早于 `generated.at`）都由它推出。 |

未知键原样保留。形状不对的值报警告并取缺省；只有缺 frontmatter 或 `type` 缺失 / 为空才让一份文件
「不是概念」。

## 正文

Markdown。链接**同一个库**里的其他条目用 bundle 绝对的 markdown 链接 ——
`[Agent 定义文件](/agent-md.md)`，根是库目录；校验会对库内解析不到的链接发警告。要指向
**另一个库**里的东西或某条会话，用 `shuvix://` URI 而不是路径（链接检查跳过任何带 scheme 的目标）。
标题、代码围栏、脚注都是普通 markdown；开头的 `# 标题` 对没有 frontmatter 的笔记兼作标题。

## 文件名

管理员按主题给条目的文件起名，之后也可以给它改名或挪动，并改好指向旧名字的链接。在库里，`write` 拒绝覆盖 agent
没读过的既有文件，所以挑中一个已被占用的名字不会悄悄换掉别人的条目。侧栏的**新建条目**从标题派生文件名：
任何文字的字母与数字保留，其余连续字符变成 `-`，ASCII 转小写，截到 60 个字符；名字已被占用则加 `-2`、
`-3`……（保留名也算占用）。

## 条目怎么写、怎么改

- **提交它**（`knowledge`，`action: submit`，带 `base` 和 `content`）：写成普通 markdown，说清什么成立、
  每个说法出自哪里（路径、URL 或 commit）；是在更正或扩充某一条时，再加上 `entry` 指明那一条。ShuviX
  当场在发起提交的那场对话里让内置的知识库管理员（`knowledge-writer` agent）处理它。管理员是唯一写库的
  agent，提交对它来说只是提议、不是命令：它只留以后的会话用得上、又没法从仓库里直接读出来的内容（见下面
  「该记什么」），所以可能只记下提交的一部分 —— 一次排查只留结论，不留是怎么查出来的 —— 也可能不收，并说明
  留了什么、为什么。它先看库里已经有什么，再决定留下的内容怎么记 —— 新建一条，或改动已有的（扩充、更正、
  拆分、合并、改名、挪动、标成 `deprecated` 或删除）。它还会顺手收拾这次提交落进去的那一块：讲同一件事的
  几条并成一条；没有任何长期价值的条目，把其中能留的并进讲那件事的条目后删掉；条目超过一打左右的文件夹
  按主题分进子文件夹。然后回报它动过的条目和一份简短的报告。它在库目录里用文件工具写（`read`、`write`、
  `edit`、`move`、`delete`、`grep`），给它写的每一条都配上上面那套 frontmatter，用户自己的笔记（没有
  frontmatter 的文件）保持原样，经人核实过的条目不并掉、不删，也绝不为核实提交的事实去打开库以外的任何
  东西。之后 ShuviX 给它报上来、又过了严格检查的每一条盖章：`generated`（提交者）与 `verified`（管理员的
  机器确认）。只是被挪动或改名的条目（原文没变）保留原来的章。管理员只能经 `knowledge` 工具调起 ——
  `agent` 工具派不出它 —— 它的模型按通用规则来（它的 md 里的 `shuvix-model`，否则跟随调用方）。想改它留
  什么、怎么组织库，就覆盖 `~/.shuvix/agents/knowledge-writer.md`。
- **让管理员整理一个库**（`knowledge`，`action: organize`，带 `base`；用户有具体要求时写进 `content`）：给已经
  变乱的库用。什么都不提交；管理员照同样的办法把整个库过一遍 —— 合并讲同一件事的条目、删掉没有长期价值
  的、把其余的按主题分进文件夹、改好链接 —— 然后报告它改了什么。每一处改动都是库自己 git 历史里的一次
  提交，可以回滚。它改写过的条目，`generated` 与 `verified` 都记管理员；只是挪动的条目保留原来的章。
- **从另一个项目迁过来**（`knowledge`，`action: migrate`，带 `project`、`entries` 和 `base`）：拆分项目时，
  由新项目里一条会话的 agent 把条目从另一个项目自己的库里迁过来。ShuviX 读出点名的条目，原样交给接收库的
  管理员 —— agent 不重抄正文。管理员逐条原样收下、并进已经讲这件事的那一条，或者不收，并报告收了哪几条；
  ShuviX 给它写下的条目盖章（与提交之后相同），再只把它收下的那几条从另一个项目的库里删掉。挑条目时，
  agent 先用 `list`、`search` 或 `read` 加上 `project`（另一个项目的名字）看那个库。那个库不在本会话的
  权限表里，所以读它、改它各会先问一次。拆分项目见 `moving-sessions` 条目。
- **手写**（Obsidian、ShuviX 笔记本、任何编辑器）：不需要元数据；库下的人工编辑在下一次扫描时被读到，
  随下一次观察到的写入一起提交。侧栏的**新建条目**自己写好全套元数据（`type: Memory`、
  `status: draft`），只是不带 `generated`，署名 `human`。

**找一条条目分两步。** `search` 的索引里只有条目的**门面** —— 标题、描述、标签、type，外加正文里的
**标题行**，散文一概不进。所以结果只说「哪几条可能相关」，不说它们讲了什么：看标题与描述挑出真正对路
的那几条，再用 `read` 读那几条。（早先把整篇正文入了索引：一个常见词就能拉回半个库，每条命中还拖一段
正文，真正要的那条反而被埋掉。）

`knowledge` 工具的动作：`bases`（本会话能点名哪些）、`search`（自由文本；不给 `base`
就搜启用的全部库，按库分组 —— 各库索引独立、分数不跨库可比；中日文文本入索引前先分词）、`list`（一个
库的全部笔记）、`read`（按库内路径读一条，长的用 `offset` / `limit`）、`submit`、`organize` 与 `migrate`
（见上）。结果里的条目一律写库内路径；只有管理员的调用才同时显示库的目录。说明书库 `shuvix` 只读：在那里
`submit` 与 `organize` 被拒绝；反正应用更新时会还原随包发布的文件。

## 校验分档

- 带自述行的条目、或任何有 `type` 的笔记：严格的 OKF 检查 —— 缺 frontmatter 或 `type` 为 **error**；
  缺 `title` / `description`、非法 `status`、非日期的 `stale_after`、形状不对的 `generated` /
  `verified` / `sources`、库内解析不到的链接为 **warning**；
- 其他笔记：只在 YAML frontmatter 写坏时提醒；
- 生成的 `index.md` / `log.md`：从不检查。

写钩子的校验是回执不是准入：写坏的条目照样写进去、照样列出。`submit` 之后的盖章才是那道门 —— 过不了
严格检查的条目 ShuviX 从不盖章。

## 该记什么

只记这样的内容：几个月后做这件事的人没有参加这场对话，他用得上，又没法从仓库里直接读出来 —— 一个决定及其
理由、系统或它周边环境的一条代码里没写明的限制或行为、一个还会再咬人的坑（成因和怎么认出它）、一条约定或
用户的一条长期偏好、一件会反复做的事怎么做。用 `submit` 交给这个主题所属的库，写成「什么成立」而不是
「发生过什么」。先搜；这次提交若是在扩充已经覆盖这个主题的那条，就点名那一条。

不是知识、管理员也不会收的：一次工作的记录（做了什么、改了什么、试过什么、测了什么，动了哪些文件和提交 ——
仓库的历史里都有）、一个已经修好的问题（除非修完之后还有会约束以后工作的东西成立）、某件事在某一刻的状态
（进度、待办、计划、一次测试的结果、一次测量）、代码已经写明的，以及库里已经有的。多数任务没有什么可提交的。
管理员只留了一部分或不收时，把它的说法转告用户，不要再交一次。
