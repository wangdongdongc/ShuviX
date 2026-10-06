/**
 * 工具卡上的「已审查」标记 —— 自动审查放行了这次调用（设计稿 docs/permission-review-design.md §11）。
 *
 * 载体是工具结果的 details：宿主在工具执行完之后，把放行它的那次审查写进 details 的保留键，随
 * toolResult 进会话树 —— 实时的会话视图与重开会话读的是同一份投影，卡片两边一样。
 * details 本身按工具各有形状（ToolResultDetails 按 type 判别），这个键刻意不进那张联合类型：
 * 写入只有宿主一处，读取一律经 toolReviewOf，形状不对就当没有。
 *
 * 拒绝不需要标记（红行的文字就是审查员的理由）；转给人的那次由人拍板，也不挂 —— 这枚标记回答的
 * 只是「这一步没人看过，是审查员放行的」。
 */
import { PERMISSION_RISKS, type PermissionRisk } from './permissionReview'

/** details 里的保留键（工具自己的 details 不会用这个名字） */
export const TOOL_REVIEW_DETAILS_KEY = 'shuvixReview'

/** 放行这次调用的那次审查：风险等级与写给人看的一句话 */
export interface ToolReviewNote {
  risk: PermissionRisk
  /** 审查员对这次操作的一句话描述（会话的语言） */
  summary: string
}

/** 从工具结果的 details 里取出审查标记；没有或形状不对返回 undefined */
export function toolReviewOf(details: unknown): ToolReviewNote | undefined {
  if (typeof details !== 'object' || details === null) return undefined
  const note = (details as Record<string, unknown>)[TOOL_REVIEW_DETAILS_KEY]
  if (typeof note !== 'object' || note === null) return undefined
  const { risk, summary } = note as Record<string, unknown>
  if (!(PERMISSION_RISKS as readonly unknown[]).includes(risk)) return undefined
  return { risk: risk as PermissionRisk, summary: typeof summary === 'string' ? summary : '' }
}

/** 把审查标记并进 details（宿主在工具执行完之后调用）；details 缺省时只带这一个键 */
export function withToolReview<D>(details: D, note: ToolReviewNote): D {
  const base = typeof details === 'object' && details !== null ? details : {}
  return { ...base, [TOOL_REVIEW_DETAILS_KEY]: note } as D
}
