/**
 * 收件箱的已读 / 未读（docs/inbox-read-state-design.md）—— 主进程是唯一的真源。
 *
 * - **变未读**：一条会话的根 agent 跑完一轮（`agent_end` reason ok / error），而那一刻没人看着它
 *   （判定在 chat-protocol `turnMakesUnread`）。自己按停的、派生 agent / hook agent 的、别的会话驱动的、
 *   不进主窗口列表的会话（内存会话、Chrome 标签会话）都不算。新内容从那一轮开跑的时刻算起（`anchorAt`）。
 * - **读过**：它来到用户眼前（`notificationService.onSessionInFront`：窗口展示着它且有焦点，或手机 / 浏览器
 *   展示着它且报了可见），或者用户手动标为已读。
 * - 状态一变就广播 `session.unreadChanged`（载荷就是新状态）；前端靠 `session:unread` 补种。
 *
 * 询问（审批 / 选择题）不走这里：答了才消失，与读没读无关。
 */

import { isChromeTabSessionSettings } from '@shuvix/chat-protocol/chromeTabSession'
import { turnMakesUnread, type SessionUnread } from '@shuvix/chat-protocol/sessionUnread'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { isDrivingOrigin, type InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import type { SessionUnreadDao } from '../dao/sessionUnreadDao'
import { createLogger } from '../logger'
import { appEventBus } from '../utils/appEventBus'
import { isSessionInFront, onSessionInFront } from './sessionPresence'
import { sessionRecords } from './sessionRecords'

const log = createLogger('Unread')

/**
 * 表的读写（宿主启动时注入 sessionUnreadDao）。不在模块顶上 import：DAO 一 import 就开数据库单例，而事件汇、
 * 会话服务、IPC 都 import 这里 —— 它们的测试不该因此去碰数据库。没注入 = 没有已读功能（什么也不记）
 */
type UnreadTable = Pick<
  SessionUnreadDao,
  'findAll' | 'findBySessionId' | 'markTurn' | 'markManual' | 'deleteBySessionId' | 'deleteAll'
>
let table: UnreadTable | null = null
export function setUnreadTable(dao: UnreadTable | null): void {
  table = dao
}

/** 会话 id → 这一轮开跑的时刻（agent_start 记，agent_end 取走） */
const runStartedAt = new Map<string, number>()

/** 最近开跑的那一轮是谁发起的（宿主注入：读活着的会话运行时；不注入 = 当作不是别的会话驱动的） */
let runOriginReader: ((sessionId: string) => InputOrigin | undefined) | null = null
export function setRunOriginReader(
  reader: ((sessionId: string) => InputOrigin | undefined) | null
): void {
  runOriginReader = reader
}

function publish(sessionId: string, unread: SessionUnread | null): void {
  appEventBus.publish({ type: 'session.unreadChanged', sessionId, unread })
}

/** 是一条会话（不是派生 agent 的 id）：派生 agent 与根 agent 的事件同构，只能看这个 id 有没有会话行 */
function isSessionRow(sessionId: string): boolean {
  return sessionRecords.findById(sessionId) !== undefined
}

/** 不进主窗口列表的会话：内存会话（从系统打开的 md 窗口）与 Chrome 标签会话 —— 与桌面通知同一条排除 */
function excluded(sessionId: string): boolean {
  if (sessionRecords.isEphemeral(sessionId) || sessionRecords.wasEphemeral(sessionId)) return true
  try {
    return isChromeTabSessionSettings(sessionRecords.pickSettings(sessionId, ['chromeTab']))
  } catch {
    return false
  }
}

let started = false

export const unreadService = {
  /** 接上「来到眼前即读过」（启动时一次） */
  init(): void {
    if (started) return
    started = true
    onSessionInFront((sessionId) => unreadService.seen(sessionId))
  },

  /** 事件流（electronEventSink）：只看根 agent 的开跑与收尾 */
  observe(event: ChatEvent): void {
    if (event.type === 'agent_start') {
      if (isSessionRow(event.sessionId)) runStartedAt.set(event.sessionId, Date.now())
      return
    }
    if (event.type !== 'agent_end') return
    const sessionId = event.sessionId
    const startedAt = runStartedAt.get(sessionId)
    runStartedAt.delete(sessionId)
    const root = isSessionRow(sessionId)
    const origin = root ? runOriginReader?.(sessionId) : undefined
    const unread = turnMakesUnread({
      reason: event.reason,
      isSessionRoot: root,
      excluded: root && excluded(sessionId),
      driven: origin !== undefined && isDrivingOrigin(origin),
      inFront: root && isSessionInFront(sessionId)
    })
    if (!unread || !table) return
    table.markTurn(sessionId, Date.now(), startedAt ?? null, event.reason === 'error')
    publish(sessionId, table.findBySessionId(sessionId))
  },

  /** 来到用户眼前：读过了 */
  seen(sessionId: string): void {
    if (table && table.deleteBySessionId(sessionId) > 0) publish(sessionId, null)
  },

  /** 手动标为已读（收件箱的 ✓、会话行菜单） */
  markRead(sessionId: string): void {
    unreadService.seen(sessionId)
  },

  /** 收件箱「全部标为已读」 */
  markAllRead(): void {
    for (const sessionId of table?.deleteAll() ?? []) publish(sessionId, null)
  },

  /** 手动标为未读（会话行菜单）：没有新内容可指，不画分隔线 */
  markUnread(sessionId: string): void {
    if (!table || !isSessionRow(sessionId) || excluded(sessionId)) return
    if (table.findBySessionId(sessionId)) return
    table.markManual(sessionId, Date.now())
    publish(sessionId, table.findBySessionId(sessionId))
  },

  /** 全部未读（前端补种） */
  list(): Record<string, SessionUnread> {
    return table?.findAll() ?? {}
  },

  /** 会话删除：行一起删（会话没了，不广播 —— 列表变化本身会让前端重取） */
  forgetSession(sessionId: string): void {
    runStartedAt.delete(sessionId)
    try {
      table?.deleteBySessionId(sessionId)
    } catch (err) {
      log.warn(`删除会话的未读失败 session=${sessionId}: ${err}`)
    }
  }
}
