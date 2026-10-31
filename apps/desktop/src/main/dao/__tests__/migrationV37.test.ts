/**
 * 迁移 v37 —— 种内置能力服务器 `plan`（任务列表，实验，会话默认不勾）；内置名被用户自己的 server 占着时，
 * 那一行让位改名（与 v27 / v28 / v29 同一条规则）。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV29.test）：按顺序跑 v1 起的每一个 up()，
 * 用户自己的行在 v37 之前插进去 —— UNIQUE(name) 约束是真的在起作用。MIG37-6 走真的 runMigrations
 * （user_version 从 36 推上去），better-sqlite3 的 pragma / transaction 由一层薄壳给出（同 migrationV34.test）。
 *
 *   MIG37-1  新库：builtin-mcp-plan 的整行形状；内置 inproc 行恰是 browser / chrome / database / plan / ssh
 *   MIG37-2  plan 被占：那一行改名 plan-custom，其余字段不动、updatedAt 刷新；内置行拿到名字；别的行一概不动
 *   MIG37-3  plan-custom 也被占 → -2，再占 → -3；已占着那些名字的行不动
 *   MIG37-4  重跑 v37 是空操作（停用了的内置行仍是停用、不再改任何人的名字）
 *   MIG37-5  名字只差大小写（`Plan`）不算撞名 —— SQLite 的 UNIQUE 比较区分大小写
 *   MIG37-6  真的 runMigrations：v36 库 → ≥ v37、内置行在；sessions 表一个字节不动（勾过 `mcp:plan` 的会话
 *            settings.enabledTools 原样，那个勾从此指向内置行，同 v27）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations, runMigrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const NOW = 1_900_000_000_000

afterEach(() => {
  vi.restoreAllMocks()
})

/** 按顺序跑迁移；`before[v]` 在跑第 v 版之前调（用户的行在那一刻已经在库里了） */
function migrate(db: DatabaseSync, before: Record<number, () => void> = {}, upTo = 37): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    before[m.version]?.()
    if (m.version === 37) vi.spyOn(Date, 'now').mockReturnValue(NOW)
    m.up(db as unknown as Db)
  }
}

const v37 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 37)!

