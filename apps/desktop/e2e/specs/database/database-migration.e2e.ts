/**
 * 迁移 v28：种下内置能力服务器 `database`，内置名被用户自己的 server 占着时先让位（无 LLM）。
 *
 * database 从内置工具改成了内置 MCP 能力服务器，与 v27 的 browser 同一个形状、同一条让位规则：
 * 内置行缺失、名字却被别的行占着 → 那一行改名 `database-custom`（再撞就加序号），然后种内置行。
 * 会话里既有的 `mcp:database` 勾选从此指向内置的那台；已保存的数据库连接（`db_credentials`）一个
 * 字节都不动 —— server 在进程内读它们。
 *
 * 做法同 browser-migration：「停机 → 改库 → 用同一个 HOME 再起」（`launchApp({ home })` /
 * `stop({ keepHome: true })`），库用系统 sqlite3 CLI 读写、只在停机时写；主进程日志跨启动累加，
 * 「v28 跑了几次」按日志里那一行的次数断。三次启动串成一条线：全新安装 → 撞名升级 → 什么都不改。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sqlite, sqliteJson, sqlLit, waitRendererReady } from '../../harness/seed'
import {
  DATABASE_SERVER_ID,
  DATABASE_TOOL_NAMES,
  addDbCredential,
  dbTool
} from '../../harness/databaseFixtures'

const BROWSER_ID = 'builtin-mcp-browser'
const SSH_ID = 'builtin-mcp-ssh'
const MIGRATION_LINE = 'Running migration v28'
const ALL_DB_TOOLS = DATABASE_TOOL_NAMES.map(dbTool).sort()

/** mcp_servers 的一整行（sqlite3 -json 读出来的原样） */
interface ServerRow {
  id: string
  name: string
  type: string
  command: string
  args: string
  env: string
  url: string
  headers: string
  metadata: string
  isEnabled: number
  isBuiltin: number
  cachedTools: string
  createdAt: number
  updatedAt: number
}

let app: E2EApp | undefined
let home = ''
/** 升级之前就勾了 mcp:database 的会话 */
let sessionX = ''

const rows = (): ServerRow[] => sqliteJson<ServerRow>(home, 'SELECT * FROM mcp_servers ORDER BY id')
const rowById = (id: string): ServerRow | undefined => rows().find((r) => r.id === id)
const credentialRows = (): Array<Record<string, unknown>> =>
  sqliteJson(home, 'SELECT * FROM db_credentials ORDER BY id')
const userVersion = (): string => sqlite(home, 'PRAGMA user_version').trim()
const migrationRuns = (): number => app!.mainLog().split(MIGRATION_LINE).length - 1

/** 一行用户自己的 server（字段取值刻意都不是缺省，好看出改名之后别的字段一个没动） */
const userServer = (id: string, name: string, stamp: number): ServerRow => ({
  id,
  name,
  type: 'http',
  command: '',
  args: '["--e2e"]',
  env: '{"E2E_KEY":"v"}',
  url: `http://127.0.0.1:9/${name}`,
  headers: '{"X-E2E":"1"}',
  metadata: '{"note":"e2e"}',
  isEnabled: 0,
  isBuiltin: 0,
  cachedTools: '[{"name":"query","description":"d","inputSchema":{"type":"object"}}]',
  createdAt: stamp,
  updatedAt: stamp
})

const insertSql = (r: ServerRow): string => {
  const cols = Object.keys(r) as Array<keyof ServerRow>
  const values = cols.map((c) => (typeof r[c] === 'number' ? String(r[c]) : sqlLit(String(r[c]))))
  return `INSERT INTO mcp_servers (${cols.join(', ')}) VALUES (${values.join(', ')});`
}

/** 停机（留 HOME）→ 改库 → 用同一个 HOME 再起 */
const relaunchAfter = async (sql: string): Promise<void> => {
  await app!.stop({ keepHome: true })
  app = undefined
  if (sql) sqlite(home, sql)
  app = await launchApp({ home })
  await waitRendererReady(app.main)
}

const mcpList = (): Promise<Array<{ id: string; name: string; isBuiltin: number; type: string }>> =>
  app!.main.eval(`window.api.mcp.list()`)

beforeAll(async () => {
  app = await launchApp()
  home = app.home
  await waitRendererReady(app.main)
}, 120_000)

afterAll(async () => {
  if (app) await app.stop()
  else if (home) rmSync(home, { recursive: true, force: true })
})

