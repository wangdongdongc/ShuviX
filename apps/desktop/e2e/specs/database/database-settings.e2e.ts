/**
 * 内置能力服务器 `database` 在设置里的样子（无 LLM）。
 *
 * 数据库从「LLM 工具」里的一个内置工具，改成了按会话勾选的内置 MCP 能力服务器（`type: 'inproc'`，
 * v28 种下的 `builtin-mcp-database` 行，全局启用、会话默认不勾）。凭据仍由 ShuviX 保存
 * （`db_credentials`），管理它们的地方跟着能力搬到了 MCP 页那一行的展开区；「LLM 工具」页上不再有它。
 * 本 spec 钉这几件事：
 *
 *   - 种子行的形状与「整行只读」（删不掉、改不了名字 / 类型 / 命令 / 地址、名字不能被占）；
 *   - 列表里内置置顶、database 行的徽章与按钮（没有编辑、没有重连、删除灰着）；
 *   - 展开区：「已保存的连接」一节（标题、安全警告、空态），存了连接之后每行的名字、库类型、
 *     只读徽章与 `user@host:port/db`，密码哪儿都不出现；别的行展开没有这一节；
 *   - 添加 / 编辑弹窗：只读缺省开着、测试连接真的连到了服务器（按 bridge 那一侧的连接数断）、
 *     连不上时说连不上、重名报重名、编辑改得动、删除要确认；
 *   - 第一次用到才连（会话级实例），连上之后工具数与工具名、会话删掉之后回到「未启动」。
 *
 * 断言优先走 IPC（`window.api.mcp.*` / `dbCredential.*` / `tools.*`）；DOM 只断「呈现」，一律经
 * pages.ts 的 mcpSettingsPane / dbConnectionsPane。文案随界面语言变 —— 按三语候选认（取自语言包）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { waitRendererReady } from '../../harness/seed'
import {
  dbConnectionsPane,
  mcpSettingsPane,
  settingsNavPane,
  type DbConnectionsPane,
  type McpSettingsPane
} from '../../harness/pages'
import {
  DATABASE_SERVER_ID,
  DATABASE_TOOL_NAMES,
  DB_LABELS,
  addDbCredential,
  dbTool,
  listDbCredentials,
  startPgBridge,
  type PgBridge
} from '../../harness/databaseFixtures'

const L = [en, zh, ja]
const DB_TITLES = L.map((l) => l.settings.toolDbTitle)
const WARNINGS = L.map((l) => l.settings.toolDbSecurityWarning)
const EMPTY = L.map((l) => [l.settings.toolDbEmpty, l.settings.toolDbEmptyHint])
const READONLY_BADGES = L.map((l) => l.settings.toolDbReadonlyBadge)
const ADD_TITLES = L.map((l) => l.settings.toolDbAddTitle)
const EDIT_TITLES = L.map((l) => l.settings.toolDbEditTitle)
const TEST_OK = L.map((l) => l.settings.toolDbTestSuccess)
const TEST_FAILED = L.map((l) => l.settings.toolDbTestFailed)
const DUPLICATE = L.map((l) => l.settings.toolDbDuplicateName)
const CANNOT_DELETE = L.map((l) => l.settings.mcpBuiltinCannotDelete)
const TOOLS_TAB = L.map((l) => l.settings.tabTools)
const ALL_DB_TOOLS = DATABASE_TOOL_NAMES.map(dbTool).sort()

/** S4 种的两条连接 —— 密码是特征串：「页面上哪儿都没有它」按它断 */
const S4_PG = {
  name: 's4-pg',
  dbType: 'postgresql' as const,
  host: 'db.internal.example',
  port: 5433,
  username: 's4_user',
  password: 'S4-PG-PASSWORD-zq81',
  database: 's4_db',
  readonly: true
}
const S4_MY = {
  name: 's4-my',
  dbType: 'mysql' as const,
  host: '10.1.2.3',
  port: 3306,
  username: 'root',
  password: 'S4-MY-PASSWORD-yk27',
  database: 'shop',
  readonly: false
}

