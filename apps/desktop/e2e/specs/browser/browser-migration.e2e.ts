/**
 * 迁移 v27：种下内置能力服务器 `browser`，内置名被用户自己的 server 占着时先让位（无 LLM）。
 *
 * `mcp_servers.name` 是 UNIQUE，而 v22 种 ssh 时用的是 `INSERT OR IGNORE`：自己装过一台叫 `ssh`
 * 的 server 的用户，内置 ssh 从来没种上，也没有任何提示。v27 把两台一起处理 —— 内置行缺失、
 * 名字却被别的行占着 → 那一行改名 `<name>-custom`（再撞就加序号），然后种内置行。会话里既有的
 * `mcp:<name>` 勾选从此指向内置的那台（「这条会话要一个浏览器」，意图不变）。
 *
 * 做法是「停机 → 改库 → 用同一个 HOME 再起」（launch.ts 的 `launchApp({ home })` /
 * `stop({ keepHome: true })`）：从零造一份 v26 的库不现实，而把 v27 的产物删掉、塞进撞名的用户行、
 * 把 user_version 拨回 26，下一次启动跑的就是真的 v27。库用系统 sqlite3 CLI 读写（seed.ts 的
 * `sqlite` / `sqliteJson`），只在停机时写。主进程日志留在同一个 HOME 里、跨启动累加，所以
 * 「v27 跑了几次」按日志里那一行的次数断。
 *
 * 四次启动串成一条线（用例之间有顺序依赖）：全新安装 → browser 撞名 → ssh 撞名 → 什么都不改。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sqlite, sqliteJson, sqlLit, waitRendererReady } from '../../harness/seed'
import { BROWSER_TOOL_NAMES, browserTool } from '../../harness/browserFixtures'

const BROWSER_ID = 'builtin-mcp-browser'
const SSH_ID = 'builtin-mcp-ssh'
const MIGRATION_LINE = 'Running migration v27'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()

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
/** 撞名前那条勾了 mcp:browser 的会话 */
let sessionX = ''

const rows = (): ServerRow[] => sqliteJson<ServerRow>(home, 'SELECT * FROM mcp_servers ORDER BY id')
const rowById = (id: string): ServerRow | undefined => rows().find((r) => r.id === id)
const rowByName = (name: string): ServerRow | undefined => rows().find((r) => r.name === name)
/**
 * 库版本。v27 之后还有迁移（v28 种 database，拨回 26 再起时它也跑一遍、是个空操作）——
 * 这里只断「至少到了 27」，v27 本身跑没跑、跑了几次按日志里那一行的次数断，下一条迁移不必再来改这里
 */
const userVersion = (): number => Number(sqlite(home, 'PRAGMA user_version').trim())
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
  cachedTools: '[{"name":"remote_tool","description":"d","inputSchema":{"type":"object"}}]',
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

