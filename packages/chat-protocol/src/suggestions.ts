/**
 * 提议（`suggest` 工具，2026-10-25，设计稿 docs/suggest-tool-design.md）—— agent 给用户留至多三条提议，调用立刻返回、
 * 不等回答；用户点一条，那条的 `message` 就作为用户的回复发进这条会话（会话在跑就是 steer）。
 *
 * 这一版只有「回复」一种动作（宿主动作暂不做，用户裁决），也**不另存状态**：一组提议开着还是关了、采纳的是哪一条，
 * 全从会话本身读出来 ——
 *  - 内容 = 那次工具调用的参数（本来就在会话树里）；
 *  - 采纳 = 一条带 `origin.suggestion` 的用户消息（宿主在 `suggestion:accept` 里盖的章）；
 *  - 关闭 = 这组提议之后用户说了别的话（打字、steer、采纳同一组里的另一条）。和桌面端那张「下一步」卡一样：
 *    话题往下走了，旧的提议就不再能点。系统写的通知（后台完成、日期变化……）不算用户说话。
 *
 * 渲染端（chat-ui 画卡片）与主进程（`suggestion:accept` 核对这一条还能不能采纳）用同一个判断，免得两边各写一份走样。
 */
import type { AssistantMessage, ChatMessage, UserTextMessage } from './types/chatMessage'
import type { SuggestionRef } from './types/inputOrigin'

export const SUGGEST_TOOL_NAME = 'suggest'

/** 一次调用至多几条、各字段至多多长（字符数）—— 工具校验与卡片渲染共用 */
export const SUGGEST_LIMITS = {
  maxItems: 3,
  title: 80,
  detail: 300,
  message: 1000
} as const

/** 一条提议（工具参数里的一项） */
export interface Suggestion {
  /** 卡片的主文字：做什么 */
  title: string
  /** 采纳后以用户的身份发给 agent 的那句话（卡片上全文显示） */
  message: string
  /** 为什么（可选） */
  detail?: string
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 工具参数 → 提议列表（宽松：渲染与核对都只拿得出形状对的那些，坏项跳过；顺序与下标保持参数里的样子 ——
 * 下标是采纳时的身份，所以坏项留空位而不是挤掉）
 */
export function suggestionsOf(args: unknown): Array<Suggestion | undefined> {
  if (typeof args !== 'object' || args === null) return []
  const list = (args as { suggestions?: unknown }).suggestions
  if (!Array.isArray(list)) return []
  return list.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return undefined
    const o = item as Record<string, unknown>
    if (!nonEmpty(o.title) || !nonEmpty(o.message)) return undefined
    return nonEmpty(o.detail)
      ? { title: o.title, message: o.message, detail: o.detail }
      : { title: o.title, message: o.message }
  })
}

/** 一组提议（一次 `suggest` 调用）此刻的状态 */
export type SuggestionGroupState =
  /** 还能点 */
  | { status: 'open' }
  /** 用户采纳了第 `index` 条 */
  | { status: 'accepted'; index: number }
  /** 之后用户说了别的话：不能再点 */
  | { status: 'closed' }

/** 一组提议的键：所在助手消息 id + toolCallId（toolCallId 单独不够唯一，见 `SuggestionRef`） */
export function suggestionGroupKey(messageId: string, toolCallId: string): string {
  return `${messageId}\n${toolCallId}`
}

/** 一次成功落定的 `suggest` 调用（还在执行、出错的不算提议 —— 出错的照普通工具块显示） */
export function isSettledSuggestBlock(block: AssistantMessage['blocks'][number]): boolean {
  return (
    block.type === 'tool' &&
    block.toolName === SUGGEST_TOOL_NAME &&
    block.result !== undefined &&
    !block.isError
  )
}

/** 这条用户消息是采纳哪一条提议发出的（宿主盖的章；只有人的来源会带） */
export function suggestionRefOfMessage(message: UserTextMessage): SuggestionRef | undefined {
  const origin = message.metadata?.origin
  return origin !== undefined && 'suggestion' in origin ? origin.suggestion : undefined
}

/** 这条用户消息是用户自己说的话（系统写的通知、指令注入不算） */
function isUserSpeech(message: UserTextMessage): boolean {
  const meta = message.metadata
  return !meta?.isSystemNotice && !meta?.isInstructionInjection
}

/**
 * 整条会话里每组提议的状态（键见 `suggestionGroupKey`）。按顺序走一遍：遇到落定的 `suggest` 调用记为开着；
 * 遇到用户说的话，先看它是不是采纳了开着的某一组（`origin.suggestion`），然后把此前开着的全部关掉。
 */
export function suggestionStatesOf(
  messages: readonly ChatMessage[]
): Map<string, SuggestionGroupState> {
  const states = new Map<string, SuggestionGroupState>()
  let open: string[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.blocks) {
        if (block.type !== 'tool' || !isSettledSuggestBlock(block)) continue
        const key = suggestionGroupKey(message.id, block.toolCallId)
        states.set(key, { status: 'open' })
        open.push(key)
      }
      continue
    }
    if (message.role !== 'user' || !isUserSpeech(message) || open.length === 0) continue
    const ref = suggestionRefOfMessage(message)
    const accepted = ref ? suggestionGroupKey(ref.messageId, ref.toolCallId) : undefined
    for (const key of open) {
      states.set(
        key,
        key === accepted && ref ? { status: 'accepted', index: ref.index } : { status: 'closed' }
      )
    }
    open = []
  }
  return states
}

/** 采纳前的核对结果 */
export type SuggestionToAccept =
  | { ok: true; message: string }
  /** `not-found`：没有这次调用 / 这一条；`closed`：之后用户已经说了别的话（或已采纳过） */
  | { ok: false; reason: 'not-found' | 'closed' }

/** 这一条提议此刻还能不能采纳；能就交回要发出去的那句话（取自会话里的工具参数，从不取请求里带的） */
export function suggestionToAccept(
  messages: readonly ChatMessage[],
  ref: SuggestionRef
): SuggestionToAccept {
  const owner = messages.find(
    (m): m is AssistantMessage => m.role === 'assistant' && m.id === ref.messageId
  )
  const block = owner?.blocks.find(
    (b) => b.type === 'tool' && b.toolCallId === ref.toolCallId && isSettledSuggestBlock(b)
  )
  if (!owner || !block || block.type !== 'tool') return { ok: false, reason: 'not-found' }
  const suggestion = suggestionsOf(block.args)[ref.index]
  if (!suggestion) return { ok: false, reason: 'not-found' }
  const state = suggestionStatesOf(messages).get(suggestionGroupKey(ref.messageId, ref.toolCallId))
  if (state?.status !== 'open') return { ok: false, reason: 'closed' }
  return { ok: true, message: suggestion.message }
}

/** `suggestion:accept` 的参数：哪条会话里的哪一条提议 */
export interface SuggestionAcceptParams extends SuggestionRef {
  sessionId: string
}

/**
 * `suggestion:accept` 的结果。`not-found` / `closed` 同 `suggestionToAccept`；`failed` = 核对过了但没发出去
 * （会话打不开、模型被拒……），`error` 是给人读的原因
 */
export type AcceptSuggestionResult =
  | { success: true }
  | { success: false; reason: 'not-found' | 'closed' | 'failed'; error?: string }
