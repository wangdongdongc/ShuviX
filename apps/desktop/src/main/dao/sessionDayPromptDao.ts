import { BaseDao } from './database'
import type { Session, SessionSettings } from './types'

/** DB 原始会话行（JSON 字段在 DB 中为字符串） */
type SessionRow = Omit<Session, 'settings'> & { settings: string }

/** 安全解析 JSON，失败返回空对象 */
function safeParse<T>(json: string | undefined | null): T {
  try {
    return JSON.parse(json || '{}')
  } catch {
    return {} as T
  }
}

function parseSessionRow(row: SessionRow): Session {
  return { ...row, settings: safeParse<SessionSettings>(row.settings) }
}

/** 毫秒时间戳 → 本机本地 YYYY-MM-DD（不转 UTC） */
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 日历月的半开区间：[YYYY-MM-01, 下月 01) */
export function monthDayRange(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const endMonth = month === 12 ? 1 : month + 1
  const endYear = month === 12 ? year + 1 : year
  const end = `${endYear}-${String(endMonth).padStart(2, '0')}-01`
  return { start, end }
}

export interface SessionDayPromptRow {
  sessionId: string
  entryId: string
  day: string
  timestamp: number
}

/**
 * 会话按日开口索引 —— 日历的读源。
 *
 * 一行 = 一条真正落树的用户消息。主键 (sessionId, entryId)，冲突忽略（同一 entry 重播）。
 * FK CASCADE 在未开 `PRAGMA foreign_keys` 时不会触发，删除会话必须显式 `deleteBySessionId`。
 */
export class SessionDayPromptDao extends BaseDao {
  /**
   * 插入一行。主键冲突忽略。
   * @returns 是否真正写入（false = 已有同一 entry）
   */
  insert(row: SessionDayPromptRow): boolean {
    const result = this.stmt(
      'INSERT OR IGNORE INTO session_day_prompts (sessionId, entryId, day, timestamp) VALUES (?, ?, ?, ?)'
    ).run(row.sessionId, row.entryId, row.day, row.timestamp)
    return result.changes > 0
  }

  /** 某会话的全部索引行（删会话时清） */
  deleteBySessionId(sessionId: string): void {
    this.stmt('DELETE FROM session_day_prompts WHERE sessionId = ?').run(sessionId)
  }

  /**
   * 某公历月里有过开口的 (day, projectId)。隐藏项目过滤在 service 层做。
   * `month` 为 1–12。只查当月，不拉全部历史。
   */
  daysInMonth(year: number, month: number): Array<{ day: string; projectId: string | null }> {
    const { start, end } = monthDayRange(year, month)
    return this.db
      .prepare(
        `SELECT DISTINCT d.day AS day, s.projectId AS projectId
         FROM session_day_prompts d
         INNER JOIN sessions s ON s.id = d.sessionId
         WHERE d.day >= ? AND d.day < ?
         ORDER BY d.day`
      )
      .all(start, end) as Array<{ day: string; projectId: string | null }>
  }

  /**
   * 当天出现过的会话（去重），按 lastActiveAt 倒序。
   * 隐藏项目过滤在 service 层做（id 形态含前缀，不适合纯等值 SQL）。
   */
  sessionsOnDay(day: string): Session[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s
         INNER JOIN (
           SELECT DISTINCT sessionId FROM session_day_prompts WHERE day = ?
         ) d ON s.id = d.sessionId
         ORDER BY s.lastActiveAt DESC`
      )
      .all(day) as SessionRow[]
    return rows.map(parseSessionRow)
  }

  /** 当天 timestamp 最小的用户消息 entryId；没有则 undefined */
  firstEntryOnDay(sessionId: string, day: string): string | undefined {
    const row = this.stmt(
      'SELECT entryId FROM session_day_prompts WHERE sessionId = ? AND day = ? ORDER BY timestamp ASC LIMIT 1'
    ).get(sessionId, day) as { entryId: string } | undefined
    return row?.entryId
  }
}

export const sessionDayPromptDao = new SessionDayPromptDao()