interface McpRow {
  id: string
  name: string
  type: string
  command: string
  args: string
  url: string
  isEnabled: number
  isBuiltin: number
  status: string
  toolCount: number
}

let app: E2EApp
let settings: CdpClient
let mcp: McpSettingsPane
let dbs: DbConnectionsPane
let bridge: PgBridge

// ─── IPC 助手 ───

const mcpList = (): Promise<McpRow[]> => app.main.eval<McpRow[]>(`window.api.mcp.list()`)
const rowOf = async (id: string): Promise<McpRow> => {
  const row = (await mcpList()).find((r) => r.id === id)
  if (!row) throw new Error(`mcp row ${id} not found`)
  return row
}
const mcpAdd = (params: Record<string, unknown>): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.mcp.add(${JSON.stringify(params)})`)
const mcpUpdate = (
  params: Record<string, unknown>
): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.mcp.update(${JSON.stringify(params)})`)
const mcpDelete = (id: string): Promise<{ success: boolean; error?: string }> =>
  app.main.eval(`window.api.mcp.delete(${JSON.stringify(id)})`)
const mcpTools = (id: string): Promise<Array<{ name: string }>> =>
  app.main.eval(`window.api.mcp.getTools(${JSON.stringify(id)})`)

/** 重新挂载展开区：连接列表只在挂载时读一次，经 IPC 改过之后要收起再展开才看得见 */
const reopenDatabaseRow = async (): Promise<void> => {
  await mcp.setExpanded('database', false)
  await mcp.setExpanded('database', true)
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  bridge = await startPgBridge()
  settings = await app.openSettings('mcp')
  mcp = mcpSettingsPane(settings)
  dbs = dbConnectionsPane(settings)
  await mcp.waitRow('database')
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await bridge?.close()
})

describe('种子行（IPC）', () => {
  it('DBE-S1 database 恰好一行：内置、inproc、全局启用、没连过、没有工具；内置的恰好 browser / database / ssh', async () => {
    const rows = await mcpList()
    const dbRows = rows.filter((r) => r.name === 'database')
    expect(dbRows).toHaveLength(1)
    expect(dbRows[0]).toMatchObject({
      id: DATABASE_SERVER_ID,
      type: 'inproc',
      isBuiltin: 1,
      isEnabled: 1,
      status: 'disconnected',
      toolCount: 0,
      command: '',
      url: ''
    })
    expect(
      rows
        .filter((r) => r.isBuiltin === 1)
        .map((r) => r.name)
        .sort()
    ).toEqual(['browser', 'database', 'ssh'])
    // 没连过就没有工具（工具数与工具表都取自上次连上时的 cachedTools）
    expect(await mcpTools(DATABASE_SERVER_ID)).toEqual([])
  }, 120_000)

  it('DBE-S2 内置行整行只读：删不掉、改不动、名字不能再用', async () => {
    const del = await mcpDelete(DATABASE_SERVER_ID)
    expect(del.success).toBe(false)
    expect(del.error).toContain('cannot be deleted')

    const before = await rowOf(DATABASE_SERVER_ID)
    // 改名 / 改类型 / 改命令 / 改地址：handler 回成功，但内置行只收 env / headers / isEnabled
    expect(
      await mcpUpdate({
        id: DATABASE_SERVER_ID,
        name: 'renamed-database',
        type: 'http',
        command: '/bin/echo',
        args: ['x'],
        url: 'http://127.0.0.1:9/mcp'
      })
    ).toEqual({ success: true })
    const after = await rowOf(DATABASE_SERVER_ID)
    for (const key of ['name', 'type', 'command', 'args', 'url'] as const) {
      expect(after[key], key).toBe(before[key])
    }

    // 名字就是工具名前缀：另起一台叫 database 的会冒充内置的那台
    expect(await mcpAdd({ name: 'database', type: 'http', url: 'http://127.0.0.1:9/mcp' })).toEqual(
      {
        success: false,
        error: 'An MCP server named "database" already exists'
      }
    )
    expect((await mcpList()).filter((r) => r.name === 'database')).toHaveLength(1)
  }, 120_000)
})

