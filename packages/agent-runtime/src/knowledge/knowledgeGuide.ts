/**
 * 知识库引导 —— `<knowledge_bases>` 围栏的正文（围栏本身由 createAgent 加）。
 *
 * 它**不注入任何条目**：怎么把条目送进系统提示词还没定（原 `<knowledge>` 围栏整体撤除），
 * 这里只回答「这条会话手头有哪几个库、怎么进去」两件事。
 *
 * **按会话启用的库动态生成，一个库都没有就整段不注入。** 早先这段是静态的、以「这个项目有一个
 * 知识库」开篇，每个项目会话都得付一整段项目库说教；现在主角是用户自己的库，项目库只是其中一个
 * 名字，所以正文压到列表 + 三句话：列表告诉它手头有什么（不列出来它想不起来去查），三句话说
 * 「先搜、记下会被再查的、记完说一句」。别的规矩（元数据谁负责、怎么改条目）住在工具描述里，
 * 那份只在工具真被列出来时才付。
 *
 * 不给根路径是刻意的：库目录要到第一次 `create` 才有，而印出一条路径会诱导 agent 直接 `write`
 * 过去 —— 绕开只有 `create` 才担保的元数据形状。
 */

/** 围栏里列出的一个库 */
export interface KnowledgeGuideBase {
  /** 传给工具 `base` 的名字 */
  name: string
  /** 补充说明（项目库给项目名）；空串不印 */
  label?: string
}

/** 围栏正文；一个库都没启用返回 null —— 整段不注入，零成本 */
export function renderKnowledgeGuide(bases: readonly KnowledgeGuideBase[]): string | null {
  if (bases.length === 0) return null
  const lines = bases.map((b) => `- ${b.name}${b.label ? ` — ${b.label}` : ''}`)
  return `Knowledge bases this session works with — markdown entries that later sessions read. Name one with \`base\`:
${lines.join('\n')}

Use the \`knowledge\` tool: \`search\` (leave \`base\` out to cover all of them) before working on
something you do not already know the answer for, and \`create\` to record what will be looked up
again — a decision and why, a pitfall that cost time, a convention the code does not state — in
whichever base the subject belongs to. Say in one line what you recorded.`
}
