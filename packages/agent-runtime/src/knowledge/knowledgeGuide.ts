/**
 * 知识库引导 —— `<knowledge_bases>` 围栏的正文（围栏本身由 createAgent 加）。
 *
 * 它**不注入任何条目**：怎么把条目送进系统提示词还没定（原 `<knowledge>` 围栏整体撤除），
 * 这里只回答「这条会话手头有哪几个库、什么时候用」。
 *
 * **按会话启用的库动态生成，一个库都没有就整段不注入。** 列表告诉它手头有什么（不列出来它想不起来
 * 去查），几句话说「先搜、什么值得记什么不值得、交了说一句」。2026-11-12 收紧了「什么值得记」：用户反馈工作会话
 * 把自己的中间过程（做了什么、试了什么、进度）当知识交上去，库很快膨胀 —— 现在明说做完的事不是知识、多数任务
 * 没有可交的，管理员删减或否决之后不换个说法再交。分工：这里管**什么时候用**，工具描述管
 * **怎么用**（读条目、`submit` 交给管理员）—— 同一句话不在两边各付一遍。
 *
 * **不印库目录**（2026-11-08）：库目录只有知识库管理员知道，别的 agent 按库名 + 条目名经 `knowledge` 读，
 * 要记的内容 `submit` 给管理员。
 */

/** 围栏里列出的一个库 */
export interface KnowledgeGuideBase {
  /** 传给工具 `base` 的名字 */
  name: string
  /** 补充说明（项目库给项目名）；空串不印 */
  label?: string
  /** 只读：手头全是只读的库时不教「搜了再干、记下来」—— 记不了，而说明书也不是每件事都该先搜的 */
  readonly?: boolean
  /** 这个库自己的一段说明（什么时候用它），由宿主给；印在通用说明之后 */
  note?: string
}

/** 围栏正文；一个库都没启用返回 null —— 整段不注入，零成本 */
export function renderKnowledgeGuide(bases: readonly KnowledgeGuideBase[]): string | null {
  if (bases.length === 0) return null
  const lines = bases.map((b) => `- ${b.name}${b.label ? ` — ${b.label}` : ''}`)
  const paragraphs = [
    `Knowledge bases this session works with — name one with \`base\`:\n${lines.join('\n')}`
  ]
  if (bases.some((b) => !b.readonly)) {
    paragraphs.push(`\`search\` them with the \`knowledge\` tool before working on something you do not already know the
answer for. Submit only what a later session will need and cannot read off the repository — a
decision and why, a limit or pitfall that will bite again, a convention the code does not state, a
standing preference of the user — to the base the subject belongs to, written as what holds, not
as what you did. Finished work is not knowledge: no record of what you changed, tried or tested,
no progress or plans. Most tasks leave nothing to submit. The librarian may keep only part of a
submission or turn it down; pass on what it said and do not submit it again. Say in one line what
you submitted.`)
  }
  for (const b of bases) if (b.note) paragraphs.push(b.note)
  return paragraphs.join('\n\n')
}