describe('MCP 设置页（DOM）', () => {
  it('DBE-S3 内置行置顶；database 行：内置徽章、inproc、删除灰着、开关开着，没有编辑与重连', async () => {
    const rows = await until(async () => {
      const r = await mcp.rows()
      return r.some((x) => x.name === 'tavily') ? r : null
    }, 'mcp rows listed')

    const lastBuiltin = rows.map((r) => r.builtinBadge).lastIndexOf(true)
    const firstUser = rows.findIndex((r) => !r.builtinBadge)
    expect(firstUser).toBeGreaterThan(lastBuiltin)
    expect(
      rows
        .filter((r) => r.builtinBadge)
        .map((r) => r.name)
        .sort()
    ).toEqual(['browser', 'database', 'ssh'])

    const database = rows.find((r) => r.name === 'database')!
    expect(database).toMatchObject({
      builtinBadge: true,
      typeBadge: 'inproc',
      deleteDisabled: true,
      hasEdit: false,
      hasReconnect: false,
      enabledOn: true
    })
    expect(CANNOT_DELETE).toContain(database.deleteTitle)
  }, 120_000)

  it('DBE-S4 展开 database：「已保存的连接」一节 + 安全警告 + 空态；存了连接之后逐行呈现、密码哪儿都没有；别的行展开没有这一节', async () => {
    await mcp.setExpanded('database', true)
    const empty = await dbs.loaded()
    expect(DB_TITLES).toContain(empty.title)
    expect(WARNINGS).toContain(empty.warning)
    // 这一节是干嘛的收在标题旁的问号里
    expect(empty.hints).toBe(1)
    expect(empty.rows).toEqual([])
    expect(EMPTY).toContainEqual(empty.empty)

    await addDbCredential(app.main, S4_PG)
    await addDbCredential(app.main, S4_MY)
    await reopenDatabaseRow()
    const seeded = await until(async () => {
      const s = await dbs.shot()
      return s.rows.length === 2 ? s : null
    }, 'two saved connections listed')
    expect(seeded.empty).toEqual([])
    const [pg, my] = seeded.rows
    expect(pg).toMatchObject({
      name: S4_PG.name,
      engine: 'PostgreSQL',
      target: `${S4_PG.username}@${S4_PG.host}:${S4_PG.port}/${S4_PG.database}`,
      confirming: false
    })
    expect(READONLY_BADGES).toContain(pg.readonlyBadge)
    // 只读徽章只在只读的那一条上
    expect(my).toMatchObject({
      name: S4_MY.name,
      engine: 'MySQL',
      readonlyBadge: '',
      target: `${S4_MY.username}@${S4_MY.host}:${S4_MY.port}/${S4_MY.database}`
    })
    // 密码从不出主进程：列表 IPC 不带它，页面上（含藏起来的文字）也没有
    const pageText = await settings.eval<string>('document.body.textContent ?? ""')
    expect(pageText).not.toContain(S4_PG.password)
    expect(pageText).not.toContain(S4_MY.password)
    expect(JSON.stringify(await listDbCredentials(app.main))).not.toContain('PASSWORD')

    // 同一时刻只展开一行：换成别的行，展开区里没有这一节
    for (const other of ['browser', 'ssh', 'tavily']) {
      await mcp.setExpanded(other, true)
      expect((await mcp.row('database'))?.expanded, other).toBe(false)
      expect((await dbs.shot()).present, other).toBe(false)
      const extra = await mcp.extra(other)
      for (const title of extra.sectionTitles) expect(DB_TITLES, other).not.toContain(title)
    }
    await mcp.setExpanded('tavily', false)
  }, 120_000)

  it('DBE-S5 弹窗：只读缺省开着；测试连接真的连到服务器、连不上说连不上；添加 → 出现在列表；重名报重名；编辑改得动；删除要确认', async () => {
    await mcp.setExpanded('database', true)
    await dbs.loaded()

    // ── 添加 ──
    await dbs.clickAdd()
    let dialog = await until(async () => {
      const d = await dbs.dialog()
      return d.open ? d : null
    }, 'add dialog open')
    expect(ADD_TITLES).toContain(dialog.title)
    expect(dialog.readonlyOn).toBe(true)
    expect(dialog.engine).toBe('MySQL')
    expect(dialog.fields.port).toBe('3306')
    await dbs.pickEngine('PostgreSQL')
    expect((await dbs.dialog()).fields.port).toBe('5432')

    const port = String(bridge.port)
    await dbs.fill({
      name: 's5-conn',
      host: '127.0.0.1',
      port,
      username: 's5_user',
      password: 's5-secret-pw',
      database: 's5_db'
    })

    // 测试连接：服务器那一侧真的来了一条连接，而且测完就断
    const before = bridge.connections()
    await dbs.clickTest()
    dialog = await until(async () => {
      const d = await dbs.dialog()
      return d.messages.length > 0 ? d : null
    }, 'test connection result shown')
    expect(dialog.messages).toHaveLength(1)
    expect(TEST_OK).toContain(dialog.messages[0].text)
    expect(dialog.messages[0].ok).toBe(true)
    expect(bridge.connections()).toBe(before + 1)
    await until(() => bridge.open() === 0, 'test connection closed its socket')
    // 测试连接不是一次查询：一条语句都没发
    expect(bridge.statements()).toEqual([])

    // 连不上：说连不上（这是给用户看的设置页，驱动的原话照直给）
    await dbs.fill({ port: '9' })
    await dbs.clickTest()
    dialog = await until(async () => {
      const d = await dbs.dialog()
      return d.messages.length === 1 && !d.messages[0].ok ? d : null
    }, 'failed test connection shown')
    expect(TEST_FAILED.some((prefix) => dialog.messages[0].text.startsWith(`${prefix}: `))).toBe(
      true
    )
    expect(dialog.messages[0].text).toContain('ECONNREFUSED')

    await dbs.fill({ port })
    await dbs.clickSave()
    await dbs.waitDialogClosed()
    const added = await until(async () => {
      const r = (await dbs.shot()).rows.find((x) => x.name === 's5-conn')
      return r ?? null
    }, 'new connection listed')
    expect(added).toMatchObject({
      engine: 'PostgreSQL',
      target: `s5_user@127.0.0.1:${port}/s5_db`
    })
    expect(READONLY_BADGES).toContain(added.readonlyBadge)
    expect((await listDbCredentials(app.main)).find((c) => c.name === 's5-conn')).toMatchObject({
      dbType: 'postgresql',
      host: '127.0.0.1',
      port: Number(port),
      username: 's5_user',
      database: 's5_db',
      readonly: true
    })

    // ── 重名 ──
    await dbs.clickAdd()
    await until(async () => (await dbs.dialog()).open, 'second add dialog open')
    await dbs.fill({
      name: 's5-conn',
      host: 'h.example',
      username: 'u',
      password: 'p',
      database: 'd'
    })
    await dbs.clickSave()
    dialog = await until(async () => {
      const d = await dbs.dialog()
      return d.open && d.messages.length > 0 ? d : null
    }, 'duplicate name reported in the dialog')
    expect(DUPLICATE).toContain(dialog.messages[dialog.messages.length - 1].text)
    expect((await listDbCredentials(app.main)).filter((c) => c.name === 's5-conn')).toHaveLength(1)
    await dbs.clickCancel()
    await dbs.waitDialogClosed()

    // ── 编辑 ──
    await dbs.clickEdit('s5-conn')
    dialog = await until(async () => {
      const d = await dbs.dialog()
      return d.open ? d : null
    }, 'edit dialog open')
    expect(EDIT_TITLES).toContain(dialog.title)
    // 旧值回填；密码从不回到界面上
    expect(dialog.fields).toEqual({
      name: 's5-conn',
      host: '127.0.0.1',
      port,
      username: 's5_user',
      password: '',
      database: 's5_db'
    })
    expect(dialog.engine).toBe('PostgreSQL')
    expect(dialog.readonlyOn).toBe(true)
    await dbs.fill({ database: 's5_db_renamed' })
    await dbs.clickSave()
    await dbs.waitDialogClosed()
    await until(
      async () =>
        (await dbs.shot()).rows.find((x) => x.name === 's5-conn')?.target ===
        `s5_user@127.0.0.1:${port}/s5_db_renamed`,
      'edited subtitle shown'
    )
    expect((await listDbCredentials(app.main)).find((c) => c.name === 's5-conn')?.database).toBe(
      's5_db_renamed'
    )

    // ── 删除要确认 ──
    await dbs.clickDelete('s5-conn')
    // 点了垃圾桶还没删：行还在、库里也还在
    expect((await dbs.shot()).rows.some((x) => x.name === 's5-conn')).toBe(true)
    expect((await listDbCredentials(app.main)).some((c) => c.name === 's5-conn')).toBe(true)
    await dbs.answerDelete('s5-conn', true)
    await until(
      async () => !(await dbs.shot()).rows.some((x) => x.name === 's5-conn'),
      'deleted connection gone from the list'
    )
    expect((await listDbCredentials(app.main)).some((c) => c.name === 's5-conn')).toBe(false)
  }, 120_000)
})