/** 一台用户自己的 server（字段取值都与内置行不同，改没改一眼看得出） */
function userServer(id: string, name: string, over: Row = {}): Row {
  return {
    id,
    name,
    type: 'stdio',
    command: 'npx',
    args: '["-y","my-plan-mcp@latest"]',
    env: '{"PLAN_DIR":"/opt/plans"}',
    url: '',
    headers: '{}',
    metadata: '{"note":"mine"}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[{"name":"make_plan"}]',
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

/** 内置 plan 行应有的样子（整行只读，除了启用位） */
const builtinPlanRow = (): Row => ({
  id: 'builtin-mcp-plan',
  name: 'plan',
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

describe('迁移 v37：内置 plan 的种子与撞名让位', () => {
  it('MIG37-1 新库跑到 v37：builtin-mcp-plan 的整行形状；内置 inproc 行恰是 browser / chrome / database / plan / ssh', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    expect(byId(db, 'builtin-mcp-plan')).toEqual(builtinPlanRow())
    expect(
      (
        db.prepare("SELECT id FROM mcp_servers WHERE type = 'inproc' ORDER BY id").all() as Row[]
      ).map((r) => r.id)
    ).toEqual([
      'builtin-mcp-browser',
      'builtin-mcp-chrome',
      'builtin-mcp-database',
      'builtin-mcp-plan',
      'builtin-mcp-ssh'
    ])
  })

  it('MIG37-2 plan 被用户的 server 占着：那一行改名 plan-custom，其余字段不动、updatedAt 刷新；内置行拿到名字；别的行一字不动', () => {
    const db = new DatabaseSync(':memory:')
    const mine = userServer('u1', 'plan')
    let others: Row[] = []
    migrate(db, {
      37: () => {
        insert(db, 'mcp_servers', mine)
        insert(db, 'mcp_servers', userServer('u2', 'playwright', { type: 'http' }))
        others = allRows(db).filter((r) => r.id !== 'u1')
      }
    })

    expect(byId(db, 'u1')).toEqual({ ...mine, name: 'plan-custom', updatedAt: NOW })
    expect(byName(db, 'plan')).toEqual(builtinPlanRow())
    // 迁移只碰撞名的那一行（内置 ssh / browser / database / chrome、别的用户 server 原样）
    expect(others.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'builtin-mcp-browser',
        'builtin-mcp-chrome',
        'builtin-mcp-database',
        'builtin-mcp-ssh',
        'u2'
      ])
    )
    for (const row of others) expect(byId(db, row.id as string)).toEqual(row)
    expect(allRows(db)).toHaveLength(others.length + 2)
  })

  it.each<[string, string[], string]>([
    ['plan-custom 也被占 → 加序号 -2', ['plan-custom'], 'plan-custom-2'],
    ['-2 也被占 → -3', ['plan-custom', 'plan-custom-2'], 'plan-custom-3']
  ])('MIG37-3 %s', (_l, taken, expected) => {
    const db = new DatabaseSync(':memory:')
    const takenRows = taken.map((name, i) => userServer(`taken-${i}`, name, { type: 'http' }))
    migrate(db, {
      37: () => {
        insert(db, 'mcp_servers', userServer('u1', 'plan'))
        takenRows.forEach((row) => insert(db, 'mcp_servers', row))
      }
    })

    expect(byId(db, 'u1')?.name).toBe(expected)
    // 已经叫 -custom 的那几行一个字段都没动
    takenRows.forEach((row) => expect(byId(db, row.id as string)).toEqual(row))
    expect(byName(db, 'plan')?.id).toBe('builtin-mcp-plan')
  })

  it('MIG37-4 重跑 v37 是空操作：内置行已在就不动（用户停用的仍停用），也不再改任何人的名字', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, { 37: () => insert(db, 'mcp_servers', userServer('u1', 'plan')) })
    db.prepare("UPDATE mcp_servers SET isEnabled = 0 WHERE id = 'builtin-mcp-plan'").run()
    // 又有人占了 plan-custom-2 也不相干：内置行在，就整段跳过
    insert(db, 'mcp_servers', userServer('u3', 'plan-custom-2'))
    const before = allRows(db)

    vi.spyOn(Date, 'now').mockReturnValue(NOW + 1000)
    v37().up(db as unknown as Db)

    expect(allRows(db)).toEqual(before)
    expect(byId(db, 'builtin-mcp-plan')?.isEnabled).toBe(0)
    expect(byId(db, 'u1')?.name).toBe('plan-custom')
    expect(byId(db, 'u3')?.name).toBe('plan-custom-2')
  })

  it('MIG37-5 名字只差大小写（Plan）不算撞名：那一行原样，内置行照种', () => {
    const db = new DatabaseSync(':memory:')
    const mine = userServer('u1', 'Plan')
    migrate(db, { 37: () => insert(db, 'mcp_servers', mine) })

    expect(byId(db, 'u1')).toEqual(mine)
    expect(byName(db, 'plan')?.id).toBe('builtin-mcp-plan')
    expect(byName(db, 'Plan')?.id).toBe('u1')
  })

  it('MIG37-6 真的 runMigrations：v36 库 → ≥ v37、内置行在；sessions 一个字节不动，勾过的 mcp:plan 从此指向内置行', () => {
    const db = new DatabaseSync(':memory:')
    for (const m of migrations) {
      if (m.version > 36) break
      m.up(db as unknown as Db)
    }
    db.exec('PRAGMA user_version = 36')
    // 用户自己那台叫 plan 的 server，以及一条勾了它的会话
    insert(db, 'mcp_servers', userServer('u1', 'plan'))
    const settings = '{"enabledTools":["mcp:plan","-mcp:browser"],"model":"x"}'
    db.prepare(
      'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('s1', 'ticked plan', null, null, settings, 1, 1, 1)
    const sessionsBefore = allRows(db, 'sessions')
    vi.spyOn(Date, 'now').mockReturnValue(NOW)

    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 36)
    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    expect(userVersion(db)).toBeGreaterThanOrEqual(37)

    expect(byId(db, 'builtin-mcp-plan')).toEqual(builtinPlanRow())
    expect(byId(db, 'u1')?.name).toBe('plan-custom')
    // sessions 表一行一列都没动：enabledTools 逐字节原样
    expect(allRows(db, 'sessions')).toEqual(sessionsBefore)
    const after = db.prepare("SELECT settings FROM sessions WHERE id = 's1'").get() as Row
    expect(after.settings).toBe(settings)
    // 那个勾按名字解析：`plan` 现在是内置行
    expect(byName(db, 'plan')?.id).toBe('builtin-mcp-plan')
  })
})
