/**
 * 迁移 v36 —— 内置浏览器的历史记录：`browser_history_urls`（一个网址一行）+ `browser_history_visits`（每次访问一行）。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV35.test）：按顺序跑 v1 起的每一个 up()。
 * MV36-1 走真的 runMigrations（user_version 从 35 推到最新）—— 它用的是 better-sqlite3 的 pragma / transaction，
 * 这里给 node:sqlite 包一层只有这几个方法的薄壳。
 *
 *   MV36-1  v35 库 → 最新：两张表逐列（类型 / NOT NULL / 缺省 / 主键）；网址表 id 是 AUTOINCREMENT 主键、url
 *           UNIQUE；访问表的 visitedAt / urlId 两个索引；user_version = 最新；已有的表与行不动
 *   MV36-2  缺省读回（标题 / 图标 ''、三个计数 0、transition 'link'、sessionId NULL）；同一个 url 再插一行抛；
 *           必填列给 NULL 抛
 *   MV36-3  表已在时再跑（user_version 被拨回 35）：不抛，表与索引各一个，已写的行原样
 */
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations, runMigrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const URLS = 'browser_history_urls'
const VISITS = 'browser_history_visits'
const INDEXES = ['idx_browser_history_visits_urlId', 'idx_browser_history_visits_visitedAt']

/** 按顺序跑迁移到 upTo（含） */
function migrate(db: DatabaseSync, upTo: number): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    m.up(db as unknown as Db)
  }
}

const v36 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 36)!

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

const tableNames = (db: DatabaseSync): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Row[]
  ).map((r) => String(r.name))

/** [name, type, notnull, dflt_value, pk] */
const columns = (db: DatabaseSync, table: string): unknown[][] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => [
    c.name,
    c.type,
    c.notnull,
    c.dflt_value,
    c.pk
  ])

const count = (db: DatabaseSync, sql: string): number =>
  Number((db.prepare(sql).get() as { n: number }).n)

