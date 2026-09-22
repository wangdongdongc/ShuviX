/**
 * 迁移 v28 —— 种内置能力服务器 `database`；内置名被用户自己的 server 占着时，那一行让位改名
 * （与 v27 的 browser / ssh 同一条规则）。已保存的数据库连接（`db_credentials`）一个字节都不动：
 * 内置 server 在进程内直接读它们。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV27.test）：按顺序跑 v1 起的每一个 up()，
 * 用户自己的行在 v28 之前插进去 —— UNIQUE(name) 约束是真的在起作用。
 *
 *   MV28-1  新库：builtin-mcp-database 的整行形状；内置 inproc 行恰是 browser / database / ssh；
 *   MV28-2  database 被占：那一行改名 database-custom，其余字段不动、updatedAt 刷新；无关的行不动；
 *   MV28-3  database-custom 也被占 → -2，再占 → -3；
 *   MV28-4  重跑 v28 是空操作（停用了的内置行仍是停用）；
 *   MV28-5  db_credentials 逐字节不变；
 *   MV28-6  名字只差大小写（`Database`）不算撞名 —— SQLite 的 UNIQUE 比较区分大小写。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const NOW = 1_900_000_000_000

afterEach(() => {
  vi.restoreAllMocks()
})

/** 按顺序跑迁移；`before[v]` 在跑第 v 版之前调（用户的行在那一刻已经在库里了） */
function migrate(db: DatabaseSync, before: Record<number, () => void> = {}, upTo = 28): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    before[m.version]?.()
    if (m.version === 28) vi.spyOn(Date, 'now').mockReturnValue(NOW)
    m.up(db as unknown as Db)
  }
}

const v28 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 28)!

