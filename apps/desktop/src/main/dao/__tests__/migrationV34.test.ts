/**
 * 迁移 v34 —— `session_day_prompts.origin`：一条用户条目是谁发的（InputOrigin 的种类），日历的「当天有人写过消息的
 * 会话数」（activeSessions）只数人打的。可空、不回填：旧行与会话建成那一行都是 NULL。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV33.test）：按顺序跑 v1 起的每一个 up()。
 * MV34-1 走真的 runMigrations（user_version 从 33 推到 34）—— 它用的是 better-sqlite3 的 pragma / transaction，
 * 这里给 node:sqlite 包一层只有这几个方法的薄壳。DAO 的基类读 state.db（同 desktopRig 的手法），读侧用真 SQL。
 *
 *   MV34-1  v33 库 → v34：origin 是可空 TEXT、没有默认值；已有的行都是 NULL；user_version = 34
 *   MV34-2  列已在时再跑 up（user_version 被拨回）：不抛，origin 列恰一个，已写的值原样
 *   MV34-3  旧的读侧不受影响：sessionsOnDay / daysInMonth / firstEntryOnDay 迁移前后结果相同
 */
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const state = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return state.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (state.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => state.db } }
})

import { migrations, runMigrations } from '../migrations'
import { CREATED_ENTRY_ID, sessionDayPromptDao } from '../sessionDayPromptDao'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

/** 按顺序跑迁移到 upTo（含） */
function migrate(db: DatabaseSync, upTo: number): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    m.up(db as unknown as Db)
  }
}

const v34 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 34)!

