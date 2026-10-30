## 这份文档是什么

<!-- shuvix:agent-start -->
这份文档是 ShuviX agents 目录里的一份**智能体档案**（`shuvix: agent v1`）：frontmatter 决定这个智能体的工具、模型和上下文（`shuvix-tools`、`shuvix-model`、`shuvix-instruction-files` ……），正文就是它的全部系统提示词。ShuviX 每次用它创建智能体时都重新读一遍，所以存下的改动作用于之后创建的智能体；正在跑的那个保持它启动时的版本。`name` 与某个内置档案（work、chat、coding、notebook ……）相同的文件会顶替那个内置档案。

<!-- shuvix:manual-start -->
完整规范 —— 每个键、占位符、什么会让文件无效、示例 —— 是 ShuviX 说明书条目 `<<manual>>agent-md.md`。改你没把握的地方之前先 `read` 它，不要从别的文件反推格式。
<!-- shuvix:manual-end -->
<!-- shuvix:agent-end -->

<!-- shuvix:bot-start -->
这份文档是一个 **bot 文件**（`shuvix: bot v2`）：正文是这个 bot 的人设与记忆，是和它的每一场对话的系统提示词的一部分，bot 自己也会改它来维护记忆。frontmatter 里只有 `name`、`description` 和 `shuvix-displayName` —— bot 的工具和模型由 ShuviX 决定，不由这份文件决定。存下的改动在这个 bot 各场对话的下一条消息生效；改 `name` 会把这些对话迁到新名字下。

<!-- shuvix:manual-start -->
完整规范是 ShuviX 说明书条目 `<<manual>>bot-md.md`。改你没把握的地方之前先 `read` 它，不要从别的文件反推格式。
<!-- shuvix:manual-end -->
<!-- shuvix:bot-end -->

<!-- shuvix:policy-start -->
这份文档是一条**安全策略**（`shuvix: policy v1`）。智能体的每次操作 —— 读写文件、运行命令、使用别的会话或小组件 —— ShuviX 都拿去和全部策略比对；条件匹配上的策略回答允许、询问或拒绝，询问先交给自动审查，再由它决定要不要交给用户。没有任何策略匹配的操作直接放行。文件一存下、能解析就生效，所以写错可能悄悄撤掉一道保护，也可能把某一类操作全部挡住。`name` 与某条内置策略相同的文件会顶替那条内置策略。

<!-- shuvix:manual-start -->
完整规范 —— 规则看到的请求文档、条件键、CEL `match`、效果及其优先级、什么会让文件无效、内置策略 —— 是 ShuviX 说明书条目 `<<manual>>policy-md.md`；远程访问的规则（`subject.kind: network`）在 `<<manual>>network-policy.md`，自动脱敏在 `<<manual>>redaction.md`。改你没把握的地方之前先 `read` 对应条目，不要从别的文件反推格式。
<!-- shuvix:manual-end -->
<!-- shuvix:policy-end -->

<!-- shuvix:hook-start -->
这份文档是一个 **hook**（`shuvix: hook v1`）：`shuvix-hook-on` 里点名的埋点触发、且它的 CEL `when` 成立时，ShuviX 运行 `shuvix-hook-agent` 指定的智能体，以这份正文为任务、附上事件。观察型埋点上它在后台跑，回答不被采用；决策型埋点 `permission.request` 上，它的回答决定一次审批请求。ShuviX 每次触发都重新读这份文件，所以存下的改动从下一次触发起生效。`name` 与某个内置 hook 相同的文件会顶替那个内置 hook。

<!-- shuvix:manual-start -->
完整规范 —— 各个键、埋点及其事件、`when`、内置 hook —— 是 ShuviX 说明书条目 `<<manual>>hook-md.md`。改你没把握的地方之前先 `read` 它，不要从别的文件反推格式。
<!-- shuvix:manual-end -->
<!-- shuvix:hook-end -->

<!-- shuvix:skill-start -->
这份文档是一个**技能的 `SKILL.md`**（Claude Code 也在用的 Agent Skills 格式）。`name` 是技能的标识 —— 它的启用开关按这个名字记；`description` 是智能体决定要不要加载这个技能前能看到的全部，正文是加载之后读到的内容；`SKILL.md` 旁边的文件是正文要它去看的材料。带技能工具的智能体拿到全部启用着的技能，存下的改动作用于之后创建的智能体。

<!-- shuvix:manual-start -->
完整规范是 ShuviX 说明书条目 `<<manual>>skills.md`。改你没把握的地方之前先 `read` 它，不要从别的文件反推格式。
<!-- shuvix:manual-end -->
<!-- shuvix:skill-end -->

<!-- shuvix:knowledge-start -->
这份文档是**知识库里的一篇笔记**。智能体用 `knowledge` 工具的 `search` 找笔记，它匹配的是标题、描述、标签和小标题 —— 不是正文 —— 所以能不能被找到取决于这几样。ShuviX 检查过的条目带 OKF frontmatter（`shuvix: okf v0.2`、`type`、`title`、`description`、`status`、`sources` ……）；`generated` 和 `verified` 由 ShuviX 盖章，绝不手写。

<!-- shuvix:manual-start -->
完整规范是 ShuviX 说明书条目 `<<manual>>knowledge-entry.md`。改 frontmatter 之前先 `read` 它，不要从别的笔记反推格式。
<!-- shuvix:manual-end -->
<!-- shuvix:knowledge-end -->

<!-- shuvix:checked-start -->
你改的时候 ShuviX 会检查这份文件：每次 `doc_edit` / `doc_insert` 的结果会说它是否仍能解析，`doc_read` 会说它现在能不能解析。解析不了的文件在修好之前不生效；用户在文档的属性卡上看到的是同一个判定。
<!-- shuvix:checked-end -->