/** 一个跑到 v35、带一条会话与一条触发日志的库（user_version = 35） */
function v35Db(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrate(db, 35)
  db.exec('PRAGMA user_version = 35')
  db.prepare(
    'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('s1', 'kept', null, null, '{}', 1, 2, 3)
  db.prepare(
    'INSERT INTO trigger_logs (id, createdAt, updatedAt, trigger, bot, outcome) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('log-1', 10, 11, 'timer.fired', 'ticker', 'started')
  return db
}

function insertUrl(db: DatabaseSync, url: string | null): void {
  db.prepare(`INSERT INTO ${URLS} (url) VALUES (?)`).run(url)
}

describe('迁移 v36：浏览器历史记录', () => {
  it('MV36-1 v35 库 → 最新：两张表逐列、AUTOINCREMENT 主键、url UNIQUE、两个索引；已有的表与行不动', () => {
    const db = v35Db()
    expect(tableNames(db)).not.toContain(URLS)
    expect(tableNames(db)).not.toContain(VISITS)
    const tablesBefore = tableNames(db)
    const sessionsBefore = db.prepare('SELECT * FROM sessions').all()
    const logsBefore = db.prepare('SELECT * FROM trigger_logs').all()

    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 35)
    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    expect(userVersion(db)).toBeGreaterThanOrEqual(36)

    expect(columns(db, URLS)).toEqual([
      ['id', 'INTEGER', 0, null, 1],
      ['url', 'TEXT', 1, null, 0],
      ['title', 'TEXT', 1, "''", 0],
      ['favicon', 'TEXT', 1, "''", 0],
      ['visitCount', 'INTEGER', 1, '0', 0],
      ['typedCount', 'INTEGER', 1, '0', 0],
      ['lastVisitAt', 'INTEGER', 1, '0', 0]
    ])
    expect(columns(db, VISITS)).toEqual([
      ['id', 'INTEGER', 0, null, 1],
      ['urlId', 'INTEGER', 1, null, 0],
      ['visitedAt', 'INTEGER', 1, null, 0],
      ['transition', 'TEXT', 1, "'link'", 0],
      ['sessionId', 'TEXT', 0, null, 0]
    ])

    // 网址表的主键是 AUTOINCREMENT（删掉的 id 不复用）；url 上有一个 UNIQUE 约束建的自动索引
    const urlsSql = String(
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(URLS) as Row
      ).sql
    )
    expect(urlsSql).toMatch(/id\s+INTEGER\s+PRIMARY KEY AUTOINCREMENT/)
    const urlIndexes = db.prepare(`PRAGMA index_list(${URLS})`).all() as Row[]
    const unique = urlIndexes.filter((i) => i.origin === 'u')
    expect(unique).toHaveLength(1)
    expect(unique[0].unique).toBe(1)
    const uniqueCols = (
      db.prepare(`PRAGMA index_info('${String(unique[0].name)}')`).all() as Row[]
    ).map((c) => c.name)
    expect(uniqueCols).toEqual(['url'])

    const visitIndexes = (db.prepare(`PRAGMA index_list(${VISITS})`).all() as Row[])
      .filter((i) => i.origin === 'c')
      .map((i) => String(i.name))
      .sort()
    expect(visitIndexes).toEqual(INDEXES)
    for (const [index, column] of [
      ['idx_browser_history_visits_urlId', 'urlId'],
      ['idx_browser_history_visits_visitedAt', 'visitedAt']
    ]) {
      const keys = (db.prepare(`PRAGMA index_info('${index}')`).all() as Row[]).map((k) => k.name)
      expect(keys, index).toEqual([column])
    }

    // 已有的表一个不少、行原样
    for (const t of tablesBefore) expect(tableNames(db)).toContain(t)
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual(sessionsBefore)
    expect(db.prepare('SELECT * FROM trigger_logs').all()).toEqual(logsBefore)
    expect(count(db, `SELECT COUNT(*) AS n FROM ${URLS}`)).toBe(0)
    expect(count(db, `SELECT COUNT(*) AS n FROM ${VISITS}`)).toBe(0)
  })

  it('MV36-2 缺省读回；同一个 url 再插一行抛；必填列给 NULL 抛', () => {
    const db = v35Db()
    runMigrations(betterSqliteShim(db))

    insertUrl(db, 'https://a.test/')
    expect(db.prepare(`SELECT * FROM ${URLS}`).get()).toEqual({
      id: 1,
      url: 'https://a.test/',
      title: '',
      favicon: '',
      visitCount: 0,
      typedCount: 0,
      lastVisitAt: 0
    })
    db.prepare(`INSERT INTO ${VISITS} (urlId, visitedAt) VALUES (?, ?)`).run(1, 1234)
    expect(db.prepare(`SELECT * FROM ${VISITS}`).get()).toEqual({
      id: 1,
      urlId: 1,
      visitedAt: 1234,
      transition: 'link',
      sessionId: null
    })

    expect(() => insertUrl(db, 'https://a.test/')).toThrow(/UNIQUE/)
    expect(() => insertUrl(db, null)).toThrow(/NOT NULL/)
    expect(() =>
      db.prepare(`INSERT INTO ${VISITS} (urlId, visitedAt) VALUES (?, ?)`).run(null, 1)
    ).toThrow(/NOT NULL/)
    expect(() =>
      db.prepare(`INSERT INTO ${VISITS} (urlId, visitedAt) VALUES (?, ?)`).run(1, null)
    ).toThrow(/NOT NULL/)
    expect(count(db, `SELECT COUNT(*) AS n FROM ${URLS}`)).toBe(1)
    expect(count(db, `SELECT COUNT(*) AS n FROM ${VISITS}`)).toBe(1)

    // AUTOINCREMENT：删掉最大的 id 之后新行不复用它
    insertUrl(db, 'https://b.test/')
    db.prepare(`DELETE FROM ${URLS} WHERE id = 2`).run()
    insertUrl(db, 'https://c.test/')
    expect(
      (db.prepare(`SELECT id FROM ${URLS} WHERE url = ?`).get('https://c.test/') as Row).id
    ).toBe(3)
  })

  it('MV36-3 表已在时再跑（user_version 拨回 35）：不抛，表与索引各一个，已写的行原样', () => {
    const db = v35Db()
    runMigrations(betterSqliteShim(db))
    insertUrl(db, 'https://kept.test/')
    db.prepare(
      `UPDATE ${URLS} SET title = 'Kept', visitCount = 2, typedCount = 1, lastVisitAt = 99`
    ).run()
    db.prepare(
      `INSERT INTO ${VISITS} (urlId, visitedAt, transition, sessionId) VALUES (1, 99, 'typed', 's1')`
    ).run()
    const urlsBefore = db.prepare(`SELECT * FROM ${URLS}`).all()
    const visitsBefore = db.prepare(`SELECT * FROM ${VISITS}`).all()

    expect(() => v36().up(db as unknown as Db)).not.toThrow()
    db.exec('PRAGMA user_version = 35')
    expect(() => runMigrations(betterSqliteShim(db))).not.toThrow()

    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    for (const table of [URLS, VISITS]) {
      expect(
        count(
          db,
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${table}'`
        ),
        table
      ).toBe(1)
    }
    for (const index of INDEXES) {
      expect(
        count(
          db,
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = '${index}'`
        ),
        index
      ).toBe(1)
    }
    expect(db.prepare(`SELECT * FROM ${URLS}`).all()).toEqual(urlsBefore)
    expect(db.prepare(`SELECT * FROM ${VISITS}`).all()).toEqual(visitsBefore)
  })
})
