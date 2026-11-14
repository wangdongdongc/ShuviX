/**
 * 迁移 v42 —— 任务列表从实验的内置 MCP `plan` 转正为内置工具 `update_plan`：删掉 v37 种的内置 server 行
 * `builtin-mcp-plan`，会话与项目勾选（`settings.enabledTools`）里的 `mcp:plan` / `-mcp:plan` 一并抹掉。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV39.test）：按顺序跑到 v41，再跑 v42。M-13 / M-14
 * 走真的 runMigrations（better-sqlite3 的 pragma / transaction 由一层薄壳给出，同 migrationV37.test）。
 *
 *   M-1   内置 plan 行删掉；browser / chrome / database / ssh 四行原样
 *   M-2   v37 让位改名的用户行 plan-custom / plan-custom-2 原样
 *   M-3   停用了的内置 plan 行也删
 *   M-4   [WB] id 是 builtin-mcp-plan 却 isBuiltin = 0 的行留着（只删内置行本身）
 *   M-5   会话勾选：两种记号（含重复）都抹掉、其余次序不变；别的设置键深相等
 *   M-6   项目勾选同样
 *   M-7   原样留着：mcp:plan-custom、-mcp:plan-custom、mcp:Plan、mcp:planner、plan、非字符串条目；什么都没抹掉的行逐字节不动
 *         （连奇怪的空白一起）
 *   M-8   mcp:plan 只出现在 enabledTools 之外 → 逐字节不动
 *   M-9   解析不了的设置不碰、不抛，后面的行照样处理
 *   M-10  settings 是 null / 数组、enabledTools 不是数组 → 不碰；settings 列本身 NOT NULL，NULL 列这种行造不出来
 *   M-11  全抹掉 → 存 enabledTools: []（键留着）
 *   M-12  [WB] 大写 MCP:PLAN 会被 LIKE 选中（SQLite 的 LIKE 不分大小写），但不是那两个记号，逐字节不动
 *   M-13  重跑（user_version 拨回 41）：不再改任何东西
 *   M-14  真的 runMigrations：v41 库 → 最新，两样效果都在
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

/** 跑到 v41 的库（v37 种的内置 plan 行在里面） */
function at41(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) {
    if (m.version > 41) break
    m.up(db as unknown as Db)
  }
  return db
}

const v42 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 42)!