describe('迁移 v27', () => {
  it('BRM-1 全新安装：内置 browser 与 ssh 各一行，库版本至少 27，v27 跑了恰好一次', async () => {
    const listed = await mcpList()
    expect(listed.filter((r) => r.name === 'browser')).toEqual([
      expect.objectContaining({ id: BROWSER_ID, isBuiltin: 1, type: 'inproc' })
    ])
    expect(listed.filter((r) => r.name === 'ssh')).toEqual([
      expect.objectContaining({ id: SSH_ID, isBuiltin: 1, type: 'inproc' })
    ])
    expect(userVersion()).toBeGreaterThanOrEqual(27)
    expect(migrationRuns()).toBe(1)
  }, 120_000)

  it('BRM-2 browser 被用户的 server 占着：让位成 browser-custom-2（别的字段不动），内置行种回来，旧勾选指向它', async () => {
    // 撞名之前：一条会话勾了 mcp:browser（此刻指向内置那台；升级之后意图不变）
    sessionX = await app!.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'BRM X' })}).then((s) => s.id)`
    )
    await app!.main.eval(
      `window.api.session.updateEnabledTools(${JSON.stringify({ id: sessionX, enabledTools: ['mcp:browser'] })})`
    )
    const sshBefore = rowById(SSH_ID)!
    const holder = userServer('user-browser', 'browser', 1000)
    const custom = userServer('user-browser-custom', 'browser-custom', 1001)

    await relaunchAfter(
      [
        `DELETE FROM mcp_servers WHERE id = ${sqlLit(BROWSER_ID)};`,
        insertSql(holder),
        insertSql(custom),
        'PRAGMA user_version = 26;'
      ].join('\n')
    )

    expect(userVersion()).toBeGreaterThanOrEqual(27)
    expect(migrationRuns()).toBe(2)

    // 内置行回来了
    expect(rowById(BROWSER_ID)).toMatchObject({
      name: 'browser',
      type: 'inproc',
      isBuiltin: 1,
      isEnabled: 1
    })
    // 占名的那一行：`browser-custom` 也被占了，于是加序号；除了名字与 updatedAt 一个字段都不动
    const renamed = rowById('user-browser')!
    expect(renamed.name).toBe('browser-custom-2')
    expect({ ...renamed, name: holder.name, updatedAt: holder.updatedAt }).toEqual(holder)
    expect(renamed.updatedAt).toBeGreaterThan(holder.updatedAt)
    // 旁观者原样
    expect(rowById('user-browser-custom')).toEqual(custom)
    expect(rowById(SSH_ID)).toEqual(sshBefore)

    // 旧勾选原样留着，指向的是内置那台：运行时拿到的是内置的 22 个工具
    const stored = await app!.main.eval(
      `window.api.session.getById(${JSON.stringify(sessionX)}).then((s) => s.settings.enabledTools)`
    )
    expect(stored).toEqual(['mcp:browser'])
    const info = await app!.main.eval<{ tools: Array<{ name: string }> }>(
      `window.api.agent.getInfo(${JSON.stringify(sessionX)}, { ensure: true })`
    )
    expect(
      info.tools
        .map((t) => t.name)
        .filter((n) => n.startsWith('mcp__browser__'))
        .sort()
    ).toEqual(ALL_BROWSER_TOOLS)
    // 改了名的那台还在，想用可以重新勾
    const names = (
      await app!.main.eval<Array<{ name: string }>>(
        `window.api.tools.list(${JSON.stringify(sessionX)})`
      )
    ).map((t) => t.name)
    expect(names).toContain('mcp:browser')
    expect(names).toContain('mcp:browser-custom-2')
  }, 120_000)

  it('BRM-3 ssh 被用户的 server 占着：让位成 ssh-custom，内置 ssh 种回来；browser 这边一行不动', async () => {
    const browserSide = rows().filter((r) => r.name.startsWith('browser'))
    const holder = userServer('user-ssh', 'ssh', 2000)

    await relaunchAfter(
      [
        `DELETE FROM mcp_servers WHERE id = ${sqlLit(SSH_ID)};`,
        insertSql(holder),
        'PRAGMA user_version = 26;'
      ].join('\n')
    )

    expect(userVersion()).toBeGreaterThanOrEqual(27)
    expect(migrationRuns()).toBe(3)
    expect(rowById(SSH_ID)).toMatchObject({
      name: 'ssh',
      type: 'inproc',
      isBuiltin: 1,
      isEnabled: 1
    })
    const renamed = rowById('user-ssh')!
    expect(renamed.name).toBe('ssh-custom')
    expect({ ...renamed, name: holder.name, updatedAt: holder.updatedAt }).toEqual(holder)
    expect(renamed.updatedAt).toBeGreaterThan(holder.updatedAt)
    expect(rows().filter((r) => r.name.startsWith('browser'))).toEqual(browserSide)
  }, 120_000)

  it('BRM-4 幂等：再起一次什么都不改，v27 不再跑', async () => {
    const before = rows()
    await relaunchAfter('')
    expect(userVersion()).toBeGreaterThanOrEqual(27)
    expect(migrationRuns()).toBe(3)
    expect(rows()).toEqual(before)
    expect(rowByName('browser')?.id).toBe(BROWSER_ID)
    expect(rowByName('ssh')?.id).toBe(SSH_ID)
  }, 120_000)
})
