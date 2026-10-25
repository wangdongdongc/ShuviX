/**
 * 迁移 v35 —— `trigger_logs`：触发日志（触发源与 bot 解绑之后，用户靠它看见「哪个事件叫起了哪个 bot」）。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV34.test）：按顺序跑 v1 起的每一个 up()。
 * MV35-1 走真的 runMigrations（user_version 从 34 推到最新）—— 它用的是 better-sqlite3 的 pragma / transaction，
 * 这里给 node:sqlite 包一层只有这几个方法的薄壳。
 *
 *   MV35-1  v34 库 → v35：trigger_logs 的 14 列（类型 / NOT NULL / 缺省 / 主键逐列）、createdAt 倒序索引；
 *           user_version = 最新；已有的表与行不动
 *   MV35-2  列缺省与 NOT NULL：只给必填列的一行读回 '' / 0 / '{}'；必填列给 NULL 抛
 *   MV35-3  表已在时再跑（user_version 被拨回 34）：不抛，表与索引各一个，已写的行原样
 */
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations, runMigrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

/** 按顺序跑迁移到 upTo（含） */
function migrate(db: DatabaseSync, upTo: number): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    m.up(db as unknown as Db)
  }
}

const v35 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 35)!

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

const tableExists = (db: DatabaseSync): boolean =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trigger_logs'")
    .get() !== undefined

const columns = (db: DatabaseSync): Row[] =>
  db.prepare('PRAGMA table_info(trigger_logs)').all() as Row[]

/** 一个跑到 v34、带一条会话的库（user_version = 34） */
function v34Db(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrate(db, 34)
  db.exec('PRAGMA user_version = 34')
  db.prepare(
    'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('s1', 'kept', null, null, '{"bot":"ticker"}', 1, 2, 3)
  return db
}

/** 只给必填列（其余靠缺省） */
function insertMinimal(
  db: DatabaseSync,
  id: string,
  over: Partial<Record<string, unknown>> = {}
): void {
  const row = {
    id,
    createdAt: 10,
    updatedAt: 11,
    trigger: 'timer.fired',
    bot: 'ticker',
    outcome: 'started',
    ...over
  }
  db.prepare(
    'INSERT INTO trigger_logs (id, createdAt, updatedAt, trigger, bot, outcome) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    row.id as string,
    row.createdAt as number | null,
    row.updatedAt as number | null,
    row.trigger as string | null,
    row.bot as string | null,
    row.outcome as string | null
  )
}

describe('迁移 v35：trigger_logs', () => {
  it('MV35-1 v34 库 → v35：14 列逐列、createdAt 倒序索引；user_version = 最新；已有行不动', () => {
    const db = v34Db()
    expect(tableExists(db)).toBe(false)
    const sessionsBefore = db.prepare('SELECT * FROM sessions').all()

    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 34)
    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    expect(userVersion(db)).toBeGreaterThanOrEqual(35)

    // [name, type, notnull, dflt_value, pk]
    expect(columns(db).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk])).toEqual([
      ['id', 'TEXT', 0, null, 1],
      ['createdAt', 'INTEGER', 1, null, 0],
      ['updatedAt', 'INTEGER', 1, null, 0],
      ['sourceId', 'TEXT', 1, "''", 0],
      ['trigger', 'TEXT', 1, null, 0],
      ['bot', 'TEXT', 1, null, 0],
      ['botDisplayName', 'TEXT', 1, "''", 0],
      ['botFile', 'TEXT', 1, "''", 0],
      ['bindingIndex', 'INTEGER', 1, '0', 0],
      ['when', 'TEXT', 1, "''", 0],
      ['outcome', 'TEXT', 1, null, 0],
      ['sessionId', 'TEXT', 1, "''", 0],
      ['error', 'TEXT', 1, "''", 0],
      ['event', 'TEXT', 1, "'{}'", 0]
    ])

    const indexes = db.prepare('PRAGMA index_list(trigger_logs)').all() as Row[]
    expect(indexes.filter((i) => i.origin === 'c').map((i) => i.name)).toEqual([
      'idx_trigger_logs_createdAt'
    ])
    // index_xinfo：key 列只有 createdAt，desc = 1
    const keys = (
      db.prepare("PRAGMA index_xinfo('idx_trigger_logs_createdAt')").all() as Row[]
    ).filter((k) => k.key === 1)
    expect(keys.map((k) => [k.name, k.desc])).toEqual([['createdAt', 1]])

    expect(db.prepare('SELECT * FROM sessions').all()).toEqual(sessionsBefore)
    expect(db.prepare('SELECT COUNT(*) AS n FROM trigger_logs').get()).toEqual({ n: 0 })
  })

  it("MV35-2 列缺省与 NOT NULL：只给必填列的一行读回 '' / 0 / '{}'；必填列给 NULL 抛", () => {
    const db = v34Db()
    runMigrations(betterSqliteShim(db))

    insertMinimal(db, 'a')
    expect(db.prepare("SELECT * FROM trigger_logs WHERE id = 'a'").get()).toEqual({
      id: 'a',
      createdAt: 10,
      updatedAt: 11,
      sourceId: '',
      trigger: 'timer.fired',
      bot: 'ticker',
      botDisplayName: '',
      botFile: '',
      bindingIndex: 0,
      when: '',
      outcome: 'started',
      sessionId: '',
      error: '',
      event: '{}'
    })

    for (const column of ['createdAt', 'updatedAt', 'trigger', 'bot', 'outcome']) {
      expect(() => insertMinimal(db, `null-${column}`, { [column]: null }), column).toThrow(
        /NOT NULL/
      )
    }
    // 主键不能重复
    expect(() => insertMinimal(db, 'a')).toThrow(/UNIQUE|PRIMARY KEY/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM trigger_logs').get()).toEqual({ n: 1 })
  })

  it('MV35-3 表已在时再跑（user_version 被拨回 34）：不抛，表与索引各一个，已写的行原样', () => {
    const db = v34Db()
    runMigrations(betterSqliteShim(db))
    insertMinimal(db, 'kept')
    db.prepare(
      `UPDATE trigger_logs SET sourceId = 'timer:builtin:minute', "when" = 'event.local.time == ''18:00''',
         event = '{"trigger":"timer.fired"}' WHERE id = 'kept'`
    ).run()
    const before = db.prepare('SELECT * FROM trigger_logs').all()

    expect(() => v35().up(db as unknown as Db)).not.toThrow()
    db.exec('PRAGMA user_version = 34')
    expect(() => runMigrations(betterSqliteShim(db))).not.toThrow()

    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'trigger_logs'"
        )
        .get()
    ).toEqual({ n: 1 })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_trigger_logs_createdAt'"
        )
        .get()
    ).toEqual({ n: 1 })
    expect(columns(db)).toHaveLength(14)
    expect(db.prepare('SELECT * FROM trigger_logs').all()).toEqual(before)
  })
})
