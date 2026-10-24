/**
 * session_day_prompts DAO —— insert / 按日列出 / 当天第一条（建成那行不算）/ 删会话清索引。
 *
 * 不用 better-sqlite3（仓库里是给 Electron 编的，Node 单测 NODE_MODULE_VERSION 对不上）。
 * 内存表替身只实现本文件用到的那几条 SQL 形状。
 *
 * 来源列（v34，SDP-O*）的查询带 CASE / GROUP_CONCAT，替身不重写一遍 SQL：这一组接上 node:sqlite 的真内存库
 * （跑全部迁移；外键约束关掉，同生产的 better-sqlite3 缺省 —— 会话行没了、索引行还在的情形才造得出来）。
 *
 *   SDP-O1 insert 带 origin 就存下；不带 → NULL
 *   SDP-O2 humanActiveOnDay：当天人打的（local / remote / chrome / telegram）或不知道来源（NULL）的会话，去重；
 *          trigger / session / parent-session、建成那行、别的日子都不算；（pin）不认识的新种类（webhook）不算
 *   SDP-O3 activityBetween：含两端的日区间，每会话一行；origins 去重排序、NULL → unknown、建成那行不进 origins；
 *          lastAt 取区间里最后一条用户条目（只有建成那行时用它）；按 lastAt 倒序；会话行没了的不出现
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Session } from '../types'

interface PromptRow {
  sessionId: string
  entryId: string
  day: string
  timestamp: number
}

const state = vi.hoisted(() => ({
  sessions: [] as Session[],
  prompts: [] as PromptRow[],
  /** SDP-O* 接上的真库；为 null 时走内存表替身 */
  realDb: null as unknown
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
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
      if (state.realDb) return state.realDb as never
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
import { migrations } from '../migrations'

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