function runV42(db: DatabaseSync): void {
  v42().up(db as unknown as Db)
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

const byId = (db: DatabaseSync, id: string): Row | undefined =>
  db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined

const rawSettings = (db: DatabaseSync, table: string, id: string): string =>
  (db.prepare(`SELECT settings FROM ${table} WHERE id = ?`).get(id) as { settings: string })
    .settings

const parsed = (db: DatabaseSync, table: string, id: string): Record<string, unknown> =>
  JSON.parse(rawSettings(db, table, id)) as Record<string, unknown>

const allOf = (db: DatabaseSync, table: string): Row[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Row[]

/**
 * runMigrations 用到的 better-sqlite3 面：prepare / exec / pragma / transaction（同 migrationV37.test 的薄壳）
 */
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

const OTHER_BUILTINS = [
  'builtin-mcp-browser',
  'builtin-mcp-chrome',
  'builtin-mcp-database',
  'builtin-mcp-ssh'
]

describe('v42：内置 plan 行', () => {
  it('M-1 the builtin plan row is deleted; the browser / chrome / database / ssh rows stay as they were', () => {
    const db = at41()
    expect(byId(db, 'builtin-mcp-plan')).toMatchObject({ name: 'plan', isBuiltin: 1 })
    const others = OTHER_BUILTINS.map((id) => byId(db, id))
    for (const [i, row] of others.entries()) expect(row, OTHER_BUILTINS[i]).toBeDefined()

    runV42(db)

    expect(byId(db, 'builtin-mcp-plan')).toBeUndefined()
    expect(OTHER_BUILTINS.map((id) => byId(db, id))).toEqual(others)
    expect(db.prepare("SELECT 1 FROM mcp_servers WHERE name = 'plan'").get()).toBeUndefined()
  })

  it('M-2 the user rows v37 renamed out of the way (plan-custom, plan-custom-2) stay as they were', () => {
    const db = at41()
    server(db, 'u1', 'plan-custom')
    server(db, 'u2', 'plan-custom-2', { isEnabled: 0, env: '{}' })
    const before = [byId(db, 'u1'), byId(db, 'u2')]

    runV42(db)

    expect([byId(db, 'u1'), byId(db, 'u2')]).toEqual(before)
    expect(byId(db, 'builtin-mcp-plan')).toBeUndefined()
  })

  it('M-3 a disabled builtin plan row is deleted too', () => {
    const db = at41()
    db.prepare('UPDATE mcp_servers SET isEnabled = 0 WHERE id = ?').run('builtin-mcp-plan')
    expect(byId(db, 'builtin-mcp-plan')).toMatchObject({ isEnabled: 0 })

    runV42(db)

    expect(byId(db, 'builtin-mcp-plan')).toBeUndefined()
  })

  it('M-4 [WB] a row with id builtin-mcp-plan but isBuiltin = 0 is kept: only the builtin row itself goes', () => {
    const db = at41()
    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run('builtin-mcp-plan')
    server(db, 'builtin-mcp-plan', 'plan')
    const before = byId(db, 'builtin-mcp-plan')
    expect(before).toMatchObject({ isBuiltin: 0 })

    runV42(db)

    expect(byId(db, 'builtin-mcp-plan')).toEqual(before)
  })
})

describe('v42：勾选里的 mcp:plan / -mcp:plan', () => {
  const STALE = ['mcp:browser', 'mcp:plan', '-mcp:ssh', '-mcp:plan', 'mcp:plan']
  const OTHER_KEYS = {
    knowledgeBases: ['notes'],
    model: { provider: 'faux', modelId: 'faux-1' },
    bot: 'daily',
    nested: { enabledTools: ['mcp:plan'] }
  }

  it('M-5 sessions: both markers (duplicates included) go, the rest keeps its order; the other keys are deep-equal', () => {
    const db = at41()
    session(db, 's1', JSON.stringify({ ...OTHER_KEYS, enabledTools: STALE }))

    runV42(db)

    const after = parsed(db, 'sessions', 's1')
    expect(after.enabledTools).toEqual(['mcp:browser', '-mcp:ssh'])
    const { enabledTools: _tools, ...rest } = after
    expect(rest).toEqual(OTHER_KEYS)
  })

  it('M-6 projects the same', () => {
    const db = at41()
    project(db, 'p1', JSON.stringify({ ...OTHER_KEYS, enabledTools: STALE }))

    runV42(db)

    const after = parsed(db, 'projects', 'p1')
    expect(after.enabledTools).toEqual(['mcp:browser', '-mcp:ssh'])
    const { enabledTools: _tools, ...rest } = after
    expect(rest).toEqual(OTHER_KEYS)
  })

  it('M-7 kept as is: lookalikes, other casing, the bare name and non-string entries; a row where nothing was removed stays byte-identical', () => {
    const db = at41()
    const kept = [
      'mcp:plan-custom',
      '-mcp:plan-custom',
      'mcp:Plan',
      'mcp:planner',
      'plan',
      7,
      null,
      { name: 'mcp:plan' },
      ['mcp:plan']
    ]
    session(db, 's-mixed', JSON.stringify({ enabledTools: [...kept, 'mcp:plan'] }))
    // 什么都不抹的行：LIKE 选得中（mcp:plan-custom 含 mcp:plan），奇怪的空白也逐字节留着
    const untouched = '{ "enabledTools" :[ "mcp:plan-custom",\n  "mcp:planner" ],"x":1 }'
    session(db, 's-same', untouched)
    project(db, 'p-same', untouched)

    runV42(db)

    expect(parsed(db, 'sessions', 's-mixed').enabledTools).toEqual(kept)
    expect(rawSettings(db, 'sessions', 's-same')).toBe(untouched)
    expect(rawSettings(db, 'projects', 'p-same')).toBe(untouched)
  })

  it('M-8 mcp:plan only outside enabledTools → byte-identical', () => {
    const db = at41()
    const raw = '{"note":"mcp:plan","other":["mcp:plan"],"enabledTools":["mcp:ssh"]}'
    const noKey = '{"note":"-mcp:plan"}'
    session(db, 's1', raw)
    session(db, 's2', noKey)
    project(db, 'p1', raw)

    runV42(db)

    expect(rawSettings(db, 'sessions', 's1')).toBe(raw)
    expect(rawSettings(db, 'sessions', 's2')).toBe(noKey)
    expect(rawSettings(db, 'projects', 'p1')).toBe(raw)
  })

  it('M-9 unparseable settings are left alone, nothing throws, later rows are still processed', () => {
    const db = at41()
    const broken = '{"enabledTools":["mcp:plan"'
    session(db, 'a-broken', broken)
    session(db, 'b-ok', JSON.stringify({ enabledTools: ['mcp:plan', 'mcp:ssh'] }))
    project(db, 'a-broken', broken)
    project(db, 'b-ok', JSON.stringify({ enabledTools: ['-mcp:plan'] }))

    expect(() => runV42(db)).not.toThrow()

    expect(rawSettings(db, 'sessions', 'a-broken')).toBe(broken)
    expect(parsed(db, 'sessions', 'b-ok').enabledTools).toEqual(['mcp:ssh'])
    expect(rawSettings(db, 'projects', 'a-broken')).toBe(broken)
    expect(parsed(db, 'projects', 'b-ok').enabledTools).toEqual([])
  })

  it('M-10 null settings, array settings, a non-array enabledTools are untouched; a NULL settings column cannot exist', () => {
    const db = at41()
    const odd = [
      'null',
      '["mcp:plan"]',
      '{"enabledTools":"mcp:plan"}',
      '{"enabledTools":{"0":"mcp:plan"}}',
      '{"enabledTools":null,"x":"mcp:plan"}'
    ]
    odd.forEach((raw, i) => {
      session(db, `s${i}`, raw)
      project(db, `p${i}`, raw)
    })

    expect(() => runV42(db)).not.toThrow()

    odd.forEach((raw, i) => {
      expect(rawSettings(db, 'sessions', `s${i}`), raw).toBe(raw)
      expect(rawSettings(db, 'projects', `p${i}`), raw).toBe(raw)
    })
    // settings 列 NOT NULL：没有 NULL 列的行可迁
    expect(() => session(db, 's-null', null as unknown as string)).toThrow()
    expect(() => project(db, 'p-null', null as unknown as string)).toThrow()
  })

  it('M-11 removing every entry stores enabledTools: [] (the key stays)', () => {
    const db = at41()
    session(db, 's1', JSON.stringify({ enabledTools: ['mcp:plan', '-mcp:plan'], title: 't' }))
    project(db, 'p1', JSON.stringify({ enabledTools: ['mcp:plan'] }))

    runV42(db)

    expect(parsed(db, 'sessions', 's1')).toEqual({ enabledTools: [], title: 't' })
    expect(parsed(db, 'projects', 'p1')).toEqual({ enabledTools: [] })
    expect(rawSettings(db, 'projects', 'p1')).toBe('{"enabledTools":[]}')
  })

  it('M-12 [WB] upper-case MCP:PLAN / -MCP:PLAN are selected by LIKE but are not the markers: byte-identical', () => {
    const db = at41()
    const raw = '{"enabledTools":["MCP:PLAN","-MCP:PLAN"]}'
    session(db, 's1', raw)
    project(db, 'p1', raw)
    // LIKE 真的选中了它（不分大小写）—— 这一行确实被读过、只是没改
    expect(db.prepare("SELECT id FROM sessions WHERE settings LIKE '%mcp:plan%'").all()).toEqual([
      { id: 's1' }
    ])

    runV42(db)

    expect(rawSettings(db, 'sessions', 's1')).toBe(raw)
    expect(rawSettings(db, 'projects', 'p1')).toBe(raw)
  })
})

describe('v42：重跑与真的 runMigrations', () => {
  it('M-13 a re-run (user_version wound back to 41) changes nothing', () => {
    const db = at41()
    db.exec('PRAGMA user_version = 41')
    server(db, 'u1', 'plan-custom')
    session(db, 's1', JSON.stringify({ enabledTools: ['mcp:plan', 'mcp:ssh'] }))
    project(db, 'p1', JSON.stringify({ enabledTools: ['-mcp:plan'] }))
    runV42(db)
    db.exec('PRAGMA user_version = 42')
    const servers = allOf(db, 'mcp_servers')
    const sessions = allOf(db, 'sessions')
    const projects = allOf(db, 'projects')

    db.exec('PRAGMA user_version = 41')
    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 41)

    expect(allOf(db, 'mcp_servers')).toEqual(servers)
    expect(allOf(db, 'sessions')).toEqual(sessions)
    expect(allOf(db, 'projects')).toEqual(projects)
  })

  it('M-14 the real runMigrations takes a v41 database to the latest version with both effects', () => {
    const db = at41()
    db.exec('PRAGMA user_version = 41')
    server(db, 'u1', 'plan-custom')
    session(db, 's1', JSON.stringify({ enabledTools: ['mcp:browser', 'mcp:plan'] }))
    project(db, 'p1', JSON.stringify({ enabledTools: ['-mcp:plan', 'mcp:ssh'] }))

    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 41)

    expect(userVersion(db)).toBe(migrations.at(-1)!.version)
    expect(userVersion(db)).toBeGreaterThanOrEqual(42)
    expect(byId(db, 'builtin-mcp-plan')).toBeUndefined()
    expect(byId(db, 'u1')).toMatchObject({ name: 'plan-custom' })
    expect(parsed(db, 'sessions', 's1').enabledTools).toEqual(['mcp:browser'])
    expect(parsed(db, 'projects', 'p1').enabledTools).toEqual(['mcp:ssh'])
  })
})
