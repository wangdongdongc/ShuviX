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
 * 同一处还记着审查的另外几份会话内状态：
 *  - **人在审批卡片上写的反馈**：执行层在收到人的回答时记下。审查员的输入只收人写的东西，而卡片
 *    反馈落进会话树时只是一段工具结果文字 —— 任何命令都能打印出同样的开头，按文字认就是给注入
 *    开门。所以只认这里：只有安全模块自己收到的回答才会进来。
 *  - **审查放行过的调用**：宿主在工具执行完之后取走，写进工具结果（工具卡上的「已审查」标记）；按
 *    durable taskId 记（有的话，P2-08 PIN-10），否则按 toolCallId；
 *  - **进行中的审查**：会话被停止时一并中止，并在下一次 prompt 之前不再开始新的 —— 与询问卡片同一
 *    待遇（HarnessSession 的 inputsClosed）。否则一次放行会在用户点了停止之后才落地。
 */

import { PERMISSION_RISKS, type PermissionRisk } from '@shuvix/chat-protocol/types/permissionReview'

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

// ─── 审查放行过的调用 ───────────────────────────────────

/** 每会话最多记多少条还没被取走的放行（工具抛错时不会被取走 —— 旧的先丢） */
const ALLOWED_LIMIT = 50

/** 审查员放行一次调用时留下的标记：风险与写给人看的那句话（工具卡上的「已审查」） */
export interface ReviewAllowedNote {
  risk: PermissionRisk
  summary: string
}

const allowed = new Map<string, Map<string, ReviewAllowedNote>>()

/** 一次调用的身份：provider 的 toolCallId，以及（durable 工具调用里）它的 taskId */
export interface ReviewCall {
  toolCallId: string
  taskId?: number
}

/**
 * 放行标记的键（P2-08 PIN-10）：有 durable taskId 就按它（`task:<id>`）—— provider 的 toolCallId 会话内
 * 可能重复（根与派生 agent 同时各有一个 `call_0`，先跑完的那个会拿走另一个的标记）；没有才按 toolCallId。
 * 空 toolCallId 且没有 taskId → ''（不记）。
 */
export function reviewCallKey(call: ReviewCall): string {
  return call.taskId === undefined ? call.toolCallId : `task:${call.taskId}`
}

function keyOf(call: string | ReviewCall): string {
  return typeof call === 'string' ? call : reviewCallKey(call)
}

/**
 * 审查员放行了这次调用（执行层调用）。同一次调用里审查不止一次（先读后写）时留风险最高的那次。
 * `call` 给字符串 = 旧口径（按 toolCallId）。
 */
export function noteReviewAllowed(
  sessionId: string,
  call: string | ReviewCall,
  note: ReviewAllowedNote
): void {
  const key = keyOf(call)
  if (!key) return
  const notes = allowed.get(sessionId) ?? new Map<string, ReviewAllowedNote>()
  const prev = notes.get(key)
  if (!prev || PERMISSION_RISKS.indexOf(note.risk) > PERMISSION_RISKS.indexOf(prev.risk)) {
    notes.delete(key)
    notes.set(key, note)
  }
  while (notes.size > ALLOWED_LIMIT) notes.delete(notes.keys().next().value as string)
  allowed.set(sessionId, notes)
}

/** 取走这次调用的放行标记（宿主在工具执行完之后调用，写进工具结果）；没有返回 undefined */
export function takeReviewAllowed(
  sessionId: string,
  call: string | ReviewCall
): ReviewAllowedNote | undefined {
  const key = keyOf(call)
  const notes = allowed.get(sessionId)
  const note = notes?.get(key)
  if (note) notes!.delete(key)
  return note
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

/** 会话销毁时清理（与 clearSessionDecisions 同一处调用）：计数、反馈、放行标记、进行中的审查一并清掉 */
export function clearReviewState(sessionId: string): void {
  states.delete(sessionId)
  feedback.delete(sessionId)
  allowed.delete(sessionId)
  closed.delete(sessionId)
  for (const controller of inflight.get(sessionId) ?? []) controller.abort()
  inflight.delete(sessionId)
}
