/**
 * 知识库引导 —— `<knowledge_bases>` 围栏的正文（围栏本身由 createAgent 加）。
 *
 * 它**不注入任何条目**：怎么把条目送进系统提示词还没定（原 `<knowledge>` 围栏整体撤除），
 * 这里只回答「这条会话手头有哪几个库、在哪、什么时候用」。
 *
 * **按会话启用的库动态生成，一个库都没有就整段不注入。** 列表告诉它手头有什么（不列出来它想不起来
 * 去查），几句话说「先搜、什么值得记什么不值得、记完说一句」。分工：这里管**什么时候用**，工具描述管
 * **怎么用**（写进目录、`submit` 过门、元数据谁负责）—— 同一句话不在两边各付一遍。
 *
 * **印出库目录**：条目由 agent 用 `write` 直接写进库里、再 `submit` 过门（写手补元数据），所以早先
 * 「印路径会诱导 agent 绕开 `create` 直接 write」的顾虑没了 —— 直接 write 正是现在的路，省一次 `bases`。
 * 项目库的目录可能还不存在：第一次 `write` 会连目录一起建出来。
 */

/** 围栏里列出的一个库 */
export interface KnowledgeGuideBase {
  /** 传给工具 `base` 的名字 */
  name: string
  /** 补充说明（项目库给项目名）；空串不印 */
  label?: string
  /** 库目录（绝对路径）；缺省不印 */
  dir?: string
}

/** 围栏正文；一个库都没启用返回 null —— 整段不注入，零成本 */
export function renderKnowledgeGuide(bases: readonly KnowledgeGuideBase[]): string | null {
  if (bases.length === 0) return null
  const lines = bases.map(
    (b) => `- ${b.name}${b.label ? ` — ${b.label}` : ''}${b.dir ? ` — ${b.dir}` : ''}`
  )
  return `Knowledge bases this session works with — name one with \`base\`:
${lines.join('\n')}

\`search\` them with the \`knowledge\` tool before working on something you do not already know the
answer for. Record what will be looked up again — a decision and why, a pitfall that cost time, a
convention the code does not state — in the base the subject belongs to, and submit it. Not what the
repository already states, or what only matters to this conversation. Say in one line what you
recorded.`
}
