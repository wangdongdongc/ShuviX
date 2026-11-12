/**
 * 收件箱的条目（第一版，2026-11-09）：**此刻在运行的会话**的汇总，不存任何东西。
 *
 * 「在运行」与侧栏同一口径、同一套记号（`SessionRunKind`，2026-11-11 S1）：`agent` = 自己这一轮在跑
 * （`selectStreamingSessions`）或有派发的 agent / 驱动的子会话轮次；`resident` = agent 停了，只剩后台命令开着
 * （`selectBgRunKinds`；hook 起的 agent 不算）。挂着询问的会话也收进来 —— 询问总是某一轮里的工具在等。
 *
 * 三节：挂着询问的进「等你回答」，有没看的新回复的进「新回复」，其余在运行的进「运行中」（agent 在干活的在前，
 * 只剩后台命令的在后）；页面上再按根会话归成一家一家（`inboxFamiliesOf`）。只剩后台命令开着、又有没看的新回复的
 * 会话归「新回复」：agent 已经停了，要你看的是它的回复。
 */

import type { Session, SessionRunKind } from '@shuvix/chat-ui'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import type { SessionUnread } from '@shuvix/chat-protocol/sessionUnread'

export interface InboxItem {
  session: Session
  /** 挂着几条询问（选择题与批准卡都算） */
  asks: number
  /** 在跑的是哪一种（与侧栏同一套）；挂着询问、此刻又两样都不是 → null */
  run: SessionRunKind | null
  /** 开着的后台命令（启动先后），只剩后台命令开着时那一行的预览 */
  commands: string[]
}

/** 一条有新回复、你还没看的会话（停着的：在跑 / 在等你回答的归那两节） */
export interface UnreadInboxItem {
  session: Session
  unread: SessionUnread
  /**
   * 已经读了、只是还留着：你正开着这条会话，它是作为新回复被打开的（`InboxInput.held`）。
   * 位置照旧，行画成读过的样子，切到别的会话后才离开列表
   */
  held?: boolean
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
  /** 会话 id → 它的后台任务让它处于哪种在跑（`selectBgRunKinds`，侧栏用的同一份） */
  backgroundRunKinds: Record<string, SessionRunKind>
  /** 会话 id → 开着的后台命令（启动先后）；没有的会话可以不是键 */
  backgroundCommands?: Record<string, string[]>
  /** 会话 id → 未读（主进程的已读状态镜像）；缺省 = 没有已读功能 */
  unread?: Record<string, SessionUnread>
  /**
   * 正开着的那条会话，打开它时它是一条新回复（那一刻的未读）：打开即读过，但收件箱就在会话旁边，
   * 行在你眼前消失太突兀 —— 它留在「新回复」原来的位置（`held`），切走才离开（2026-11-12 用户选定 E1）
   */
  held?: { sessionId: string; unread: SessionUnread }
}

/** 最近动过的在前；同一时刻按建立时间，再按 id，保证顺序稳定（条目不该在两次渲染之间换位） */
function byRecent(a: InboxItem, b: InboxItem): number {
  return (
    b.session.lastActiveAt - a.session.lastActiveAt ||
    b.session.createdAt - a.session.createdAt ||
    (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0)
  )
}

/** 运行中：agent 在干活的在前，只剩后台命令的在后，各自最近动过的在前 */
function byRunThenRecent(a: InboxItem, b: InboxItem): number {
  const rank = (item: InboxItem): number => (item.run === 'agent' ? 0 : 1)
  return rank(a) - rank(b) || byRecent(a, b)
}

export function inboxSectionsOf(input: InboxInput): InboxSections {
  const waiting: InboxItem[] = []
  const unread: UnreadInboxItem[] = []
  const running: InboxItem[] = []
  for (const session of input.sessions) {
    const asks = Math.max(input.askCounts[session.id] ?? 0, 0)
    const run: SessionRunKind | null = input.streaming[session.id]
      ? 'agent'
      : (input.backgroundRunKinds[session.id] ?? null)
    const live = input.unread?.[session.id]
    const held = !live && input.held?.sessionId === session.id ? input.held.unread : undefined
    const u = live ?? held
    // 优先级：等你回答 > agent 在干活 > 新回复 > 只剩后台命令
    if (asks <= 0 && run !== 'agent' && u) {
      unread.push(held ? { session, unread: u, held: true } : { session, unread: u })
      continue
    }
    if (asks <= 0 && run === null) continue
    const item: InboxItem = {
      session,
      asks,
      run,
      commands: input.backgroundCommands?.[session.id] ?? []
    }
    if (item.asks > 0) waiting.push(item)
    else running.push(item)
  }
  waiting.sort(byRecent)
  running.sort(byRunThenRecent)
  unread.sort((a, b) => b.unread.since - a.unread.since || (a.session.id < b.session.id ? -1 : 1))
  return { waiting, unread, running }
}

