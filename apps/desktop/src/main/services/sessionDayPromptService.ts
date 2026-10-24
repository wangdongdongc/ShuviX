/**
 * 会话按日开口索引 —— 日历读侧 + 用户条目入账。
 *
 * 写入按 durable 的 `pi.user` 条目（P3-07）：AgentSession 的 prompt / steer / followUp 在条目落下那一刻
 * （当场落下 = `onAdmitted{entryId}`；排进队列 = 之后的 `onPlaced`）调 `recordUserEntry`。行的 `entryId`
 * 就是界面消息 id（`String(entryId)`）—— 日历跳转（`firstEntryOnDay` → `requestScrollToMessage`）靠它
 * 对上。被拒、被撤回、重新挂上的发送都不入账；日期通知等不是用户条目，从不入账。
 * 旧的 `user_message` 旁听（electronEventSink）随 P3-07 删掉（PIN-17）。
 *
 * 会话建成（sessionService 的新建与 fork 插行）另记一行 `recordSessionCreated`：建成当天就进日历，
 * 还没发过消息也一样。
 */
import { isHiddenProjectId } from '@shuvix/chat-protocol/hiddenProjects'
import { isChromeTabSessionSettings } from '@shuvix/chat-protocol/chromeTabSession'
import type { Session } from '../dao/types'
import { sessionRecords } from './sessionRecords'
import { CREATED_ENTRY_ID, localDayKey, sessionDayPromptDao } from '../dao/sessionDayPromptDao'

export { localDayKey }

/**
 * 一条用户条目落下（P3-07 PIN-15）入账 —— lastActiveAt 与日历索引；`timestamp` 缺省 = 此刻（落下那一刻，
 * 排队的发送按放下时算哪一天）。同一条目重播忽略；只有新行才 bump lastActiveAt。`origin` = 来源种类
 * （InputOrigin.kind），日历照样列出所有来源的会话，只有 `activeSessionsOnDay` 按它只数人打的。
 */
export function recordUserEntry(
  sessionId: string,
  entryId: number | string,
  timestamp: number = Date.now(),
  origin?: string
): void {
  if (!onCalendar(sessionId)) return
  const inserted = sessionDayPromptDao.insert({
    sessionId,
    entryId: String(entryId),
    day: localDayKey(timestamp),
    timestamp,
    ...(origin ? { origin } : {})
  })
  if (inserted) sessionRecords.touchActive(sessionId)
}

/**
 * 会话建成入账（新建 / fork 插行之后）—— 建成当天就进日历。entryId = CREATED_ENTRY_ID，每条会话一行；
 * 不 touchActive（建行时 lastActiveAt 已是此刻）。排除项与用户条目相同。
 */
export function recordSessionCreated(sessionId: string, timestamp: number = Date.now()): void {
  if (!onCalendar(sessionId)) return
  sessionDayPromptDao.insert({
    sessionId,
    entryId: CREATED_ENTRY_ID,
    day: localDayKey(timestamp),
    timestamp
  })
}

/** 这条会话进不进日历 */
function onCalendar(sessionId: string): boolean {
  // 内存会话（只在内存里、宿主一关就没）不记活跃：不进日历，也不动 lastActiveAt。
  // 删了的也一样 —— 迟到的落下不该给它补一行日历
  if (sessionRecords.isEphemeral(sessionId) || sessionRecords.wasEphemeral(sessionId)) return false
  // Chrome 标签页会话不进日历：它是某个标签页的临时对话，标签页一关就删
  return !isChromeTabSessionSettings(sessionRecords.pickSettings(sessionId, ['chromeTab']))
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

/**
 * 当天有人写过消息的会话数（CEL 宿主函数 `activeSessions(date)` 的实现）：建成那行不算，触发器替 bot 发的、
 * 别的会话发进来的不算，隐藏项目（知识库 / 注册表 / 日报 / 技能载体）不算 —— 与日历列出的口径一致。
 */
export function activeSessionsOnDay(day: string): number {
  return sessionDayPromptDao.humanActiveOnDay(day).filter((r) => !isHiddenProjectId(r.projectId))
    .length
}

/**
 * 本地日区间 [startDay, endDay] 里出现过的会话（session 工具按时间列出会话用）：与日历同一口径 —— 隐藏项目不算，
 * Chrome 标签页会话本来就不入账。每条带区间里用户条目的来源种类与最后时刻，按最后时刻倒序
 */
export function sessionsActiveBetween(
  startDay: string,
  endDay: string
): Array<{ session: Session; origins: string[]; lastAt: number }> {
  return sessionDayPromptDao
    .activityBetween(startDay, endDay)
    .filter((r) => !isHiddenProjectId(r.session.projectId))
}

/** 当天 timestamp 最小的用户消息 entryId（建成那行不算）；没有则 null */
export function firstEntryOnDay(sessionId: string, day: string): string | null {
  return sessionDayPromptDao.firstEntryOnDay(sessionId, day) ?? null
}
