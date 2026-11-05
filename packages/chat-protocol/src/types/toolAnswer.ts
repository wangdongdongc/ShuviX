/**
 * 工具行上「你怎么答的」的记录 —— 人在审批卡片上做的决定，答完之后留在对话里。
 *
 * 询问本身只在内存里（`PendingInputRequests`），答完就没了；工具结果也说不清有没有人批过。所以与
 * `toolReview.ts` 同一个做法：安全模块记下，宿主在工具收尾时写进 details 的保留键，随 toolResult 进会话树 ——
 * 重开、回退、分叉都跟着这条历史走。这个键不进模型上下文，也不是任何权限判断的依据：它只给人看。自动审查认的
 * 仍是安全模块自己记的反馈（`noteHumanFeedback`）。
 *
 * 选择题（`ask` 工具）不走这里：它的问题与答案本来就在自己的 details 上。
 */

/** details 里的保留键（工具自己的 details 不会用这个名字） */
export const TOOL_ANSWERS_DETAILS_KEY = 'shuvixAnswers'

export const TOOL_ANSWER_OUTCOMES = ['allowed', 'remembered', 'denied', 'feedback'] as const
export type ToolAnswerOutcome = (typeof TOOL_ANSWER_OUTCOMES)[number]

export interface ToolAnswerNote {
  /** allowed = 允许一次；remembered = 允许并记住；denied = 拒绝；feedback = 没有执行，人写了一段话 */
  outcome: ToolAnswerOutcome
  /** remembered：记住的是什么（路径 / 会话标题 / 组件名） */
  target?: string
  /** feedback：人写的那段话 */
  text?: string
}

/** 从工具结果的 details 里取出回答记录（一次调用可能过几道门）；没有或形状不对的项都跳过 */
export function toolAnswersOf(details: unknown): ToolAnswerNote[] {
  if (typeof details !== 'object' || details === null) return []
  const notes = (details as Record<string, unknown>)[TOOL_ANSWERS_DETAILS_KEY]
  if (!Array.isArray(notes)) return []
  const out: ToolAnswerNote[] = []
  for (const note of notes) {
    if (typeof note !== 'object' || note === null) continue
    const { outcome, target, text } = note as Record<string, unknown>
    if (!(TOOL_ANSWER_OUTCOMES as readonly unknown[]).includes(outcome)) continue
    out.push({
      outcome: outcome as ToolAnswerOutcome,
      ...(typeof target === 'string' && target !== '' ? { target } : {}),
      ...(typeof text === 'string' && text !== '' ? { text } : {})
    })
  }
  return out
}

/** 把回答记录并进 details（宿主在工具收尾时调用）；details 缺省时只带这一个键；没有记录时原样交回 */
export function withToolAnswers<D>(details: D, notes: readonly ToolAnswerNote[]): D {
  if (notes.length === 0) return details
  const base = typeof details === 'object' && details !== null ? details : {}
  return { ...base, [TOOL_ANSWERS_DETAILS_KEY]: notes } as D
}