describe('SDP-O 来源列（v34，真内存库）', () => {
  let db: DatabaseSync

  beforeEach(() => {
    db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false })
    for (const m of migrations) m.up(db as never)
    state.realDb = db
  })

  afterEach(() => {
    state.realDb = null
    db.close()
  })

  function addSession(id: string, projectId: string | null = null, lastActiveAt = 1): void {
    db.prepare(
      'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, `title ${id}`, projectId, null, '{}', 1, 1, lastActiveAt)
  }

  function add(
    sessionId: string,
    entryId: string,
    day: string,
    timestamp: number,
    origin?: string
  ): void {
    expect(
      sessionDayPromptDao.insert({
        sessionId,
        entryId,
        day,
        timestamp,
        ...(origin ? { origin } : {})
      })
    ).toBe(true)
  }

  const originOf = (sessionId: string, entryId: string): unknown =>
    (
      db
        .prepare('SELECT origin FROM session_day_prompts WHERE sessionId = ? AND entryId = ?')
        .get(sessionId, entryId) as { origin: unknown }
    ).origin

  it('SDP-O1 insert 带 origin 就存下；不带 → NULL；重播同一条目不改已存的种类', () => {
    addSession('s1')
    add('s1', '1', '2026-10-24', 10, 'trigger')
    add('s1', '2', '2026-10-24', 20)
    add('s1', CREATED_ENTRY_ID, '2026-10-24', 5)
    expect(originOf('s1', '1')).toBe('trigger')
    expect(originOf('s1', '2')).toBeNull()
    expect(originOf('s1', CREATED_ENTRY_ID)).toBeNull()
    expect(
      sessionDayPromptDao.insert({
        sessionId: 's1',
        entryId: '1',
        day: '2026-10-24',
        timestamp: 11,
        origin: 'local'
      })
    ).toBe(false)
    expect(originOf('s1', '1')).toBe('trigger')
  })

  it('SDP-O2 humanActiveOnDay：只数人打的与不知道来源的用户条目，按会话去重，带 projectId', () => {
    const day = '2026-10-24'
    for (const kind of ['local', 'remote', 'chrome', 'telegram']) {
      addSession(`h-${kind}`, 'p1')
      add(`h-${kind}`, '1', day, 10, kind)
    }
    addSession('legacy', null)
    add('legacy', '1', day, 10) // 旧行 / 没盖章：按人算
    for (const kind of ['trigger', 'session', 'parent-session']) {
      addSession(`m-${kind}`, 'p1')
      add(`m-${kind}`, '1', day, 10, kind)
    }
    addSession('created-only', 'p1')
    add('created-only', CREATED_ENTRY_ID, day, 10)
    addSession('other-day', 'p1')
    add('other-day', '1', '2026-10-23', 10, 'local')
    addSession('mixed', 'p2')
    add('mixed', '1', day, 10, 'trigger')
    add('mixed', '2', day, 20, 'local')
    add('mixed', '3', day, 30, 'local')
    addSession('webhook', 'p1')
    add('webhook', '1', day, 10, 'webhook')
    // 会话行已经没了（删会话没清干净的索引行）：INNER JOIN 不认
    add('ghost', '1', day, 10, 'local')

    const rows = sessionDayPromptDao.humanActiveOnDay(day)
    expect(rows.map((r) => r.sessionId).sort()).toEqual(
      ['h-chrome', 'h-local', 'h-remote', 'h-telegram', 'legacy', 'mixed'].sort()
    )
    expect(rows.find((r) => r.sessionId === 'mixed')).toEqual({
      sessionId: 'mixed',
      projectId: 'p2'
    })
    expect(rows.find((r) => r.sessionId === 'legacy')).toEqual({
      sessionId: 'legacy',
      projectId: null
    })
    expect(sessionDayPromptDao.humanActiveOnDay('2026-10-23').map((r) => r.sessionId)).toEqual([
      'other-day'
    ])
    expect(sessionDayPromptDao.humanActiveOnDay('2026-10-25')).toEqual([])
  })

  it('SDP-O3 activityBetween：含两端；origins 去重排序、NULL → unknown、建成那行不进 origins 但只有它时给 lastAt；按 lastAt 倒序；会话行没了的不出现', () => {
    addSession('a', 'p1', 9_999) // sessions.lastActiveAt 不参与排序
    add('a', CREATED_ENTRY_ID, '2026-10-20', 100)
    add('a', '1', '2026-10-20', 110, 'local')
    add('a', '2', '2026-10-21', 120, 'trigger')
    add('a', '3', '2026-10-22', 130, 'local')
    add('a', '4', '2026-10-23', 999, 'local') // 区间外：不算 origins，也不顶 lastAt
    addSession('b', null, 1)
    add('b', '1', '2026-10-22', 200) // 旧行 → unknown
    add('b', '2', '2026-10-22', 210, 'remote')
    addSession('c', 'p2', 1)
    add('c', CREATED_ENTRY_ID, '2026-10-21', 150) // 只有建成那一行
    addSession('d', null, 1)
    add('d', '1', '2026-10-19', 50, 'local') // 区间前
    addSession('e', null, 1)
    add('e', '1', '2026-10-20', 105, 'trigger')
    add('e', CREATED_ENTRY_ID, '2026-10-22', 300) // 建成那行更晚（fork）：lastAt 仍取用户条目
    add('ghost', '1', '2026-10-21', 400, 'local')

    const rows = sessionDayPromptDao.activityBetween('2026-10-20', '2026-10-22')
    expect(rows.map((r) => [r.session.id, r.origins, r.lastAt])).toEqual([
      ['b', ['remote', 'unknown'], 210],
      ['c', [], 150],
      ['a', ['local', 'trigger'], 130],
      ['e', ['trigger'], 105]
    ])
    // 会话行原样解析（settings 是对象）
    expect(rows[0]!.session).toMatchObject({
      id: 'b',
      title: 'title b',
      projectId: null,
      settings: {}
    })

    // 单日区间（两端相同）
    expect(
      sessionDayPromptDao.activityBetween('2026-10-23', '2026-10-23').map((r) => r.session.id)
    ).toEqual(['a'])
    expect(sessionDayPromptDao.activityBetween('2026-10-24', '2026-10-30')).toEqual([])
  })
})
