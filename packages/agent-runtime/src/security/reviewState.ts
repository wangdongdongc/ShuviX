/**
 * 自动审查的拒绝计数（按会话，进程内存）。
 *
 * 同一会话被审查员**连续**拒绝 3 次、或**累计**拒绝 20 次之后，这个会话的询问跳过审查、直接交给人
 * （Claude Code auto mode 用的同一组阈值）。这是一条会话内的覆盖出口：没有它，一个判错又固执的
 * 审查员会让 agent 反复撞墙，而用户能做的只剩关掉整个保护。
 *
 *  - 连续计数：一次审查放行、或人回答了一次询问，就清零 —— 人回答之后审查照常恢复；
 *  - 累计计数：不清零，到 20 之后本会话都直接问人（会话销毁时 clearReviewState 清掉）。
 *
 * 与决策日志一样只活在内存里：重启即归零，不值得为它建表。
 *
 * 同一处还记着审查的另外两份会话内状态：
 *  - **人在审批卡片上写的反馈**：执行层在收到人的回答时记下。审查员的输入只收人写的东西，而卡片
 *    反馈落进会话树时只是一段工具结果文字 —— 任何命令都能打印出同样的开头，按文字认就是给注入
 *    开门。所以只认这里：只有安全模块自己收到的回答才会进来。
 *  - **进行中的审查**：会话被停止时一并中止，并在下一次 prompt 之前不再开始新的 —— 与询问卡片同一
 *    待遇（HarnessSession 的 inputsClosed）。否则一次放行会在用户点了停止之后才落地。
 */

export const REVIEW_CONSECUTIVE_DENIAL_LIMIT = 3
export const REVIEW_TOTAL_DENIAL_LIMIT = 20

interface ReviewState {
  consecutive: number
  total: number
}

const states = new Map<string, ReviewState>()

/** 这个会话的询问是否已不再先交给审查（阈值到了） */
export function reviewSuspended(sessionId: string): boolean {
  const state = states.get(sessionId)
  if (!state) return false
  return (
    state.consecutive >= REVIEW_CONSECUTIVE_DENIAL_LIMIT || state.total >= REVIEW_TOTAL_DENIAL_LIMIT
  )
}

/** 审查员拒绝了一次 */
export function noteReviewDenied(sessionId: string): void {
  const state = states.get(sessionId) ?? { consecutive: 0, total: 0 }
  state.consecutive += 1
  state.total += 1
  states.set(sessionId, state)
}

/** 审查员放行了一次，或人回答了一次询问：连续计数清零（累计不清） */
export function noteReviewCleared(sessionId: string): void {
  const state = states.get(sessionId)
  if (state) state.consecutive = 0
}

// ─── 人在审批卡片上写的反馈 ───────────────────────────

/** 每会话保留的反馈条数（旧的先丢） */
const FEEDBACK_LIMIT = 20

/** 一条卡片反馈：人对哪张卡（卡片主文本）写了什么 */
export interface HumanFeedbackNote {
  ts: number
  /** 那张卡的主文本（命令原文 / 路径条目 / SQL / URL / 工具名） */
  target: string
  text: string
}

const feedback = new Map<string, HumanFeedbackNote[]>()

/** 人在一张审批卡片上选了「其它」并写了反馈（执行层调用） */
export function noteHumanFeedback(sessionId: string, target: string, text: string): void {
  const notes = feedback.get(sessionId) ?? []
  notes.push({ ts: Date.now(), target, text })
  if (notes.length > FEEDBACK_LIMIT) notes.splice(0, notes.length - FEEDBACK_LIMIT)
  feedback.set(sessionId, notes)
}

/** 这个会话里人写过的卡片反馈（旧 → 新，副本） */
export function humanFeedbackOf(sessionId: string): HumanFeedbackNote[] {
  return [...(feedback.get(sessionId) ?? [])]
}

// ─── 进行中的审查 ─────────────────────────────────────

const inflight = new Map<string, Set<AbortController>>()
/** 被停止、还没开始下一轮的会话：不再开始新的审查 */
const closed = new Set<string>()

/**
 * 登记一次进行中的审查，返回注销函数；会话已被停止（下一次 prompt 之前）时返回 null ——
 * 调用方按「已中止」处理，与这时弹询问卡片会被直接取消是一回事。
 */
export function trackReview(sessionId: string, controller: AbortController): (() => void) | null {
  if (closed.has(sessionId)) return null
  let set = inflight.get(sessionId)
  if (!set) {
    set = new Set()
    inflight.set(sessionId, set)
  }
  set.add(controller)
  const own = set
  return () => {
    own.delete(controller)
    if (own.size === 0 && inflight.get(sessionId) === own) inflight.delete(sessionId)
  }
}

/** 会话被停止：中止它名下进行中的审查，下一次 prompt 之前不再开始新的 */
export function abortSessionReviews(sessionId: string): void {
  closed.add(sessionId)
  for (const controller of inflight.get(sessionId) ?? []) controller.abort()
}

/** 会话开始新的一轮：恢复受理审查 */
export function reopenSessionReviews(sessionId: string): void {
  closed.delete(sessionId)
}

/** 会话销毁时清理（与 clearSessionDecisions 同一处调用）：计数、反馈、进行中的审查一并清掉 */
export function clearReviewState(sessionId: string): void {
  states.delete(sessionId)
  feedback.delete(sessionId)
  closed.delete(sessionId)
  for (const controller of inflight.get(sessionId) ?? []) controller.abort()
  inflight.delete(sessionId)
}
