/**
 * 会话按日开口索引 —— 日历读侧 + user_message 入账。
 *
 * 写入不走 chatGateway.prompt：ensure 失败不会落树却会误记一天；steer / followUp /
 * nextTurn 会往树里追加用户消息，只认 prompt 会漏。正确时机是用户消息真正落树并广播
 * `user_message` 之后（electronEventSink 旁听）。
 */
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { isHiddenProjectId } from '@shuvix/chat-protocol/hiddenProjects'
import { isChromeTabSessionSettings } from '@shuvix/chat-protocol/chromeTabSession'
import type { Session } from '../dao/types'
import { sessionDao } from '../dao/sessionDao'
import { localDayKey, sessionDayPromptDao } from '../dao/sessionDayPromptDao'
import { createLogger } from '../logger'

const log = createLogger('SessionDayPrompt')

export { localDayKey }

function isUserOpening(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  const meta = message.metadata
  if (meta?.isSystemNotice || meta?.isInstructionInjection) return false
  return true
}

/**
 * 一条真正落树的用户开口入账。同一 entry 重播忽略；只有新行才 bump lastActiveAt。
 */
export function recordUserPrompt(sessionId: string, message: ChatMessage): void {
  if (!isUserOpening(message)) return
  // Chrome 标签页会话不进日历：它是某个标签页的临时对话，标签页一关就删
  if (isChromeTabSessionSettings(sessionDao.pickSettings(sessionId, ['chromeTab']))) return
  const timestamp = message.createdAt || Date.now()
  const inserted = sessionDayPromptDao.insert({
    sessionId,
    entryId: message.id,
    day: localDayKey(timestamp),
    timestamp
  })
  if (inserted) sessionDao.touchActive(sessionId)
}

/** electronEventSink 旁路：只认 `user_message`，解析失败静默丢掉（不能挡广播） */
export function recordFromUserMessageEvent(event: ChatEvent): void {
  if (event.type !== 'user_message') return
  let message: ChatMessage
  try {
    message = JSON.parse(event.message) as ChatMessage
  } catch {
    log.warn(`user_message 载荷不是 JSON，跳过日历入账 session=${event.sessionId}`)
    return
  }
  try {
    recordUserPrompt(event.sessionId, message)
  } catch (err) {
    log.warn(
      `日历入账失败 session=${event.sessionId}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** 可见月里有过开口的本地日（YYYY-MM-DD[]）。隐藏项目不占圆点。`month` 为 1–12。 */
export function daysInMonth(year: number, month: number): string[] {
  const days = new Set<string>()
  for (const row of sessionDayPromptDao.daysInMonth(year, month)) {
    if (!isHiddenProjectId(row.projectId)) days.add(row.day)
  }
  return [...days]
}

/** 当天出现过的会话，隐藏项目（知识库 / 注册表 / 技能载体）排除 */
export function sessionsOnDay(day: string): Session[] {
  return sessionDayPromptDao.sessionsOnDay(day).filter((s) => !isHiddenProjectId(s.projectId))
}

/** 当天 timestamp 最小的用户消息 entryId；没有则 null */
export function firstEntryOnDay(sessionId: string, day: string): string | null {
  return sessionDayPromptDao.firstEntryOnDay(sessionId, day) ?? null
}
