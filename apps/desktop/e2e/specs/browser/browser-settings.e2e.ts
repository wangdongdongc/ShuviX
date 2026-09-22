/**
 * 内置能力服务器 `browser` 在设置里的样子（无 LLM）。
 *
 * 浏览器从「LLM 工具」里的一个内置工具，改成了按会话勾选的内置 MCP 能力服务器
 * （`type: 'inproc'`，v27 种下的 `builtin-mcp-browser` 行，全局启用、会话默认不勾）。于是它在设置里
 * 换了家：MCP 页上一行只读的内置服务器，面板自己的设置（证书错误、已保存站点）挂在那一行的展开区；
 * 「LLM 工具」页上不再有它。本 spec 钉这几件事：
 *
 *   - 种子行的形状与「整行只读」（删不掉、改不了名字 / 类型 / 命令 / 地址、名字不能被占）；
 *   - 列表里内置置顶、内置行的徽章与按钮（没有编辑、没有重连、删除灰着）；
 *   - 展开区：browser 那一行挂着浏览器面板的设置（database 那一行挂的是已保存的数据库连接，
 *     见 database 区；ssh / tavily 没有附加设置），开关写的是 `tool.browser.ignoreCertificateErrors`，
 *     已保存站点可以逐个清掉；
 *   - 第一次用到才连（会话级实例），连上之后工具数与工具名、会话删掉之后回到「未启动」；
 *   - 启用开关：关掉会断开活着的会话实例，新会话再勾它也拿不到工具（而且不报错、不转圈），
 *     重新打开之后新会话又有了。
 *
 * 断言优先走 IPC（`window.api.mcp.*` / `tools.*` / `settings.*` / `browserData.*`）；DOM 只断「呈现」，
 * 一律经 pages.ts 的 mcpSettingsPane。文案随界面语言变 —— 需要比对文字的地方按三语候选认。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  eventRecorder,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  mcpSettingsPane,
  settingsNavPane,
  type McpExtraShot,
  type McpSettingsPane
} from '../../harness/pages'
import {
  BROWSER_TOOL_NAMES,
  browserTool,
  startFixtureServer,
  type FixtureServer
} from '../../harness/browserFixtures'

const BROWSER_ID = 'builtin-mcp-browser'
const SSH_ID = 'builtin-mcp-ssh'
const TAVILY_ID = 'builtin-mcp-tavily'
const CERT_KEY = 'tool.browser.ignoreCertificateErrors'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()

/** 三语候选（chat-protocol 语言包原文） */
const BROWSER_LABELS = ['Browser', '浏览器', 'ブラウザ']
const PANEL_TITLES = ['Browser panel', '浏览器面板', 'ブラウザパネル']
const NO_SITES = [
  'No sites with saved data',
  '暂无已保存数据的站点',
  '保存されたデータのあるサイトはありません'
]
const CANNOT_DELETE = [
  'Built-in servers cannot be deleted',
  '内置服务不可删除',
  '組み込みサーバーは削除できません'
]
const TOOLS_TAB = ['LLM Tools', 'LLM 工具', 'LLM ツール']

interface McpRow {
  id: string
  name: string
  type: string
  command: string
  args: string
  env: string
  url: string
  headers: string
  isEnabled: number
  isBuiltin: number
  status: string
  error?: string
  toolCount: number
  updatedAt: number
}

interface ListedTool {
  name: string
  isBuiltin?: boolean
  declaredBy?: string
}

let app: E2EApp
let settings: CdpClient
let mcp: McpSettingsPane
let events: EventRecorder
let fixture: FixtureServer

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
const settingGet = (key: string): Promise<string | undefined> =>
  app.main.eval(`window.api.settings.get(${JSON.stringify(key)})`)
const listSites = (): Promise<Array<{ host: string; cookieCount: number }>> =>
  app.main.eval(`window.api.browserData.listSites()`)

const createSession = (title: string): Promise<string> =>
  app.main.eval<string>(`window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`)
