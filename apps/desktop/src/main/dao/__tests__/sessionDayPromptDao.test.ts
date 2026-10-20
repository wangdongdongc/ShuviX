/**
 * session_day_prompts DAO —— insert / 按日列出 / 当天第一条（建成那行不算）/ 删会话清索引。
 *
 * 不用 better-sqlite3（仓库里是给 Electron 编的，Node 单测 NODE_MODULE_VERSION 对不上）。
 * 内存表替身只实现本文件用到的那几条 SQL 形状。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Session } from '../types'

interface PromptRow {
  sessionId: string
  entryId: string
  day: string
  timestamp: number
}

const state = vi.hoisted(() => ({
  sessions: [] as Session[],
  prompts: [] as PromptRow[]
}))

vi.mock('../database', () => {
  class BaseDao {
    protected get db(): {
      prepare: (sql: string) => {
        all: (...args: unknown[]) => unknown[]
        get: (...args: unknown[]) => unknown
        run: (...args: unknown[]) => { changes: number }
      }
    } {
      return {
        prepare: (sql: string) => ({
          all: (...args: unknown[]) => execAll(sql, args),
          get: (...args: unknown[]) => execGet(sql, args),
          run: (...args: unknown[]) => execRun(sql, args)
        })
      }
    }
    protected stmt(sql: string): {
      all: (...args: unknown[]) => unknown[]
      get: (...args: unknown[]) => unknown
      run: (...args: unknown[]) => { changes: number }
    } {
      return this.db.prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => null } }
})

function execRun(sql: string, args: unknown[]): { changes: number } {
  if (sql.startsWith('INSERT OR IGNORE INTO session_day_prompts')) {
    const [sessionId, entryId, day, timestamp] = args as [string, string, string, number]
    if (state.prompts.some((r) => r.sessionId === sessionId && r.entryId === entryId)) {
      return { changes: 0 }
    }
    state.prompts.push({ sessionId, entryId, day, timestamp })
    return { changes: 1 }
  }
  if (sql.startsWith('DELETE FROM session_day_prompts')) {
    const [sessionId] = args as [string]
    const before = state.prompts.length
    state.prompts = state.prompts.filter((r) => r.sessionId !== sessionId)
    return { changes: before - state.prompts.length }
  }
  throw new Error(`unhandled run sql: ${sql}`)
}

function execGet(sql: string, args: unknown[]): { entryId: string } | undefined {
  if (sql.includes('ORDER BY timestamp ASC LIMIT 1')) {
    const [sessionId, day, excluded] = args as [string, string, string]
    const rows = state.prompts
      .filter((r) => r.sessionId === sessionId && r.day === day && r.entryId !== excluded)
      .sort((a, b) => a.timestamp - b.timestamp)
    return rows[0] ? { entryId: rows[0].entryId } : undefined
  }
  throw new Error(`unhandled get sql: ${sql}`)
}

function execAll(sql: string, args: unknown[]): unknown[] {
  if (sql.includes('SELECT DISTINCT d.day')) {
    const [start, end] = args as [string, string]
    const seen = new Set<string>()
    const out: Array<{ day: string; projectId: string | null }> = []
    for (const r of state.prompts) {
      if (r.day < start || r.day >= end) continue
      const sess = state.sessions.find((s) => s.id === r.sessionId)
      const key = `${r.day}\0${sess?.projectId ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ day: r.day, projectId: sess?.projectId ?? null })
    }
    return out.sort((a, b) => a.day.localeCompare(b.day))
  }
  if (sql.includes('SELECT s.* FROM sessions s')) {
    const [day] = args as [string]
    const ids = [...new Set(state.prompts.filter((r) => r.day === day).map((r) => r.sessionId))]
    return state.sessions
      .filter((s) => ids.includes(s.id))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map((s) => ({ ...s, settings: JSON.stringify(s.settings) }))
  }
  throw new Error(`unhandled all sql: ${sql}`)
}

import {
  CREATED_ENTRY_ID,
  sessionDayPromptDao,
  localDayKey,
  monthDayRange
} from '../sessionDayPromptDao'

function insertSession(id: string, over: Partial<Session> = {}): void {
  const now = 1_700_000_000_000
  state.sessions.push({
    id,
    title: over.title ?? id,
    projectId: over.projectId ?? null,
    parentId: over.parentId ?? null,
    settings: over.settings ?? {},
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
    lastActiveAt: over.lastActiveAt ?? now
  })
}

beforeEach(() => {
  state.sessions = []
  state.prompts = []
})

describe('localDayKey / monthDayRange', () => {
  it('按本机本地日历日，不转 UTC', () => {
    const ts = new Date(2026, 8, 18, 23, 30).getTime()
    expect(localDayKey(ts)).toBe('2026-09-18')
  })

  it('十二月的月末半开区间落到下一年 1 月', () => {
    expect(monthDayRange(2026, 12)).toEqual({ start: '2026-12-01', end: '2027-01-01' })
  })
})

describe('sessionDayPromptDao', () => {
  it('insert：同一 entry 重播忽略；新行返回 true', () => {
    insertSession('s1')
    expect(
      sessionDayPromptDao.insert({
        sessionId: 's1',
        entryId: 'e1',
        day: '2026-09-18',
        timestamp: 1
      })
    ).toBe(true)
    expect(
      sessionDayPromptDao.insert({
        sessionId: 's1',
        entryId: 'e1',
        day: '2026-09-19',
        timestamp: 2
      })
    ).toBe(false)
  })

  it('同一会话多天各一条 → daysInMonth 列出那几天；sessionsOnDay 每天都有它', () => {
    insertSession('s1')
    sessionDayPromptDao.insert({
      sessionId: 's1',
      entryId: 'e18',
      day: '2026-09-18',
      timestamp: 18
    })
    sessionDayPromptDao.insert({
      sessionId: 's1',
      entryId: 'e19',
      day: '2026-09-19',
      timestamp: 19
    })
    sessionDayPromptDao.insert({
      sessionId: 's1',
      entryId: 'e20',
      day: '2026-09-20',
      timestamp: 20
    })
    expect(sessionDayPromptDao.daysInMonth(2026, 9).map((r) => r.day)).toEqual([
      '2026-09-18',
      '2026-09-19',
      '2026-09-20'
    ])
    expect(sessionDayPromptDao.daysInMonth(2026, 8)).toEqual([])
    expect(sessionDayPromptDao.sessionsOnDay('2026-09-18').map((s) => s.id)).toEqual(['s1'])
    expect(sessionDayPromptDao.sessionsOnDay('2026-09-19').map((s) => s.id)).toEqual(['s1'])
    expect(sessionDayPromptDao.sessionsOnDay('2026-09-20').map((s) => s.id)).toEqual(['s1'])
  })

  it('firstEntryOnDay 取当天 timestamp 最小的 entryId', () => {
    insertSession('s1')
    sessionDayPromptDao.insert({
      sessionId: 's1',
      entryId: 'later',
      day: '2026-09-18',
      timestamp: 200
    })
    sessionDayPromptDao.insert({
      sessionId: 's1',
      entryId: 'first',
      day: '2026-09-18',
      timestamp: 100
    })
    expect(sessionDayPromptDao.firstEntryOnDay('s1', '2026-09-18')).toBe('first')
    expect(sessionDayPromptDao.firstEntryOnDay('s1', '2026-09-19')).toBeUndefined()
    // 同一天多条 → sessionsOnDay 按会话去重
    expect(sessionDayPromptDao.sessionsOnDay('2026-09-18').map((s) => s.id)).toEqual(['s1'])
  })

  it('建成那行：当天列出、占圆点；firstEntryOnDay 不认它，取当天第一条用户消息', () => {
    insertSession('s1')
    sessionDayPromptDao.insert({
      sessionId: 's1',
      entryId: CREATED_ENTRY_ID,
      day: '2026-09-18',
      timestamp: 100
    })
    expect(sessionDayPromptDao.sessionsOnDay('2026-09-18').map((s) => s.id)).toEqual(['s1'])
    expect(sessionDayPromptDao.daysInMonth(2026, 9).map((r) => r.day)).toEqual(['2026-09-18'])
    expect(sessionDayPromptDao.firstEntryOnDay('s1', '2026-09-18')).toBeUndefined()

    sessionDayPromptDao.insert({
      sessionId: 's1',
      entryId: '7',
      day: '2026-09-18',
      timestamp: 200
    })
    expect(sessionDayPromptDao.firstEntryOnDay('s1', '2026-09-18')).toBe('7')
  })

  it('deleteBySessionId 清该会话的索引行，不影响其它会话', () => {
    insertSession('s1')
    insertSession('s2')
    sessionDayPromptDao.insert({
      sessionId: 's1',
      entryId: 'e1',
      day: '2026-09-18',
      timestamp: 1
    })
    sessionDayPromptDao.insert({
      sessionId: 's2',
      entryId: 'e2',
      day: '2026-09-18',
      timestamp: 2
    })
    sessionDayPromptDao.deleteBySessionId('s1')
    expect(sessionDayPromptDao.sessionsOnDay('2026-09-18').map((s) => s.id)).toEqual(['s2'])
    expect(sessionDayPromptDao.firstEntryOnDay('s1', '2026-09-18')).toBeUndefined()
  })
})
