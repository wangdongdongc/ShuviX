/**
 * 迁移 v39 —— 组件成为 MCP 服务器（`widget-<id>`），这个前缀从此是保留的。占着前缀的用户服务器改名让位，勾选里的引用
 * 跟着改；指向别的 `widget-…` 的引用（那台服务器早删了）抹掉。理由是同一个：组件的勾选算读授权，留在勾选里的
 * `mcp:widget-a-b` 会落到以后同 id 的组件头上。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV37.test；better-sqlite3 是给 Electron 编的）：按顺序跑 v1 起
 * 的每一个 up()，用户的行在 v39 之前插进去。MIG39-9 走真的 runMigrations。
 *
 *   MIG39-1  改名 custom-<名字>：其余字段不动、updatedAt 刷新；别的行与内置行一概不动
 *   MIG39-2  custom-<名字> 被占 → -2，再占 → -3；已占着那些名字的行不动
 *   MIG39-3  会话勾选：加项与取消记号都跟着改、次序与别的设置键不动；前缀相同的别的服务器不被顺手改
 *   MIG39-4  项目勾选同样
 *   MIG39-5  解析不了的设置逐字节不动、不抛，后面的行照样处理；null、enabledTools 不是数组的也不动
 *   MIG39-6  一台占着的都没有：指向 `widget-…` 的残留照样抹掉（加项与取消记号）；别的条目、非字符串条目、
 *            `widgets-a` / `my-widget-a` 这些不带保留前缀的都留着；没有这类引用的行逐字节不动
 *   MIG39-7  重跑（user_version 被拨回）：不会加第二层 custom-，设置不变
 *   MIG39-8  大小写：SQLite 的 LIKE 不分大小写，`Widget-Foo` 也改名、它的引用跟着改；没有行的 `mcp:Widget-Other` 留着
 *            （widgetIdOfServer 区分大小写，它不会落到组件头上），`mcp:widget-foo` 这个不同写法被抹掉
 *   MIG39-9  真的 runMigrations：v38 库 → 最新
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

/** 跑到 v38 的库 */
function at38(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) {
    if (m.version > 38) break
    m.up(db as unknown as Db)
  }
  return db
}

const v39 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 39)!

function runV39(db: DatabaseSync): void {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  v39().up(db as unknown as Db)
}

function insert(db: DatabaseSync, table: string, row: Row): void {
  const keys = Object.keys(row)
  db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...(Object.values(row) as Array<string | number | null>))
}

function server(db: DatabaseSync, id: string, name: string, over: Row = {}): void {
  insert(db, 'mcp_servers', {
    id,
    name,
    type: 'stdio',
    command: 'npx',
    args: '["-y","mine"]',
    env: '{"K":"V"}',
    url: '',
    headers: '{}',
    metadata: '{"note":"mine"}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[{"name":"t"}]',
    createdAt: 1,
    updatedAt: 1,
    ...over
  })
}

function session(db: DatabaseSync, id: string, settings: string): void {
  insert(db, 'sessions', {
    id,
    title: id,
    projectId: null,
    parentId: null,
    settings,
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  })
}

function project(db: DatabaseSync, id: string, settings: string): void {
  insert(db, 'projects', {
    id,
    name: id,
    path: `/p/${id}`,
    systemPrompt: '',
    settings,
    createdAt: 1,
    updatedAt: 1
  })
}

const nameOf = (db: DatabaseSync, id: string): unknown =>
  (db.prepare('SELECT name FROM mcp_servers WHERE id = ?').get(id) as Row).name

const rawSettings = (db: DatabaseSync, table: string, id: string): string =>
  (db.prepare(`SELECT settings FROM ${table} WHERE id = ?`).get(id) as { settings: string })
    .settings

const tools = (db: DatabaseSync, table: string, id: string): unknown =>
  (JSON.parse(rawSettings(db, table, id)) as { enabledTools?: unknown }).enabledTools