describe('迁移 v28', () => {
  it('DBE-M1 全新安装：内置 database 恰好一行（完整的内置行形状），库版本 28，v28 跑了恰好一次', async () => {
    const listed = await mcpList()
    expect(listed.filter((r) => r.name === 'database')).toEqual([
      expect.objectContaining({ id: DATABASE_SERVER_ID, isBuiltin: 1, type: 'inproc' })
    ])
    const row = rowById(DATABASE_SERVER_ID)!
    expect(row).toMatchObject({
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
      cachedTools: '[]'
    })
    expect(row.createdAt).toBe(row.updatedAt)
    // 内置的三台一台不少
    expect(
      rows()
        .filter((r) => r.type === 'inproc')
        .map((r) => r.id)
        .sort()
    ).toEqual([BROWSER_ID, DATABASE_SERVER_ID, SSH_ID])
    expect(userVersion()).toBe('28')
    expect(migrationRuns()).toBe(1)
  }, 120_000)

  it('DBE-M2 database 被用户的 server 占着：让位成 database-custom-2（别的字段不动），内置行种回来，旧勾选指向它，连接一个不动', async () => {
    // 撞名之前：一条会话勾了 mcp:database；设置里存着一条连接
    sessionX = await app!.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'DBE-M X' })}).then((s) => s.id)`
    )
    await app!.main.eval(
      `window.api.session.updateEnabledTools(${JSON.stringify({ id: sessionX, enabledTools: ['mcp:database'] })})`
    )
    await addDbCredential(app!.main, {
      name: 'mig-conn',
      dbType: 'postgresql',
      host: '10.9.8.7',
      port: 5433,
      username: 'mig_user',
      password: 'mig-secret',
      database: 'mig_db',
      readonly: true
    })
    const credsBefore = credentialRows()
    expect(credsBefore).toHaveLength(1)
    const sshBefore = rowById(SSH_ID)!
    const browserBefore = rowById(BROWSER_ID)!
    const holder = userServer('user-database', 'database', 1000)
    const custom = userServer('user-database-custom', 'database-custom', 1001)

    await relaunchAfter(
      [
        `DELETE FROM mcp_servers WHERE id = ${sqlLit(DATABASE_SERVER_ID)};`,
        insertSql(holder),
        insertSql(custom),
        'PRAGMA user_version = 27;'
      ].join('\n')
    )

    expect(userVersion()).toBe('28')
    expect(migrationRuns()).toBe(2)

    // 内置行回来了
    expect(rowById(DATABASE_SERVER_ID)).toMatchObject({
      name: 'database',
      type: 'inproc',
      isBuiltin: 1,
      isEnabled: 1
    })
    // 占名的那一行：`database-custom` 也被占了，于是加序号；除了名字与 updatedAt 一个字段都不动
    const renamed = rowById('user-database')!
    expect(renamed.name).toBe('database-custom-2')
    expect({ ...renamed, name: holder.name, updatedAt: holder.updatedAt }).toEqual(holder)
    expect(renamed.updatedAt).toBeGreaterThan(holder.updatedAt)
    // 旁观者原样：另一行用户 server、内置 ssh 与 browser、已保存的连接
    expect(rowById('user-database-custom')).toEqual(custom)
    expect(rowById(SSH_ID)).toEqual(sshBefore)
    expect(rowById(BROWSER_ID)).toEqual(browserBefore)
    expect(credentialRows()).toEqual(credsBefore)

    // 旧勾选原样留着，指向的是内置那台：运行时拿到的是内置的两个工具
    const stored = await app!.main.eval(
      `window.api.session.getById(${JSON.stringify(sessionX)}).then((s) => s.settings.enabledTools)`
    )
    expect(stored).toEqual(['mcp:database'])
    const info = await app!.main.eval<{ tools: Array<{ name: string }> }>(
      `window.api.agent.getInfo(${JSON.stringify(sessionX)}, { ensure: true })`
    )
    expect(
      info.tools
        .map((t) => t.name)
        .filter((n) => n.startsWith('mcp__database'))
        .sort()
    ).toEqual(ALL_DB_TOOLS)
    // 改了名的那台还在，想用可以重新勾
    const names = (
      await app!.main.eval<Array<{ name: string }>>(
        `window.api.tools.list(${JSON.stringify(sessionX)})`
      )
    ).map((t) => t.name)
    expect(names).toContain('mcp:database')
    expect(names).toContain('mcp:database-custom-2')
  }, 120_000)

  it('DBE-M3 幂等：再起一次什么都不改，v28 不再跑', async () => {
    const before = rows()
    const credsBefore = credentialRows()
    await relaunchAfter('')
    expect(userVersion()).toBe('28')
    expect(migrationRuns()).toBe(2)
    // cachedTools 会在第一次连上时写回（M2 末尾那次）—— 它是连接的产物，不是迁移的；
    // 这里比的是两次启动之间：什么都没连，一行都不该变
    expect(rows()).toEqual(before)
    expect(credentialRows()).toEqual(credsBefore)
    expect(rows().filter((r) => r.name === 'database')).toEqual([
      expect.objectContaining({ id: DATABASE_SERVER_ID })
    ])
  }, 120_000)
})
