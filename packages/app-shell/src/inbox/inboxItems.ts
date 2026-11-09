/**
 * 收件箱的条目（第一版，2026-11-09）：**此刻在运行的会话**的汇总，不存任何东西。
 *
 * 「在运行」与侧栏转圈同一口径：自己这一轮在跑（`selectStreamingSessions`），或者有没结束的后台任务
 * （`countsAsSessionBusy`：后台命令、派发的 agent、驱动的子会话轮次；hook 起的 agent 不算）。挂着询问的
 * 会话也收进来 —— 询问总是某一轮里的工具在等，它就是一条在跑的会话。
 *
 * 分两节：挂着询问的进「等你回答」，其余进「运行中」。没有已读 / 未读，也没有「已处理」：会话一停下来，
 * 条目就自己消失（用户裁决：先只做运行中会话的聚合，不加新的已读机制）。
 */

import type { Session } from '@shuvix/chat-ui'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { SessionUnread } from '@shuvix/chat-protocol/sessionUnread'

export interface InboxItem {
  session: Session
  /** 挂着几条询问（选择题与批准卡都算） */
  asks: number
  /** 自己这一轮在跑 */
  replying: boolean
  /** 没结束、算数的后台任务条数 */
  backgroundTasks: number
}

/** 一条有新回复、你还没看的会话（停着的：在跑 / 在等你回答的归那两节） */
export interface UnreadInboxItem {
  session: Session
  unread: SessionUnread
}

export interface InboxSections {
  /** 挂着询问的会话 */
  waiting: InboxItem[]
  /** 停着、有你还没看的新回复的会话（docs/inbox-read-state-design.md），最新的在前 */
  unread: UnreadInboxItem[]
  /** 其余在运行的会话 */
  running: InboxItem[]
}

export interface InboxInput {
  /** 会话列表（store 里的那份；不在列表里的会话 —— Chrome 标签会话之类 —— 不收） */
  sessions: Session[]
  /** 会话 id → 自己这一轮在跑 */
  streaming: Record<string, boolean>
  /** 会话 id → 挂着的询问数 */
  askCounts: Record<string, number>
  /** 会话 id → 没结束、算数的后台任务数 */
  backgroundTaskCounts: Record<string, number>
  /** 会话 id → 未读（主进程的已读状态镜像）；缺省 = 没有已读功能 */
  unread?: Record<string, SessionUnread>
}

/** 最近动过的在前；同一时刻按建立时间，再按 id，保证顺序稳定（条目不该在两次渲染之间换位） */
function byRecent(a: InboxItem, b: InboxItem): number {
  return (
    b.session.lastActiveAt - a.session.lastActiveAt ||
    b.session.createdAt - a.session.createdAt ||
    (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0)
  )
}

export function inboxSectionsOf(input: InboxInput): InboxSections {
  const waiting: InboxItem[] = []
  const unread: UnreadInboxItem[] = []
  const running: InboxItem[] = []
  for (const session of input.sessions) {
    const asks = input.askCounts[session.id] ?? 0
    const replying = !!input.streaming[session.id]
    const backgroundTasks = input.backgroundTaskCounts[session.id] ?? 0
    if (asks <= 0 && !replying && backgroundTasks <= 0) {
      // 停着的会话：有没看的新回复才进收件箱（优先级：等你回答 > 运行中 > 新回复）
      const u = input.unread?.[session.id]
      if (u) unread.push({ session, unread: u })
      continue
    }
    const item: InboxItem = { session, asks: Math.max(asks, 0), replying, backgroundTasks }
    if (item.asks > 0) waiting.push(item)
    else running.push(item)
  }
  waiting.sort(byRecent)
  running.sort(byRecent)
  unread.sort((a, b) => b.unread.since - a.unread.since || (a.session.id < b.session.id ? -1 : 1))
  return { waiting, unread, running }
}

// ─── 逐张处理（B3，2026-11-09）：把「等你回答」那几条会话里挂着的询问摊成一张一张 ──────────

/** 一张待处理的卡：哪条会话、哪一条询问 */
export interface TriageItem {
  session: Session
  request: InputRequest
}

/** 一张卡的身份（会话 + 请求 id）：请求 id 只在会话内唯一 */
export const triageKeyOf = (item: { session: { id: string }; request: { id: string } }): string =>
  `${item.session.id}\n${item.request.id}`

/**
 * 逐张处理的顺序：按「等你回答」那一节的会话顺序，会话内按询问出现的先后。`pending` 里没有的会话（询问表还没
 * 取到，或者主进程那边已经答掉）就没有卡；`hidden` 是这里刚答过、主进程的新一份还没到的卡，先藏起来
 */
export function triageItemsOf(
  waiting: InboxItem[],
  pending: Record<string, InputRequest[]>,
  hidden: ReadonlySet<string> = new Set()
): TriageItem[] {
  const items: TriageItem[] = []
  for (const { session } of waiting) {
    for (const request of pending[session.id] ?? []) {
      const item = { session, request }
      if (!hidden.has(triageKeyOf(item))) items.push(item)
    }
  }
  return items
}

/**
 * 卡片上那一句「AI 刚才说了什么」：发起这条询问的那张助手卡片的正文；它只有工具调用、没有字时，往前找最近一张
 * 有字的助手卡片，碰到用户消息就停（那之前说的是上一轮的事）。找不到（派生 agent 的询问不在根会话的消息里）→ null
 */
export function askContextOf(messages: ChatMessage[], toolCallId: string): string | null {
  const at = messages.findIndex(
    (m) =>
      m.role === 'assistant' &&
      m.blocks.some((b) => b.type === 'tool' && b.toolCallId === toolCallId)
  )
  if (at < 0) return null
  for (let i = at; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') return null
    if (m.role === 'assistant' && m.content.trim()) return m.content.trim()
  }
  return null
}

/** 「接下来」那一行的一句话：选择题是问题本身；审批是工具写的说明，没有就是命令 / 路径 */
export function requestSummaryOf(request: InputRequest): string {
  if (request.kind === 'choice') return request.question
  return request.description?.trim() || request.command
}

/** 等了几分钟（向下取整，不小于 0） */
export function waitedMinutes(createdAt: number, now: number): number {
  return Math.max(0, Math.floor((now - createdAt) / 60_000))
}

/** 一条会话最后那张有字的助手卡片的正文（收件箱「新回复」那一行的摘录）；没有 → null */
export function lastReplyText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.content.trim()) return m.content.trim()
  }
  return null
}

/** 「新回复」那一行的时间：今天的写时分（21:05），更早的写月-日（11-08） */
export function unreadTimeLabel(at: number, now: number): string {
  const d = new Date(at)
  const today = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