const allOf = (db: DatabaseSync, table: string): Row[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Row[]

describe('v39：占着保留前缀的服务器改名', () => {
  it('MIG39-1 改名 custom-<名字>：其余字段不动、updatedAt 刷新；别的行与内置行不动', () => {
    const db = at38()
    server(db, 'u1', 'widget-foo')
    server(db, 'u2', 'my-widget-a')
    server(db, 'u3', 'widgets-a')
    const before = allOf(db, 'mcp_servers')

    runV39(db)

    const after = allOf(db, 'mcp_servers')
    expect(after).toHaveLength(before.length)
    for (const row of before) {
      const now = after.find((r) => r.id === row.id)!
      if (row.id === 'u1') {
        expect(now).toEqual({ ...row, name: 'custom-widget-foo', updatedAt: NOW })
      } else {
        expect(now, String(row.id)).toEqual(row)
      }
    }
  })

  it('MIG39-2 新名字被占：-2，再占 -3；占着那些名字的行不动', () => {
    const db = at38()
    server(db, 'u1', 'widget-foo')
    server(db, 'u2', 'custom-widget-foo')
    server(db, 'u3', 'custom-widget-foo-2')

    runV39(db)

    expect(nameOf(db, 'u1')).toBe('custom-widget-foo-3')
    expect(nameOf(db, 'u2')).toBe('custom-widget-foo')
    expect(nameOf(db, 'u3')).toBe('custom-widget-foo-2')
  })

  it('MIG39-2 两台各自让位，互不相撞', () => {
    const db = at38()
    server(db, 'u1', 'widget-a-b')
    server(db, 'u2', 'widget-c-d')
    runV39(db)
    expect(nameOf(db, 'u1')).toBe('custom-widget-a-b')
    expect(nameOf(db, 'u2')).toBe('custom-widget-c-d')
  })
})

describe('v39：勾选里的引用', () => {
  it('MIG39-3 会话：加项与取消记号都跟着改；次序与别的键不动；前缀相同的别的名字不被顺手改', () => {
    const db = at38()
    server(db, 'u1', 'widget-foo')
    session(
      db,
      's1',
      JSON.stringify({
        model: 'x',
        enabledTools: ['mcp:a', 'mcp:widget-foo', 'mcp:b', '-mcp:widget-foo', 'mcp:widget-foo-bar'],
        title: 'keep me'
      })
    )

    runV39(db)

    const settings = JSON.parse(rawSettings(db, 'sessions', 's1')) as Row
    expect(settings).toEqual({
      model: 'x',
      // widget-foo-bar 没有行：是残留，抹掉 —— 不是改写成 custom-widget-foo-bar
      enabledTools: ['mcp:a', 'mcp:custom-widget-foo', 'mcp:b', '-mcp:custom-widget-foo'],
      title: 'keep me'
    })
  })

  it('MIG39-3 新名字带后缀时引用用的是真实的新名字', () => {
    const db = at38()
    server(db, 'u1', 'widget-foo')
    server(db, 'u2', 'custom-widget-foo')
    session(db, 's1', JSON.stringify({ enabledTools: ['mcp:widget-foo'] }))
    runV39(db)
    expect(tools(db, 'sessions', 's1')).toEqual(['mcp:custom-widget-foo-2'])
  })

  it('MIG39-4 项目的勾选同样', () => {
    const db = at38()
    server(db, 'u1', 'widget-foo')
    project(
      db,
      'p1',
      JSON.stringify({ enabledTools: ['mcp:widget-foo', '-mcp:widget-gone'], k: 1 })
    )
    runV39(db)
    expect(JSON.parse(rawSettings(db, 'projects', 'p1'))).toEqual({
      enabledTools: ['mcp:custom-widget-foo'],
      k: 1
    })
  })

  it('MIG39-5 解析不了的设置逐字节不动、不抛，后面的行照样处理；null 与非数组也不动', () => {
    const db = at38()
    server(db, 'u1', 'widget-foo')
    const broken = '{"enabledTools":["mcp:widget-foo"'
    const notArray = '{"enabledTools":"mcp:widget-foo"}'
    const noKey = '{"note":"mcp:widget-foo"}'
    session(db, 'a-broken', broken)
    session(db, 'b-null', 'null')
    session(db, 'c-not-array', notArray)
    session(db, 'd-no-key', noKey)
    session(db, 'e-good', JSON.stringify({ enabledTools: ['mcp:widget-foo'] }))
    project(db, 'p-broken', broken)
    project(db, 'p-good', JSON.stringify({ enabledTools: ['mcp:widget-foo'] }))

    expect(() => runV39(db)).not.toThrow()

    expect(rawSettings(db, 'sessions', 'a-broken')).toBe(broken)
    expect(rawSettings(db, 'sessions', 'b-null')).toBe('null')
    expect(rawSettings(db, 'sessions', 'c-not-array')).toBe(notArray)
    expect(rawSettings(db, 'sessions', 'd-no-key')).toBe(noKey)
    expect(tools(db, 'sessions', 'e-good')).toEqual(['mcp:custom-widget-foo'])
    expect(rawSettings(db, 'projects', 'p-broken')).toBe(broken)
    expect(tools(db, 'projects', 'p-good')).toEqual(['mcp:custom-widget-foo'])
  })

  it('MIG39-6 一台占着的都没有：残留的 widget- 引用照样抹掉；别的条目留着；没有这类引用的行逐字节不动', () => {
    const db = at38()
    const untouched = '{"enabledTools": ["mcp:browser"],  "x":1}'
    session(
      db,
      's1',
      JSON.stringify({
        enabledTools: [
          'mcp:widget-a-b',
          '-mcp:widget-a-b',
          'mcp:browser',
          'mcp:widgets-a',
          'mcp:my-widget-a',
          'read',
          7
        ]
      })
    )
    session(db, 's2', untouched)
    project(db, 'p1', JSON.stringify({ enabledTools: ['-mcp:widget-gone', 'mcp:ssh'] }))

    runV39(db)

    expect(tools(db, 'sessions', 's1')).toEqual([
      'mcp:browser',
      'mcp:widgets-a',
      'mcp:my-widget-a',
      'read',
      7
    ])
    expect(rawSettings(db, 'sessions', 's2')).toBe(untouched)
    expect(tools(db, 'projects', 'p1')).toEqual(['mcp:ssh'])
  })

  it('MIG39-7 重跑：不加第二层 custom-，服务器与设置都不变', () => {
    const db = at38()
    server(db, 'u1', 'widget-foo')
    session(db, 's1', JSON.stringify({ enabledTools: ['mcp:widget-foo', 'mcp:other'] }))
    runV39(db)
    const servers = allOf(db, 'mcp_servers')
    const sessions = allOf(db, 'sessions')

    runV39(db)

    expect(allOf(db, 'mcp_servers')).toEqual(servers)
    expect(allOf(db, 'sessions')).toEqual(sessions)
  })

  it('MIG39-8 大小写：Widget-Foo 也让位，它的引用跟着；没有行的 mcp:Widget-Other 留着；mcp:widget-foo 这个写法抹掉', () => {
    const db = at38()
    server(db, 'u1', 'Widget-Foo')
    session(
      db,
      's1',
      JSON.stringify({ enabledTools: ['mcp:Widget-Foo', 'mcp:widget-foo', 'mcp:Widget-Other'] })
    )

    runV39(db)

    expect(nameOf(db, 'u1')).toBe('custom-Widget-Foo')
    expect(tools(db, 'sessions', 's1')).toEqual(['mcp:custom-Widget-Foo', 'mcp:Widget-Other'])
  })
})

describe('v39：真的 runMigrations', () => {
  /** runMigrations 用到的 better-sqlite3 面（同 migrationV37.test） */
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

  it('MIG39-9 v38 库 → 最新：改了名、勾选跟着改', () => {
    const db = at38()
    db.exec('PRAGMA user_version = 38')
    server(db, 'u1', 'widget-foo')
    session(db, 's1', JSON.stringify({ enabledTools: ['mcp:widget-foo'] }))

    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 38)

    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(migrations.at(-1)!.version)
    expect(version.user_version).toBeGreaterThanOrEqual(39)
    expect(nameOf(db, 'u1')).toBe('custom-widget-foo')
    expect(tools(db, 'sessions', 's1')).toEqual(['mcp:custom-widget-foo'])
  })
})