// ─── 父子会话（P3，2026-11-10）：一家只出现一次 ──────────────────────────────────────

/**
 * 一家：一条根会话，加上它此刻出现在收件箱里的子会话。没有子会话在收件箱里的根会话也是一家（只有它自己）。
 * 根会话即使停着、没有未读也要有一行 —— 它是这一家的抬头
 */
export interface InboxFamily {
  root: Session
  /** 根会话自己在等你回答 / 在运行；都不是（根停着）为 null */
  rootItem: InboxItem | null
  /** 根会话停着、有没看的新回复 */
  rootUnread: UnreadInboxItem | null
  /** 子会话：挂着询问的 */
  waiting: InboxItem[]
  /** 子会话：停着、有没看的新回复的 */
  unread: UnreadInboxItem[]
  /** 子会话：在运行的 */
  running: InboxItem[]
}

export interface InboxFamilies {
  waiting: InboxFamily[]
  unread: InboxFamily[]
  running: InboxFamily[]
}

/** 这一家有几条子会话在收件箱里 */
export const familyChildCount = (family: InboxFamily): number =>
  family.waiting.length + family.unread.length + family.running.length

/**
 * 把三类会话按根会话归成一家一家。一家只出现一次，归在家里最急的那一类：等你回答 > 新回复 > 运行中（收件箱页按这个
 * 次序把三类接成一张列表 —— 只在跑、不用你管的排最后）；同一类里的先后取这一家在那一类最靠前的那条会话的位置。
 * 父会话不在 `sessions` 里（已删）的子会话自成一家
 */
export function inboxFamiliesOf(sections: InboxSections, sessions: Session[]): InboxFamilies {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const rootOf = (session: Session): Session => {
    let at = session
    const seen = new Set([session.id])
    while (at.parentId) {
      const parent = byId.get(at.parentId)
      if (!parent || seen.has(parent.id)) break
      seen.add(parent.id)
      at = parent
    }
    return at
  }

  const families = new Map<string, InboxFamily>()
  const result: InboxFamilies = { waiting: [], unread: [], running: [] }
  const familyOf = (session: Session, section: keyof InboxFamilies): InboxFamily => {
    const root = rootOf(session)
    let family = families.get(root.id)
    if (!family) {
      family = { root, rootItem: null, rootUnread: null, waiting: [], unread: [], running: [] }
      families.set(root.id, family)
      result[section].push(family)
    }
    return family
  }

  // 先走最急的一节：一家在哪一节，由它第一次被碰到的那一节决定
  for (const item of sections.waiting) {
    const family = familyOf(item.session, 'waiting')
    if (item.session.id === family.root.id) family.rootItem = item
    else family.waiting.push(item)
  }
  for (const item of sections.unread) {
    const family = familyOf(item.session, 'unread')
    if (item.session.id === family.root.id) family.rootUnread = item
    else family.unread.push(item)
  }
  for (const item of sections.running) {
    const family = familyOf(item.session, 'running')
    if (item.session.id === family.root.id) family.rootItem = item
    else family.running.push(item)
  }
  return result
}

// ─── 等你回答的一条条询问：行内展开成卡片（L1，2026-11-10） ──────────────────────────────

/** 一条待回答的询问：哪条会话、哪一条请求 */
export interface InboxAsk {
  session: Session
  request: InputRequest
}

/** 一条询问的身份（会话 + 请求 id）：请求 id 只在会话内唯一 */
export const askKeyOf = (ask: { session: { id: string }; request: { id: string } }): string =>
  `${ask.session.id}\n${ask.request.id}`

/**
 * 「等你回答」那一节里的询问，按页面上从上到下的次序（J / K 走的就是它）：一家一家来，家里先根会话、后子会话，
 * 一条会话内按询问出现的先后。`pending` 里没有的会话（询问表还没取到，或者主进程那边已经答掉）没有条目；
 * `hidden` 是这里刚答过、主进程的新一份还没到的询问，先藏起来
 */
export function askItemsOf(
  families: InboxFamily[],
  pending: Record<string, InputRequest[]> | null,
  hidden: ReadonlySet<string> = new Set()
): InboxAsk[] {
  const items: InboxAsk[] = []
  for (const family of families) {
    const members = [
      ...(family.rootItem && family.rootItem.asks > 0 ? [family.rootItem] : []),
      ...family.waiting
    ]
    for (const { session } of members) {
      for (const request of pending?.[session.id] ?? []) {
        const ask = { session, request }
        if (!hidden.has(askKeyOf(ask))) items.push(ask)
      }
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

/** 收起时那一行的一句话：选择题是问题本身；审批是工具写的说明，没有就是命令 / 路径 */
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
