/**
 * 迁移 v29 —— 种内置能力服务器 `chrome`（用户真实的 Chrome，只由 Chrome 标签页会话的 tab 档案声明）；
 * 内置名被用户自己的 server 占着时，那一行让位改名（与 v27 / v28 同一条规则）。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV28.test）：按顺序跑 v1 起的每一个 up()，
 * 用户自己的行在 v29 之前插进去 —— UNIQUE(name) 约束是真的在起作用。
 *
 *   MV29-1  新库：builtin-mcp-chrome 的整行形状；内置 inproc 行恰是 browser / chrome / database / ssh
 *   MV29-2  chrome 被占：那一行改名 chrome-custom，其余字段不动、updatedAt 刷新；内置行拿到名字；别的行一概不动
 *   MV29-3  chrome-custom 也被占 → -2，再占 → -3；已占着那些名字的行不动
 *   MV29-4  重跑 v29 是空操作（停用了的内置行仍是停用）
 *   MV29-5  名字只差大小写（`Chrome`）不算撞名 —— SQLite 的 UNIQUE 比较区分大小写
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
function migrate(db: DatabaseSync, before: Record<number, () => void> = {}, upTo = 29): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    before[m.version]?.()
    if (m.version === 29) vi.spyOn(Date, 'now').mockReturnValue(NOW)
    m.up(db as unknown as Db)
  }
}

const v29 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 29)!

/** 一台用户自己的 server（字段取值都与内置行不同，改没改一眼看得出） */
function userServer(id: string, name: string, over: Row = {}): Row {
  return {
    id,
    name,
    type: 'stdio',
    command: 'npx',
    args: '["-y","chrome-devtools-mcp@latest"]',
    env: '{"CHROME_PATH":"/opt/chrome"}',
    url: '',
    headers: '{}',
    metadata: '{"note":"mine"}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[{"name":"navigate_page"}]',
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

/** 内置 chrome 行应有的样子（整行只读，除了启用位） */
const builtinChromeRow = (): Row => ({
  id: 'builtin-mcp-chrome',
  name: 'chrome',
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

describe('迁移 v29：内置 chrome 的种子与撞名让位', () => {
  it('MV29-1 新库跑到 v29：builtin-mcp-chrome 的整行形状；内置 inproc 行恰是 browser / chrome / database / ssh', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    expect(byId(db, 'builtin-mcp-chrome')).toEqual(builtinChromeRow())
    expect(
      (
        db.prepare("SELECT id FROM mcp_servers WHERE type = 'inproc' ORDER BY id").all() as Row[]
      ).map((r) => r.id)
    ).toEqual([
      'builtin-mcp-browser',
      'builtin-mcp-chrome',
      'builtin-mcp-database',
      'builtin-mcp-ssh'
    ])
  })

  it('MV29-2 chrome 被用户的 server 占着：那一行改名 chrome-custom，其余字段不动、updatedAt 刷新；内置行拿到名字；别的行一字不动', () => {
    const db = new DatabaseSync(':memory:')
    const mine = userServer('u1', 'chrome')
    let others: Row[] = []
    migrate(db, {
      29: () => {
        insert(db, 'mcp_servers', mine)
        insert(db, 'mcp_servers', userServer('u2', 'playwright', { type: 'http' }))
        others = allRows(db).filter((r) => r.id !== 'u1')
      }
    })

    expect(byId(db, 'u1')).toEqual({ ...mine, name: 'chrome-custom', updatedAt: NOW })
    expect(byName(db, 'chrome')).toEqual(builtinChromeRow())
    // 迁移只碰撞名的那一行（tavily、内置 ssh / browser / database、别的用户 server 原样）
    expect(others.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        'builtin-mcp-browser',
        'builtin-mcp-database',
        'builtin-mcp-ssh',
        'builtin-mcp-tavily',
        'u2'
      ])
    )
    for (const row of others) expect(byId(db, row.id as string)).toEqual(row)
    expect(allRows(db)).toHaveLength(others.length + 2)
  })

  it.each<[string, string[], string]>([
    ['chrome-custom 也被占 → 加序号 -2', ['chrome-custom'], 'chrome-custom-2'],
    ['-2 也被占 → -3', ['chrome-custom', 'chrome-custom-2'], 'chrome-custom-3']
  ])('MV29-3 %s', (_l, taken, expected) => {
    const db = new DatabaseSync(':memory:')
    const takenRows = taken.map((name, i) => userServer(`taken-${i}`, name, { type: 'http' }))
    migrate(db, {
      29: () => {
        insert(db, 'mcp_servers', userServer('u1', 'chrome'))
        takenRows.forEach((row) => insert(db, 'mcp_servers', row))
      }
    })

    expect(byId(db, 'u1')?.name).toBe(expected)
    // 已经叫 -custom 的那几行一个字段都没动
    takenRows.forEach((row) => expect(byId(db, row.id as string)).toEqual(row))
    expect(byName(db, 'chrome')?.id).toBe('builtin-mcp-chrome')
  })

  it('MV29-4 重跑 v29 是空操作：内置行已在就不动（用户停用的仍停用），也不再改任何人的名字', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, { 29: () => insert(db, 'mcp_servers', userServer('u1', 'chrome')) })
    db.prepare("UPDATE mcp_servers SET isEnabled = 0 WHERE id = 'builtin-mcp-chrome'").run()
    // 又有人占了 chrome-custom-2 之类也不相干：内置行在，就整段跳过
    insert(db, 'mcp_servers', userServer('u3', 'chrome-custom-2'))
    const before = allRows(db)

    vi.spyOn(Date, 'now').mockReturnValue(NOW + 1000)
    v29().up(db as unknown as Db)

    expect(allRows(db)).toEqual(before)
    expect(byId(db, 'builtin-mcp-chrome')?.isEnabled).toBe(0)
    expect(byId(db, 'u1')?.name).toBe('chrome-custom')
  })

  it('MV29-5 名字只差大小写（Chrome）不算撞名：那一行原样，内置行照种', () => {
    const db = new DatabaseSync(':memory:')
    const mine = userServer('u1', 'Chrome')
    migrate(db, { 29: () => insert(db, 'mcp_servers', mine) })

    expect(byId(db, 'u1')).toEqual(mine)
    expect(byName(db, 'chrome')?.id).toBe('builtin-mcp-chrome')
    expect(byName(db, 'Chrome')?.id).toBe('u1')
  })
})