/** 一台用户自己的 server（字段取值都与内置行不同，改没改一眼看得出） */
function userServer(id: string, name: string, over: Row = {}): Row {
  return {
    id,
    name,
    type: 'stdio',
    command: 'npx',
    args: '["-y","@modelcontextprotocol/server-postgres"]',
    env: '{"PGPASSWORD":"p"}',
    url: '',
    headers: '{}',
    metadata: '{"note":"mine"}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[{"name":"query"}]',
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function insert(db: DatabaseSync, table: string, row: Row): void {
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...(Object.values(row) as Array<string | number>))
}

const byId = (db: DatabaseSync, id: string): Row | undefined =>
  db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined

const byName = (db: DatabaseSync, name: string): Row | undefined =>
  db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as Row | undefined

const allRows = (db: DatabaseSync, table = 'mcp_servers'): Row[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Row[]

/** 内置 database 行应有的样子（整行只读，除了启用位） */
const builtinDatabaseRow = (): Row => ({
  id: 'builtin-mcp-database',
  name: 'database',
  type: 'inproc',
  command: '',
  args: '[]',
  env: '{}',
  url: '',
  headers: '{}',
  metadata: '{}',
  isEnabled: 1,
  isBuiltin: 1,
  cachedTools: '[]',
  createdAt: NOW,
  updatedAt: NOW
})

describe('迁移 v28：内置 database 的种子与撞名让位', () => {
  it('MV28-1 新库跑到 v28：builtin-mcp-database 的整行形状；内置 inproc 行恰是 browser / database / ssh', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    expect(byId(db, 'builtin-mcp-database')).toEqual(builtinDatabaseRow())
    expect(
      (
        db.prepare("SELECT id FROM mcp_servers WHERE type = 'inproc' ORDER BY id").all() as Row[]
      ).map((r) => r.id)
    ).toEqual(['builtin-mcp-browser', 'builtin-mcp-database', 'builtin-mcp-ssh'])
  })

  it('MV28-2 database 被用户的 server 占着：那一行改名 database-custom，其余字段不动、updatedAt 刷新；内置行拿到名字；别的行一概不动', () => {
    const db = new DatabaseSync(':memory:')
    const mine = userServer('u1', 'database')
    let others: Row[] = []
    migrate(db, {
      28: () => {
        insert(db, 'mcp_servers', mine)
        others = allRows(db).filter((r) => r.id !== 'u1')
      }
    })

    expect(byId(db, 'u1')).toEqual({ ...mine, name: 'database-custom', updatedAt: NOW })
    expect(byName(db, 'database')).toEqual(builtinDatabaseRow())
    // 迁移只碰撞名的那一行（tavily、内置 ssh / browser 原样）
    expect(others.map((r) => r.id)).toEqual(
      expect.arrayContaining(['builtin-mcp-browser', 'builtin-mcp-ssh', 'builtin-mcp-tavily'])
    )
    for (const row of others) expect(byId(db, row.id as string)).toEqual(row)
  })

  it.each<[string, string[], string]>([
    ['database-custom 也被占 → 加序号 -2', ['database-custom'], 'database-custom-2'],
    ['-2 也被占 → -3', ['database-custom', 'database-custom-2'], 'database-custom-3']
  ])('MV28-3 %s', (_l, taken, expected) => {
    const db = new DatabaseSync(':memory:')
    const takenRows = taken.map((name, i) => userServer(`taken-${i}`, name, { type: 'http' }))
    migrate(db, {
      28: () => {
        insert(db, 'mcp_servers', userServer('u1', 'database'))
        takenRows.forEach((row) => insert(db, 'mcp_servers', row))
      }
    })

    expect(byId(db, 'u1')?.name).toBe(expected)
    // 已经叫 -custom 的那几行一个字段都没动
    takenRows.forEach((row) => expect(byId(db, row.id as string)).toEqual(row))
    expect(byName(db, 'database')?.id).toBe('builtin-mcp-database')
  })

  it('MV28-4 重跑 v28 是空操作：内置行已在就不动（用户停用的仍停用），也不再改任何人的名字', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, { 28: () => insert(db, 'mcp_servers', userServer('u1', 'database')) })
    db.prepare("UPDATE mcp_servers SET isEnabled = 0 WHERE id = 'builtin-mcp-database'").run()
    const before = allRows(db)

    vi.spyOn(Date, 'now').mockReturnValue(NOW + 1000)
    v28().up(db as unknown as Db)

    expect(allRows(db)).toEqual(before)
    expect(byId(db, 'builtin-mcp-database')?.isEnabled).toBe(0)
    expect(byId(db, 'u1')?.name).toBe('database-custom')
  })

  it('MV28-5 已保存的数据库连接（db_credentials）逐字节不变', () => {
    const db = new DatabaseSync(':memory:')
    const creds: Row[] = [
      {
        id: 'c1',
        name: 'prod',
        dbType: 'postgresql',
        host: 'db.example',
        port: 5432,
        username: 'alice',
        password: 'enc:v1:abcdef',
        database: 'hr',
        authType: 'password',
        token: '',
        connStr: '',
        readonly: 1,
        metadata: '{"ssl":true}',
        createdAt: 10,
        updatedAt: 11
      },
      {
        id: 'c2',
        name: 'database',
        dbType: 'mysql',
        host: '10.0.0.7',
        port: 3306,
        username: 'bob',
        password: 'enc:v1:123456',
        database: 'shop',
        authType: 'password',
        token: 'enc:v1:tok',
        connStr: '',
        readonly: 0,
        metadata: '{}',
        createdAt: 20,
        updatedAt: 21
      }
    ]
    let before: Row[] = []
    migrate(db, {
      28: () => {
        creds.forEach((c) => insert(db, 'db_credentials', c))
        before = allRows(db, 'db_credentials')
      }
    })

    expect(before).toEqual(creds)
    // 一条连接恰好也叫 database —— 它在另一张表里，与 server 名不相干
    expect(allRows(db, 'db_credentials')).toEqual(before)
  })

  it('MV28-6 名字只差大小写（Database）不算撞名：那一行原样，内置行照种', () => {
    const db = new DatabaseSync(':memory:')
    const mine = userServer('u1', 'Database')
    migrate(db, { 28: () => insert(db, 'mcp_servers', mine) })

    expect(byId(db, 'u1')).toEqual(mine)
    expect(byName(db, 'database')?.id).toBe('builtin-mcp-database')
  })
})
