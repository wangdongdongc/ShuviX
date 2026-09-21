/**
 * 迁移 v27 —— 种内置能力服务器 `browser`；内置名被用户自己的 server 占着时，那一行让位改名
 * （`ssh` 一并处理：v22 用的是 INSERT OR IGNORE，撞名的用户从来没种上内置 ssh）。
 *
 * 在**真的 SQLite** 上跑：node:sqlite 的内存库（better-sqlite3 是为 Electron 编译的原生模块，
 * vitest 的 Node 进程加载不了）。按顺序跑 v1 起的每一个 up()，用户自己的行在它本该出现的那一版
 * 之前插进去 —— 于是 v22 的 OR IGNORE、UNIQUE 约束、v24 对 Tavily 的降级都是真的在起作用。
 *
 *   MV-1  新库：ssh / browser 两行内置 inproc 行，字段逐一核对；
 *   MV-2  browser 被占：那一行改名 browser-custom，其余字段不动、updatedAt 刷新；内置行拿到名字；
 *   MV-3  browser-custom 也被占 → -custom-2，再占 → -custom-3；
 *   MV-4  ssh 被占（v22 因此没种上）→ 用户那行改名 ssh-custom，内置 ssh 补种；
 *   MV-5  重跑 v27 什么都不改（停用了的内置行仍是停用）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const NOW = 1_800_000_000_000

afterEach(() => {
  vi.restoreAllMocks()
})

/** 按顺序跑迁移；`before[v]` 在跑第 v 版之前调（用户的行在那一刻已经在库里了） */
function migrate(db: DatabaseSync, before: Record<number, () => void> = {}, upTo = Infinity): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    before[m.version]?.()
    if (m.version === 27) vi.spyOn(Date, 'now').mockReturnValue(NOW)
    m.up(db as unknown as Db)
  }
}

/** 一台用户自己的 server（字段取值都与内置行不同，改没改一眼看得出） */
function userServer(id: string, name: string, over: Row = {}): Row {
  return {
    id,
    name,
    type: 'stdio',
    command: 'npx',
    args: '["-y","@playwright/mcp"]',
    env: '{"TOKEN":"t"}',
    url: '',
    headers: '{}',
    metadata: '{"note":"mine"}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[{"name":"browser_click"}]',
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function insert(db: DatabaseSync, row: Row): void {
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO mcp_servers (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...(Object.values(row) as Array<string | number>))
}

const byId = (db: DatabaseSync, id: string): Row | undefined =>
  db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined

const byName = (db: DatabaseSync, name: string): Row | undefined =>
  db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as Row | undefined

const allRows = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM mcp_servers ORDER BY id').all() as Row[]

/** 内置 inproc 行应有的样子（整行只读，除了启用位） */
const builtinRow = (id: string, name: string, at: unknown = expect.any(Number)): Row => ({
  id,
  name,
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
  createdAt: at,
  updatedAt: at
})

describe('迁移 v27：内置 browser 的种子与撞名让位', () => {
  it('MV-1 新库：恰好两行内置 inproc —— builtin-mcp-ssh 叫 ssh、builtin-mcp-browser 叫 browser', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db)

    expect(byId(db, 'builtin-mcp-ssh')).toEqual(builtinRow('builtin-mcp-ssh', 'ssh'))
    expect(byId(db, 'builtin-mcp-browser')).toEqual(
      builtinRow('builtin-mcp-browser', 'browser', NOW)
    )
    expect(
      (
        db.prepare("SELECT id FROM mcp_servers WHERE type = 'inproc' ORDER BY id").all() as Row[]
      ).map((r) => r.id)
    ).toEqual(['builtin-mcp-browser', 'builtin-mcp-ssh'])
  })

  it('MV-2 browser 被用户的 server 占着：那一行改名 browser-custom，其余字段一个不动、updatedAt 刷新；内置行拿到名字；无关的行不受影响', () => {
    const db = new DatabaseSync(':memory:')
    const mine = userServer('u1', 'browser')
    let tavilyBefore: Row | undefined
    migrate(db, {
      27: () => {
        insert(db, mine)
        tavilyBefore = byId(db, 'builtin-mcp-tavily')
      }
    })

    expect(byId(db, 'u1')).toEqual({ ...mine, name: 'browser-custom', updatedAt: NOW })
    expect(byName(db, 'browser')).toEqual(builtinRow('builtin-mcp-browser', 'browser', NOW))
    // 迁移只碰撞名的那一行
    expect(tavilyBefore).toBeDefined()
    expect(byId(db, 'builtin-mcp-tavily')).toEqual(tavilyBefore)
  })

  it.each<[string, string[], string]>([
    ['browser-custom 也被占 → 加序号 -2', ['browser-custom'], 'browser-custom-2'],
    ['-2 也被占 → -3', ['browser-custom', 'browser-custom-2'], 'browser-custom-3']
  ])('MV-3 %s', (_l, taken, expected) => {
    const db = new DatabaseSync(':memory:')
    migrate(db, {
      27: () => {
        insert(db, userServer('u1', 'browser'))
        taken.forEach((name, i) => insert(db, userServer(`taken-${i}`, name, { type: 'http' })))
      }
    })

    expect(byId(db, 'u1')?.name).toBe(expected)
    // 已经叫 -custom 的那几行原样
    taken.forEach((name, i) => expect(byId(db, `taken-${i}`)?.name).toBe(name))
    expect(byName(db, 'browser')?.id).toBe('builtin-mcp-browser')
  })

  it('MV-4 ssh 在 v22 之前就被占（于是 v22 没种上）→ v27 把用户那行改名 ssh-custom，补种内置 ssh', () => {
    const db = new DatabaseSync(':memory:')
    const mine = userServer('u-ssh', 'ssh', { command: 'my-ssh-mcp' })
    migrate(db, { 22: () => insert(db, mine) }, 26)

    // v22 的 INSERT OR IGNORE 撞上 UNIQUE(name)，静默没种
    expect(byId(db, 'builtin-mcp-ssh')).toBeUndefined()
    expect(byName(db, 'ssh')?.id).toBe('u-ssh')

    migrations.find((m) => m.version === 27)!.up(db as unknown as Db)
    expect(byId(db, 'u-ssh')).toMatchObject({ name: 'ssh-custom', command: 'my-ssh-mcp' })
    expect(byName(db, 'ssh')).toMatchObject({
      id: 'builtin-mcp-ssh',
      type: 'inproc',
      isBuiltin: 1,
      isEnabled: 1
    })
  })

  it('MV-5 重跑 v27 是空操作：内置行已在就不动（用户停用的仍停用），也不再改任何人的名字', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, { 27: () => insert(db, userServer('u1', 'browser')) })
    db.prepare("UPDATE mcp_servers SET isEnabled = 0 WHERE id = 'builtin-mcp-browser'").run()
    const before = allRows(db)

    vi.spyOn(Date, 'now').mockReturnValue(NOW + 1000)
    migrations.find((m) => m.version === 27)!.up(db as unknown as Db)

    expect(allRows(db)).toEqual(before)
    expect(byId(db, 'builtin-mcp-browser')?.isEnabled).toBe(0)
    expect(byId(db, 'u1')?.name).toBe('browser-custom')
  })
})