describe('「LLM 工具」页上没有数据库了', () => {
  it('DBE-S6 工具定义与工具子页里没有 database；会话的工具表里只有能力服务器 mcp:database', async () => {
    const defs = await app.main.eval<Array<{ name: string }>>(`window.api.tools.definitions()`)
    expect(defs.length).toBeGreaterThan(0)
    expect(defs.map((d) => d.name)).not.toContain('database')

    const nav = settingsNavPane(settings)
    await nav.selectTab(TOOLS_TAB)
    const labels = await nav.toolSubTabLabels()
    expect(labels.length).toBeGreaterThan(3)
    for (const label of DB_LABELS) expect(labels).not.toContain(label)
    await nav.selectTab(['MCP'])
    await mcp.waitRow('database')

    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'DBE-S6' })}).then((s) => s.id)`
    )
    const list = await app.main.eval<
      Array<{ name: string; isBuiltin?: boolean; declaredBy?: string }>
    >(`window.api.tools.list(${JSON.stringify(sid)})`)
    expect(list.find((t) => t.name === 'database')).toBeUndefined()
    const item = list.find((t) => t.name === 'mcp:database')
    expect(item).toMatchObject({ isBuiltin: true })
    // 没有哪个基座档案声明它：默认关，要用户自己勾
    expect(item?.declaredBy).toBeUndefined()
    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
  }, 120_000)
})

describe('第一次用到才连（会话级实例）', () => {
  it('DBE-S7 勾了它的会话一起来就连上：2 个工具、工具名，删掉会话回到未启动', async () => {
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: 'DBE-S7' })}).then((s) => s.id)`
    )
    await app.main.eval(
      `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools: ['mcp:database'] })})`
    )
    const info = await app.main.eval<{ tools: Array<{ name: string }> }>(
      `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`
    )
    expect(
      info.tools
        .map((t) => t.name)
        .filter((n) => n.startsWith('mcp__database__'))
        .sort()
    ).toEqual(ALL_DB_TOOLS)

    const row = await until(async () => {
      const r = await rowOf(DATABASE_SERVER_ID)
      return r.status === 'connected' ? r : null
    }, 'database row connected')
    expect(row.toolCount).toBe(DATABASE_TOOL_NAMES.length)
    expect((await mcpTools(DATABASE_SERVER_ID)).map((t) => t.name).sort()).toEqual(ALL_DB_TOOLS)

    // 展开时才取工具表：收起再展开，拿到的是这一次连上时发现的那一份
    await reopenDatabaseRow()
    const shown = await until(async () => {
      const names = await mcp.expandedToolNames('database')
      return names.length > 0 ? names : null
    }, 'database tools listed in the expanded row')
    expect([...shown].sort()).toEqual([...DATABASE_TOOL_NAMES].sort())
    // 工具表之后仍是「已保存的连接」那一节
    expect((await dbs.loaded()).present).toBe(true)

    await app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)
    await until(
      async () => (await rowOf(DATABASE_SERVER_ID)).status === 'disconnected',
      'database row back to not started after the session is gone'
    )
    await mcp.setExpanded('database', false)
  }, 120_000)
})