/** runMigrations 用到的 better-sqlite3 面：prepare / exec / pragma / transaction */
function betterSqliteShim(db: DatabaseSync): Parameters<typeof runMigrations>[0] {
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    pragma: (source: string, opts?: { simple?: boolean }) => {
      if (source.includes('=')) {
        db.exec(`PRAGMA ${source}`)
        return []
      }
      const row = db.prepare(`PRAGMA ${source}`).get() as Row
      return opts?.simple ? Object.values(row)[0] : [row]
    },
    transaction: (fn: () => void) => () => {
      db.exec('BEGIN')
      try {
        fn()
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  } as unknown as Parameters<typeof runMigrations>[0]
}

const userVersion = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

function insertSession(
  db: DatabaseSync,
  id: string,
  projectId: string | null,
  lastActiveAt: number
): void {
  db.prepare(
    'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, `title ${id}`, projectId, null, '{}', 1, 1, lastActiveAt)
}

/** v33 形状的一行（还没有 origin 列）—— 只能直接写 SQL，DAO 的 insert 已经带 origin */
function insertPromptV33(
  db: DatabaseSync,
  sessionId: string,
  entryId: string,
  day: string,
  timestamp: number
): void {
  db.prepare(
    'INSERT INTO session_day_prompts (sessionId, entryId, day, timestamp) VALUES (?, ?, ?, ?)'
  ).run(sessionId, entryId, day, timestamp)
}

const originColumns = (db: DatabaseSync): Row[] =>
  (db.prepare('PRAGMA table_info(session_day_prompts)').all() as Row[]).filter(
    (c) => c.name === 'origin'
  )

/** 一个跑到 v33、带几条会话与索引行的库（user_version = 33） */
function v33Db(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrate(db, 33)
  db.exec('PRAGMA user_version = 33')
  insertSession(db, 's1', 'p1', 300)
  insertSession(db, 's2', null, 200)
  insertSession(db, 's3', 'p2', 100)
  insertPromptV33(db, 's1', CREATED_ENTRY_ID, '2026-10-20', 10)
  insertPromptV33(db, 's1', '3', '2026-10-20', 20)
  insertPromptV33(db, 's1', '1', '2026-10-20', 15)
  insertPromptV33(db, 's1', '9', '2026-10-22', 90)
  insertPromptV33(db, 's2', '2', '2026-10-20', 30)
  insertPromptV33(db, 's3', CREATED_ENTRY_ID, '2026-09-30', 5)
  return db
}

describe('迁移 v34：session_day_prompts.origin', () => {
  it('MV34-1 v33 库 → v34：origin 是可空 TEXT、没有默认值；已有行都是 NULL；user_version = 34', () => {
    const db = v33Db()
    expect(originColumns(db)).toEqual([])
    expect(userVersion(db)).toBe(33)

    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 33)
    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    expect(userVersion(db)).toBeGreaterThanOrEqual(34)

    expect(originColumns(db).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk])).toEqual([
      ['origin', 'TEXT', 0, null, 0]
    ])
    const rows = db
      .prepare('SELECT sessionId, entryId, origin FROM session_day_prompts ORDER BY rowid')
      .all() as Row[]
    expect(rows).toHaveLength(6)
    for (const row of rows) expect(row.origin).toBeNull()

    // 新行可以带种类，也可以不带（NULL）
    db.prepare(
      'INSERT INTO session_day_prompts (sessionId, entryId, day, timestamp, origin) VALUES (?, ?, ?, ?, ?)'
    ).run('s2', '7', '2026-10-24', 70, 'trigger')
    expect(db.prepare("SELECT origin FROM session_day_prompts WHERE entryId = '7'").get()).toEqual({
      origin: 'trigger'
    })
  })

  it('MV34-2 列已在时再跑（user_version 被拨回 33）：不抛，origin 列恰一个，已写的值原样', () => {
    const db = v33Db()
    runMigrations(betterSqliteShim(db))
    db.prepare("UPDATE session_day_prompts SET origin = 'local' WHERE entryId = '3'").run()
    const before = db.prepare('SELECT * FROM session_day_prompts ORDER BY rowid').all()

    expect(() => v34().up(db as unknown as Db)).not.toThrow()
    db.exec('PRAGMA user_version = 33')
    expect(() => runMigrations(betterSqliteShim(db))).not.toThrow()

    expect(originColumns(db)).toHaveLength(1)
    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    expect(db.prepare('SELECT * FROM session_day_prompts ORDER BY rowid').all()).toEqual(before)
  })

  it('MV34-3 旧的读侧不受影响：sessionsOnDay / daysInMonth / firstEntryOnDay 迁移前后结果相同', () => {
    const db = v33Db()
    state.db = db
    const read = (): unknown => ({
      onDay20: sessionDayPromptDao.sessionsOnDay('2026-10-20').map((s) => [s.id, s.projectId]),
      onDay22: sessionDayPromptDao.sessionsOnDay('2026-10-22').map((s) => s.id),
      onDay30: sessionDayPromptDao.sessionsOnDay('2026-09-30').map((s) => s.id),
      october: sessionDayPromptDao.daysInMonth(2026, 10),
      september: sessionDayPromptDao.daysInMonth(2026, 9),
      firstS1: sessionDayPromptDao.firstEntryOnDay('s1', '2026-10-20'),
      firstS3: sessionDayPromptDao.firstEntryOnDay('s3', '2026-09-30')
    })
    try {
      const before = read()
      // 钉住迁移前的读数本身（免得两边一起坏也算「相同」）
      expect(before).toEqual({
        onDay20: [
          ['s1', 'p1'],
          ['s2', null]
        ],
        onDay22: ['s1'],
        onDay30: ['s3'],
        october: [
          { day: '2026-10-20', projectId: 'p1' },
          { day: '2026-10-20', projectId: null },
          { day: '2026-10-22', projectId: 'p1' }
        ],
        september: [{ day: '2026-09-30', projectId: 'p2' }],
        firstS1: '1',
        firstS3: undefined
      })

      runMigrations(betterSqliteShim(db))
      expect(read()).toEqual(before)
    } finally {
      state.db = null
    }
  })
})