const writeTools = (sid: string, enabledTools: string[]): Promise<{ success: boolean }> =>
  app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools })})`
  )
/** 懒建运行时（不请求 LLM）并回工具名 */
const runtimeTools = async (sid: string): Promise<string[]> => {
  const info = await app.main.eval<{ tools: Array<{ name: string }> } | null>(
    `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`
  )
  return (info?.tools ?? []).map((t) => t.name)
}
const browserToolsOf = (names: string[]): string[] =>
  names.filter((n) => n.startsWith('mcp__browser__')).sort()
/** 建一条勾了 mcp:browser 的会话并让它的运行时起来，回会话 id 与它拿到的浏览器工具 */
const tickedSession = async (title: string): Promise<{ sid: string; tools: string[] }> => {
  const sid = await createSession(title)
  expect((await writeTools(sid, ['mcp:browser'])).success).toBe(true)
  return { sid, tools: browserToolsOf(await runtimeTools(sid)) }
}
const deleteSession = (sid: string): Promise<unknown> =>
  app.main.eval(`window.api.session.delete(${JSON.stringify(sid)})`)

/** 等浏览器那一行的附加设置加载完（开关与站点列表都是异步读出来的） */
const loadedExtra = (): Promise<McpExtraShot> =>
  until(async () => {
    const x = await mcp.extra('browser')
    const settled =
      x.present && x.firstToggleOn !== null && (x.sites.length > 0 || !!x.sitesEmptyText)
    return settled ? x : null
  }, 'browser extra settings loaded')

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  fixture = await startFixtureServer()
  settings = await app.openSettings('mcp')
  mcp = mcpSettingsPane(settings)
  await mcp.waitRow('browser')
}, 120_000)

afterAll(async () => {
  await fixture?.close()
  await app?.stop()
})

describe('种子行（IPC）', () => {
  it('BRS-1 browser 与 ssh 各一行：内置、inproc、全局启用、没连过、没有工具；内置的恰好四台', async () => {
    const rows = await mcpList()

    const browsers = rows.filter((r) => r.name === 'browser')
    expect(browsers).toHaveLength(1)
    expect(browsers[0]).toMatchObject({
      id: BROWSER_ID,
      type: 'inproc',
      isBuiltin: 1,
      isEnabled: 1,
      status: 'disconnected',
      toolCount: 0,
      command: '',
      url: ''
    })
    const sshRows = rows.filter((r) => r.name === 'ssh')
    expect(sshRows).toHaveLength(1)
    expect(sshRows[0]).toMatchObject({
      id: SSH_ID,
      type: 'inproc',
      isBuiltin: 1,
      isEnabled: 1,
      status: 'disconnected',
      toolCount: 0
    })

    // 内置的恰好这四台（database 是 v28 种的，chrome 是 v29 种的，形状各由自己的区钉；Tavily 在 v24 交还给用户了）
    expect(
      rows
        .filter((r) => r.isBuiltin === 1)
        .map((r) => r.name)
        .sort()
    ).toEqual(['browser', 'chrome', 'database', 'ssh'])
    expect(rows.find((r) => r.id === TAVILY_ID)?.isBuiltin).toBe(0)

    // 没连过就没有工具（工具数与工具表都取自上次连上时的 cachedTools）
    expect(await mcpTools(BROWSER_ID)).toEqual([])
  }, 120_000)

  it('BRS-2 内置行整行只读：删不掉、改不动、名字不能再用', async () => {
    const del = await mcpDelete(BROWSER_ID)
    expect(del.success).toBe(false)
    expect(del.error).toContain('cannot be deleted')

    const before = await rowOf(BROWSER_ID)
    // 改名 / 改类型 / 改命令 / 改地址：handler 回成功，但内置行只收 env / headers / isEnabled
    expect(
      await mcpUpdate({
        id: BROWSER_ID,
        name: 'renamed-browser',
        type: 'http',
        command: '/bin/echo',
        args: ['x'],
        url: 'http://127.0.0.1:9/mcp'
      })
    ).toEqual({ success: true })
    const after = await rowOf(BROWSER_ID)
    for (const key of ['name', 'type', 'command', 'args', 'url'] as const) {
      expect(after[key], key).toBe(before[key])
    }

    // 名字就是工具名前缀：另起一台叫 browser 的会冒充内置浏览器
    expect(await mcpAdd({ name: 'browser', type: 'http', url: 'http://127.0.0.1:9/mcp' })).toEqual({
      success: false,
      error: 'An MCP server named "browser" already exists'
    })
    expect((await mcpList()).filter((r) => r.name === 'browser')).toHaveLength(1)
  }, 120_000)
})

describe('MCP 设置页（DOM）', () => {
  it('BRS-3 内置行置顶；browser 行：内置徽章、inproc、删除灰着、开关开着，没有编辑与重连', async () => {
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
    ).toEqual(['browser', 'chrome', 'database', 'ssh'])

    const browser = rows.find((r) => r.name === 'browser')!
    expect(browser).toMatchObject({
      builtinBadge: true,
      typeBadge: 'inproc',
      deleteDisabled: true,
      hasEdit: false,
      hasReconnect: false,
      enabledOn: true
    })
    expect(CANNOT_DELETE).toContain(browser.deleteTitle)

    // 对照：用户自己的行能编辑、能删
    const tavily = rows.find((r) => r.name === 'tavily')!
    expect(tavily).toMatchObject({ builtinBadge: false, hasEdit: true, deleteDisabled: false })
  }, 120_000)

  it('BRS-4 browser 那一行展开后是面板设置：面板标题、证书开关关着、没有已保存站点；ssh / tavily 没有附加设置', async () => {
    await mcp.setExpanded('browser', true)
    const extra = await loadedExtra()
    expect(PANEL_TITLES).toContain(extra.sectionTitles[0])
    expect(extra.firstToggleOn).toBe(false)
    expect(extra.warning).toBe(false)
    expect(extra.sites).toEqual([])
    expect(NO_SITES).toContain(extra.sitesEmptyText)

    // 同一时刻只展开一行：换成 ssh / tavily，它们的展开区里没有附加设置
    await mcp.setExpanded('ssh', true)
    expect((await mcp.row('browser'))?.expanded).toBe(false)
    expect((await mcp.extra('ssh')).present).toBe(false)
    await mcp.setExpanded('tavily', true)
    expect((await mcp.extra('tavily')).present).toBe(false)
    await mcp.setExpanded('tavily', false)
  }, 120_000)

  it('BRS-5 证书开关写的是 tool.browser.ignoreCertificateErrors，打开有警告，不动行的启用位', async () => {
    await mcp.setExpanded('browser', true)
    expect((await loadedExtra()).firstToggleOn).toBe(false)

    await mcp.clickExtraFirstToggle('browser')
    await until(async () => (await settingGet(CERT_KEY)) === 'true', 'ignore-cert stored on')
    const on = await until(async () => {
      const x = await mcp.extra('browser')
      return x.firstToggleOn === true && x.warning ? x : null
    }, 'ignore-cert toggle on + warning')
    expect(on.warning).toBe(true)
    // 附加设置里的开关与行尾的启用开关是两颗：点前者不该碰后者
    expect((await rowOf(BROWSER_ID)).isEnabled).toBe(1)
    expect((await mcp.row('browser'))?.enabledOn).toBe(true)

    await mcp.clickExtraFirstToggle('browser')
    await until(async () => (await settingGet(CERT_KEY)) === 'false', 'ignore-cert stored off')
    await until(
      async () => !(await mcp.extra('browser')).warning,
      'warning gone once the toggle is off'
    )
    expect((await rowOf(BROWSER_ID)).isEnabled).toBe(1)
  }, 120_000)

  it('BRS-6 已保存站点：面板里访问过的站点出现在列表里，逐个清掉之后两边都没了', async () => {
    // 不经 agent：直接在面板里开一个 tab（那一页写一个持久 cookie）
    const tabId = await app.main.eval<string>(
      `window.api.browserView.createTab(${JSON.stringify(fixture.url('/form.html'))})`
    )
    try {
      await until(
        async () => (await listSites()).some((s) => s.host === '127.0.0.1'),
        'fixture cookie saved in the browser partition'
      )
      expect(fixture.hits('/form.html')).toBeGreaterThan(0)

      await mcp.setExpanded('browser', true)
      await loadedExtra()
      await mcp.refreshSites('browser')
      await until(
        async () => (await mcp.extra('browser')).sites.includes('127.0.0.1'),
        'saved site listed'
      )

      await mcp.clearSite('browser', '127.0.0.1')
      await until(
        async () => !(await mcp.extra('browser')).sites.includes('127.0.0.1'),
        'saved site gone from the list'
      )
      expect((await listSites()).some((s) => s.host === '127.0.0.1')).toBe(false)
    } finally {
      await app.main.eval(`window.api.browserView.closeTab(${JSON.stringify(tabId)})`)
    }
  }, 120_000)
})

describe('「LLM 工具」页上没有浏览器了', () => {
  it('BRS-7 工具定义与工具子页里没有 browser；会话的工具表里只有能力服务器 mcp:browser', async () => {
    const defs = await app.main.eval<Array<{ name: string }>>(`window.api.tools.definitions()`)
    expect(defs.length).toBeGreaterThan(0)
    expect(defs.map((d) => d.name)).not.toContain('browser')

    const nav = settingsNavPane(settings)
    await nav.selectTab(TOOLS_TAB)
    const labels = await nav.toolSubTabLabels()
    expect(labels.length).toBeGreaterThan(3)
    for (const label of BROWSER_LABELS) expect(labels).not.toContain(label)
    await nav.selectTab(['MCP'])
    await mcp.waitRow('browser')

    const sid = await createSession('BRS-7')
    const list = await app.main.eval<ListedTool[]>(`window.api.tools.list(${JSON.stringify(sid)})`)
    expect(list.find((t) => t.name === 'browser')).toBeUndefined()
    const item = list.find((t) => t.name === 'mcp:browser')
    expect(item).toMatchObject({ isBuiltin: true })
    // 没有哪个基座档案声明它：默认关，要用户自己勾
    expect(item?.declaredBy).toBeUndefined()
    await deleteSession(sid)
  }, 120_000)
})

describe('第一次用到才连（会话级实例）', () => {
  it('BRS-8 勾了它的会话一起来就连上：22 个工具、工具名，删掉会话回到未启动', async () => {
    const { sid, tools } = await tickedSession('BRS-8')
    expect(tools).toEqual(ALL_BROWSER_TOOLS)

    const row = await until(async () => {
      const r = await rowOf(BROWSER_ID)
      return r.status === 'connected' ? r : null
    }, 'browser row connected')
    expect(row.toolCount).toBe(BROWSER_TOOL_NAMES.length)
    expect((await mcpTools(BROWSER_ID)).map((t) => t.name).sort()).toEqual(ALL_BROWSER_TOOLS)

    // 展开时才取工具表：收起再展开，拿到的是这一次连上时发现的那一份
    await mcp.setExpanded('browser', false)
    await mcp.setExpanded('browser', true)
    const shown = await until(async () => {
      const names = await mcp.expandedToolNames('browser')
      return names.length > 0 ? names : null
    }, 'browser tools listed in the expanded row')
    expect([...shown].sort()).toEqual([...BROWSER_TOOL_NAMES].sort())

    await deleteSession(sid)
    await until(
      async () => (await rowOf(BROWSER_ID)).status === 'disconnected',
      'browser row back to not started after the session is gone'
    )
    await mcp.setExpanded('browser', false)
  }, 120_000)
})

describe('启用开关', () => {
  it('BRS-9 关掉：断开活着的实例；新会话勾了也没有工具、不报错、不转圈；打开之后新会话又有了', async () => {
    const live = await tickedSession('BRS-9-live')
    expect(live.tools).toEqual(ALL_BROWSER_TOOLS)
    await until(
      async () => (await rowOf(BROWSER_ID)).status === 'connected',
      'browser row connected before the switch'
    )

    try {
      await mcp.clickEnabled('browser')
      await until(async () => (await rowOf(BROWSER_ID)).isEnabled === 0, 'browser disabled')
      await until(
        async () => (await mcp.row('browser'))?.enabledOn === false,
        'browser toggle painted off'
      )
      await until(
        () => app.mainLog().includes(`disconnected: ${BROWSER_ID}#${live.sid}`),
        'live session instance disconnected'
      )

      const mark = await events.mark()
      const off = await tickedSession('BRS-9-off')
      expect(off.tools).toEqual([])
      await sleep(300)
      const noise = (await events.allSince<RecordedEvent>(mark)).filter(
        (e) => e.sessionId === off.sid && (e.type === 'error' || e.type === 'mcp_connecting')
      )
      expect(noise).toEqual([])

      await mcp.clickEnabled('browser')
      await until(async () => (await rowOf(BROWSER_ID)).isEnabled === 1, 'browser enabled again')
      const on = await tickedSession('BRS-9-on')
      expect(on.tools).toEqual(ALL_BROWSER_TOOLS)

      for (const sid of [live.sid, off.sid, on.sid]) await deleteSession(sid)
    } finally {
      await mcpUpdate({ id: BROWSER_ID, isEnabled: true })
    }
  }, 120_000)
})
