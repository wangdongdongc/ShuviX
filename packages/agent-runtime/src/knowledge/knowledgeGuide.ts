/**
 * 项目知识库引导 —— `<project_knowledge>` 围栏的正文（围栏本身由 createAgent 加）。
 *
 * 它**不注入任何条目**：怎么把条目送进系统提示词还没定（原 `<knowledge>` 围栏整体撤除），
 * 这里只回答「这个项目有一个知识库、它装什么、怎么进去」三件事。因此文案是**静态**的 ——
 * 宿主不扫库、不数条目、不给路径，注入时零磁盘开销。
 *
 * 不给根路径是刻意的：库是懒建的，印一条还不存在的路径会诱导 agent 直接 `write` 过去，
 * 造出一个没有 `project.md` 的半拉 bundle，下一次解析又建一个 `-2`。新建一律经
 * `knowledge` 的 `create`，路径由它回执 —— 一扇门。
 *
 * 放在围栏里而不是 agent md 正文里，理由同项目记忆：它必须跟着 `shuvix-project-awareness`
 * 与「档案是否带 knowledge 工具」一起来一起走，否则会留下指向不存在之物的指令。
 *
 * 「记完告诉用户一句」而不是「每次写入先问」：旧项目记忆那条「先问」配的是一条内置策略与
 * 罕见的写入频率，而这里我们**鼓励**写入，逐次询问会直接把它掐死。写入落在用户自己的目录里，
 * 所以不能悄悄做 —— 事后报一行是这两者之间唯一说得通的位置。
 *
 * 文案压到最短：它每个项目会话必付。英文：模型面文本，与内置策略的 en 基准同源。
 */

/** 围栏正文（静态）。恒非空 —— 是否注入由调用方按项目 / 工具清单决定。 */
export function renderKnowledgeGuide(): string {
  return `This project has a knowledge base: markdown entries that later sessions of this project
read. It is the place for anything that will be looked up again — a decision and why it
went that way, a pitfall that cost time to find, a convention the code does not state, a
fact about the environment or a service that took work to establish. Not what the
repository already says, not what git history shows, not what matters only to this
conversation.

Reach it with the \`knowledge\` tool. Starting on something you do not already know this
project's answer for, \`search\` it first and \`read\` what matches — the base exists so the
same ground is not covered twice.

Recording one: \`knowledge\` \`create\` takes the type, title, one-line description and body,
assembles the metadata and answers with the entry's path — never create one with \`write\`,
the metadata has to be the host's. Revise an existing entry with \`edit\` at that path, then
\`knowledge\` \`validate\` it. Update the entry that already covers the subject rather than
adding a near-duplicate, and set \`status: deprecated\` on one that turns out to be wrong.
\`status\` is the entry's lifecycle and yours to judge; \`verified\` is the user's record of
having checked it — never write that one. Tell the user in one line what you recorded.`
}
