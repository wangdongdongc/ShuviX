/**
 * 迁移 v43 —— `web_search` 的 API 方式：建密钥表 `web_search_keys`（一家一行，apiKey 是密文）。只建表，不动别的。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV42.test）：按顺序跑到 v42，再跑 v43。MG-7 走真的
 * runMigrations（better-sqlite3 的 pragma / transaction 由一层薄壳给出）。
 *
 *   MG-1  有 v43，紧跟在 v42 后面
 *   MG-2  只多出 web_search_keys 这一张表（连同它的自动索引），别的表 / 索引 / 触发器原样
 *   MG-3  三列：provider TEXT 主键、apiKey TEXT NOT NULL、updatedAt INTEGER NOT NULL
 *   MG-4  已有的行（settings / mcp_servers / sessions）原样；新表是空的
 *   MG-5  同一家两行、apiKey 为 NULL 都被拒
 *   MG-6  重跑不抛，中间写下的行还在
 *   MG-7  真的 runMigrations：v42 库 → 最新，表在
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations, runMigrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
})

function at42(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) {
    if (m.version > 42) break
    m.up(db as unknown as Db)
  }
  return db
}

const v43 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 43)!
const runV43 = (db: DatabaseSync): void => v43().up(db as unknown as Db)

function insert(db: DatabaseSync, table: string, row: Row): void {
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...(Object.values(row) as Array<string | number | null>))
}

const master = (db: DatabaseSync): Row[] =>
  db
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
    .all() as Row[]

const allOf = (db: DatabaseSync, table: string): Row[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Row[]

const userVersion = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

/** runMigrations 用到的 better-sqlite3 面（同 migrationV42.test 的薄壳） */
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

describe('v43：web_search_keys', () => {
  it('MG-1 version 43 exists and comes right after 42', () => {
    const versions = migrations.map((m) => m.version)
    expect(versions).toContain(43)
    expect(versions[versions.indexOf(43) - 1]).toBe(42)
    for (let i = 1; i < versions.length; i++) expect(versions[i]).toBeGreaterThan(versions[i - 1])
  })

  it('MG-2 the only thing added is the table web_search_keys (with its automatic index)', () => {
    const db = at42()
    const before = master(db)
    runV43(db)
    const after = master(db)
    const added = after.filter((a) => !before.some((b) => b.type === a.type && b.name === a.name))
    expect(added.filter((r) => r.type === 'table').map((r) => r.name)).toEqual(['web_search_keys'])
    expect(added.every((r) => r.tbl_name === 'web_search_keys')).toBe(true)
    expect(added.filter((r) => r.type === 'trigger' || r.type === 'view')).toEqual([])
    expect(after.filter((r) => r.tbl_name !== 'web_search_keys')).toEqual(before)
  })

  it('MG-3 exactly three columns: provider (key), apiKey, updatedAt', () => {
    const db = at42()
    runV43(db)
    const columns = db.prepare('PRAGMA table_info(web_search_keys)').all() as Array<{
      name: string
      type: string
      notnull: number
      pk: number
    }>
    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: 'provider', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'apiKey', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updatedAt', type: 'INTEGER', notnull: 1, pk: 0 }
    ])
  })

  it('MG-4 rows that were there stay byte for byte; the new table is empty', () => {
    const db = at42()
    insert(db, 'settings', { key: 'webSearch.provider', value: 'tavily' })
    insert(db, 'settings', { key: 'general.theme', value: ' dark ' })
    insert(db, 'sessions', {
      id: 's1',
      title: 'one',
      projectId: null,
      parentId: null,
      settings: '{ "enabledTools": ["mcp:browser"] }',
      createdAt: 1,
      updatedAt: 2,
      lastActiveAt: 3
    })
    const before = {
      settings: allOf(db, 'settings'),
      servers: allOf(db, 'mcp_servers'),
      sessions: allOf(db, 'sessions')
    }
    expect(before.servers.length).toBeGreaterThan(0)
    runV43(db)
    expect(allOf(db, 'settings')).toEqual(before.settings)
    expect(allOf(db, 'mcp_servers')).toEqual(before.servers)
    expect(allOf(db, 'sessions')).toEqual(before.sessions)
    expect(allOf(db, 'web_search_keys')).toEqual([])
  })

  it('MG-5 one row per provider; apiKey and updatedAt are required', () => {
    const db = at42()
    runV43(db)
    insert(db, 'web_search_keys', { provider: 'tavily', apiKey: 'c1', updatedAt: 1 })
    expect(() =>
      insert(db, 'web_search_keys', { provider: 'tavily', apiKey: 'c2', updatedAt: 2 })
    ).toThrow()
    expect(() =>
      insert(db, 'web_search_keys', { provider: 'exa', apiKey: null, updatedAt: 1 })
    ).toThrow()
    expect(() =>
      insert(db, 'web_search_keys', { provider: 'exa', apiKey: 'c', updatedAt: null })
    ).toThrow()
    expect(allOf(db, 'web_search_keys')).toEqual([
      { provider: 'tavily', apiKey: 'c1', updatedAt: 1 }
    ])
  })

  it('MG-6 running it again does not throw and keeps what was stored', () => {
    const db = at42()
    runV43(db)
    insert(db, 'web_search_keys', { provider: 'exa', apiKey: 'cipher', updatedAt: 7 })
    expect(() => runV43(db)).not.toThrow()
    expect(allOf(db, 'web_search_keys')).toEqual([
      { provider: 'exa', apiKey: 'cipher', updatedAt: 7 }
    ])
  })

  it('MG-7 the real runMigrations takes a v42 database to the latest version with the table', () => {
    const db = at42()
    db.exec('PRAGMA user_version = 42')
    insert(db, 'settings', { key: 'general.theme', value: 'dark' })

    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 42)

    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    expect(userVersion(db)).toBeGreaterThanOrEqual(43)
    expect(allOf(db, 'web_search_keys')).toEqual([])
    expect(allOf(db, 'settings')).toContainEqual({ key: 'general.theme', value: 'dark' })
  })
})
