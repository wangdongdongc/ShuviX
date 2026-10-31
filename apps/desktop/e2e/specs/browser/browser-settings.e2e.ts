/**
 * 内置能力服务器 `browser` 在设置里的样子（无 LLM）。
 *
 * 浏览器从「LLM 工具」里的一个内置工具，改成了按会话勾选的内置 MCP 能力服务器
 * （`type: 'inproc'`，v27 种下的 `builtin-mcp-browser` 行，全局启用、会话默认不勾）。于是它在设置里
 * 换了家：MCP 页上一行只读的内置服务器；「LLM 工具」页上不再有它。浏览器**自己的**设置（搜索引擎、
 * 网站数据、证书）2026-10-16 又搬进了浏览器窗口的内部设置页 `shuvix://settings`（照 Chrome 的
 * chrome://settings），那一行的展开区只剩一个入口。本 spec 钉这几件事：
 *
 *   - 种子行的形状与「整行只读」（删不掉、改不了名字 / 类型 / 命令 / 地址、名字不能被占）；
 *   - 列表里内置置顶、内置行的徽章与按钮（没有编辑、没有重连、删除灰着）；
 *   - BS-E1  展开区：browser 那一行只有「浏览器设置」入口（打开按钮；没有开关、没有站点列表、没有输入框；
 *     database 那一行挂的是已保存的数据库连接，见 database 区；ssh / tavily 没有附加设置）；
 *   - BS-E2  点入口：浏览器窗口开出来，恰好一个设置页 tab（listTabs 的 internalPage）、被选中、外壳画着设置页、
 *     地址栏写 shuvix://settings；选了别的 tab 再点 → 还是那一个、又被选中；设置页里拨「忽略证书错误」写
 *     `tool.browser.ignoreCertificateErrors`、警告跟着出现 / 消失；选 Bing 写 `browser.searchEngine`，新空白页的
 *     新标签页写着 Bing；MCP 那一行一直启用着；
 *   - SD-E1  访问夹具网站（写一个 cookie）之后，listSites 按网站分组：127.0.0.1 一行（1 个 cookie、网站名不带端口）；
 *     设置页的网站数据列出它（「大小 · 1 cookie」）、合计一行数着 1 个网站；搜索能留住 / 滤掉它（合计一行不变）；
 *     逐站删除之后 listSites 里没了；再访问一次，「删除浏览数据」+ 确认之后 listSites 空了、合计一行也没了
 *     （按网站分组的详情、各类删除见 browser-site-data.e2e.ts）；
 *   - 第一次用到才连（会话级实例），连上之后工具数与工具名、会话删掉之后回到「未启动」；
 *   - 启用开关：关掉会断开活着的会话实例，新会话再勾它也拿不到工具（而且不报错、不转圈），
 *     重新打开之后新会话又有了。
 *
 * 断言优先走 IPC（`window.api.mcp.*` / `tools.*` / `settings.*` / `browserData.*` / `browserView.*`）；DOM 只断
 * 「呈现」，一律经 pages.ts 的 mcpSettingsPane / browserShellPane / browserSettingsPagePane。文案随界面语言变 ——
 * 需要比对文字的地方按三语候选认。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  ensureDefaultModel,
  eventRecorder,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  browserSettingsPagePane,
  browserShellPane,
  browserWallPane,
  mcpSettingsPane,
  settingsNavPane,
  type BrowserSettingsPagePane,
  type BrowserSettingsPageShot,
  type BrowserShellPane,
  type BrowserWallPane,
  type McpSettingsPane
} from '../../harness/pages'
import {
  BROWSER_TOOL_NAMES,
  browserTool,
  startFixtureServer,
  type FixtureServer
} from '../../harness/browserFixtures'
import { formatBytes, type SiteSummary } from '../../../src/shared/browserSiteData'

const BROWSER_ID = 'builtin-mcp-browser'
const SSH_ID = 'builtin-mcp-ssh'
const TAVILY_ID = 'builtin-mcp-tavily'
const CERT_KEY = 'tool.browser.ignoreCertificateErrors'
const ENGINE_KEY = 'browser.searchEngine'
const SETTINGS_URL = 'shuvix://settings'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()

/** 三语候选（chat-protocol 语言包原文） */
const BROWSER_LABELS = ['Browser', '浏览器', 'ブラウザ']
/** 网站数据一行里「1 个 cookie」的写法 */
const ONE_COOKIE = ['1 cookie', '1 个 Cookie', 'Cookie 1 件']
/** 合计一行「1 个网站」的写法（chat-protocol 语言包 browser.siteData.total_one） */
const ONE_SITE_TOTAL = /^(1 site, .+ in total|共 1 个网站，占用 .+|1 サイト、合計 .+)$/
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

interface TabRow {
  id: string
  url: string
  active: boolean
  internalPage?: string
}

let app: E2EApp
let settings: CdpClient
let mcp: McpSettingsPane
let events: EventRecorder
let fixture: FixtureServer
/** 浏览器窗口（BS-E2 起，点入口开出来的） */
let bw: CdpClient | null = null
let shell: BrowserShellPane
let wall: BrowserWallPane
let page: BrowserSettingsPagePane
/** BS-E2 开出来的设置页 tab */
let settingsTab = ''

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
const listSites = (): Promise<SiteSummary[]> => app.main.eval(`window.api.browserData.listSites()`)
const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>(`window.api.browserView.listTabs()`)
const createTab = (url: string): Promise<string> =>
  app.main.eval<string>(`window.api.browserView.createTab(${JSON.stringify(url)})`)
const closeTab = (id: string): Promise<unknown> =>
  app.main.eval(`window.api.browserView.closeTab(${JSON.stringify(id)})`)
const isWindowOpen = (): Promise<boolean> =>
  app.main.eval<boolean>('window.api.browserView.isWindowOpen()')
const selectedId = async (): Promise<string | undefined> =>
  (await listTabs()).find((t) => t.active)?.id
const settingsRows = async (): Promise<TabRow[]> =>
  (await listTabs()).filter((t) => t.internalPage === 'settings')
/** 等设置页挂上、读完它自己的三样（开关与站点列表都是异步读出来的） */
const loadedPage = (): Promise<BrowserSettingsPageShot> =>
  until(async () => {
    const shot = await page.shot()
    const settled =
      shot.present && shot.ignoreCertOn !== null && (shot.sites.length > 0 || !!shot.sitesEmptyText)
    return settled ? shot : null
  }, 'browser settings page loaded')

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

beforeAll(async () => {
  app = await launchApp()
  await ensureDefaultModel(app.main)
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  fixture = await startFixtureServer()
  settings = await app.openSettings('mcp')
  mcp = mcpSettingsPane(settings)
  await mcp.waitRow('browser')
}, 120_000)

afterAll(async () => {
  bw?.close()
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
    ).toEqual(['browser', 'chrome', 'database', 'plan', 'ssh'])
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
    ).toEqual(['browser', 'chrome', 'database', 'plan', 'ssh'])

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

  it('BS-E1 browser 那一行展开后只有「浏览器设置」入口：打开按钮在，没有开关、站点列表、输入框；ssh / tavily 没有附加设置', async () => {
    await mcp.setExpanded('browser', true)
    const link = await until(async () => {
      const l = await mcp.browserSettingsLink()
      return l.present ? l : null
    }, 'browser settings link in the expanded row')
    expect(link).toEqual({ present: true, openButton: true, toggles: 0, siteRows: 0, inputs: 0 })

    // 同一时刻只展开一行：换成 ssh / tavily，它们的展开区里没有附加设置
    await mcp.setExpanded('ssh', true)
    expect((await mcp.row('browser'))?.expanded).toBe(false)
    expect((await mcp.extra('ssh')).present).toBe(false)
    await mcp.setExpanded('tavily', true)
    expect((await mcp.extra('tavily')).present).toBe(false)
    await mcp.setExpanded('tavily', false)
  }, 120_000)
})

describe('浏览器窗口自己的设置页（BS-E2 / SD-E1）', () => {
  it('BS-E2 点入口：浏览器窗口开出来，恰好一个设置页 tab、选中、地址栏 shuvix://settings；再点还是它；拨证书开关、选 Bing 都写进设置；MCP 行一直启用', async () => {
    expect(await isWindowOpen()).toBe(false)
    await mcp.setExpanded('browser', true)
    await until(async () => (await mcp.browserSettingsLink()).present, 'browser settings link')
    await mcp.openBrowserSettings()

    await until(() => isWindowOpen(), 'browser window opened by the link')
    bw = await until(() => app.browserWindow(), 'browser window page')
    shell = browserShellPane(bw)
    wall = browserWallPane(bw)
    page = browserSettingsPagePane(bw)
    await until(() => wall.mounted(), 'browser window shell mounted')

    const rows = await until(async () => {
      const list = await settingsRows()
      return list.length === 1 && list[0].active ? list : null
    }, 'exactly one selected settings tab')
    settingsTab = rows[0].id
    expect(rows[0].url).toBe(SETTINGS_URL)
    const first = await loadedPage()
    expect(first.navIds).toEqual(['search', 'privacy', 'certificates'])
    expect(await shell.omniboxDisplay()).toBe(SETTINGS_URL)
    expect(await wall.selectedTabIds()).toEqual([settingsTab])

    // ── 选了别的 tab 再点入口：还是那一个设置页，又被选中 ──
    const other = await createTab(fixture.url('/counter.html?bs=e2'))
    await until(async () => (await selectedId()) === other, 'user tab selected')
    await until(async () => !(await page.shot()).present, 'settings page off screen')
    const countBefore = (await listTabs()).length
    await mcp.openBrowserSettings()
    await until(async () => (await selectedId()) === settingsTab, 'settings tab selected again')
    expect((await settingsRows()).map((t) => t.id)).toEqual([settingsTab])
    expect(await listTabs()).toHaveLength(countBefore)
    const again = await loadedPage()

    // ── 忽略证书错误：写设置、警告跟着走 ──
    expect(again.ignoreCertOn).toBe(false)
    expect(again.warning).toBe(false)
    await page.toggleIgnoreCert()
    await until(async () => (await settingGet(CERT_KEY)) === 'true', 'ignore-cert stored on')
    await until(async () => {
      const x = await page.shot()
      return x.ignoreCertOn === true && x.warning
    }, 'ignore-cert toggle on + warning')
    await page.toggleIgnoreCert()
    await until(async () => (await settingGet(CERT_KEY)) === 'false', 'ignore-cert stored off')
    await until(async () => {
      const x = await page.shot()
      return x.ignoreCertOn === false && !x.warning
    }, 'ignore-cert toggle off, warning gone')

    // ── 搜索引擎：选 Bing → 写设置；新空白页的新标签页写着 Bing ──
    expect(again.engine).toBe('google')
    await page.chooseEngine('bing')
    await until(async () => (await settingGet(ENGINE_KEY)) === 'bing', 'search engine stored')
    await shell.clickNewTab()
    const blank = await until(async () => {
      const list = await listTabs()
      const last = list.at(-1)
      return last && last.active && last.url === 'about:blank' ? last.id : null
    }, 'new blank tab selected')
    await until(
      async () => (await shell.newTabPagePlaceholder())?.includes('Bing') === true,
      'new-tab page names Bing'
    )

    // ── MCP 那一行一直启用着（设置页里的开关不是它的启用位）──
    expect((await rowOf(BROWSER_ID)).isEnabled).toBe(1)
    expect((await mcp.row('browser'))?.enabledOn).toBe(true)

    // 收拾：引擎回缺省，关掉多开的两个 tab（设置页留给 SD-E1）
    await app.main.eval(
      `window.api.settings.set(${JSON.stringify({ key: ENGINE_KEY, value: 'google' })})`
    )
    await until(async () => (await settingGet(ENGINE_KEY)) === 'google', 'engine back to google')
    await closeTab(blank)
    await closeTab(other)
    await until(async () => (await listTabs()).length === countBefore - 1, 'extra tabs closed')
  }, 120_000)

  it('SD-E1 网站数据：127.0.0.1（1 个 cookie、按网站分组、不带端口）列出来、合计一行；搜索留住 / 滤掉；逐站删除；再访问后删除浏览数据', async () => {
    if (!bw) throw new Error('BS-E2 did not open the browser window')
    const visit = await createTab(fixture.url('/form.html?bs=e3a'))
    const site = await until(
      async () => (await listSites()).find((s) => s.site === '127.0.0.1') ?? null,
      'fixture cookie saved in the browser partition'
    )
    expect(site).toMatchObject({
      site: '127.0.0.1',
      cookieCount: 1,
      cookieBytes: 'e2e_visit1'.length,
      localStorage: false
    })
    // 网站名是分组键：主机名本身，不带端口
    const all = await listSites()
    for (const s of all) expect(s.site, s.site).not.toContain(':')

    // ── 打开设置页（⋮ → 设置：已经开着就选中它，页面重新挂载、重新列站点）──
    await shell.moreMenu('settings')
    await until(async () => (await selectedId()) === settingsTab, 'settings tab selected')
    const listed = await until(async () => {
      const x = await page.shot()
      return x.sites.some((r) => r.site === '127.0.0.1') ? x : null
    }, 'settings page lists 127.0.0.1')
    const row = listed.sites.find((r) => r.site === '127.0.0.1')!
    expect(
      ONE_COOKIE.some((t) => row.subtitle.includes(t)),
      row.subtitle
    ).toBe(true)
    expect(row.subtitle.startsWith(`${formatBytes(site.usageBytes + site.cookieBytes)} · `)).toBe(
      true
    )
    expect(listed.siteTotal).toMatch(ONE_SITE_TOTAL)

    // ── 搜索：子串留住、不匹配滤掉；合计一行数的是全部网站，不随搜索变 ──
    await page.typeSiteSearch('127.0')
    expect((await page.shot()).sites.map((r) => r.site)).toContain('127.0.0.1')
    await page.typeSiteSearch('no-such-site.example')
    const filtered = await page.shot()
    expect(filtered.sites).toEqual([])
    expect(filtered.sitesEmptyText).not.toBe('')
    expect(filtered.siteTotal).toBe(listed.siteTotal)
    await page.typeSiteSearch('')
    expect((await page.shot()).sites.map((r) => r.site)).toContain('127.0.0.1')

    // ── 逐站删除 ──
    await page.clearSite('127.0.0.1')
    await until(
      async () => !(await listSites()).some((s) => s.site === '127.0.0.1'),
      'site data gone from the partition'
    )
    await until(
      async () => !(await page.shot()).sites.some((r) => r.site === '127.0.0.1'),
      'site row gone from the settings page'
    )

    // ── 再访问一次，然后删除浏览数据 ──
    const revisit = await createTab(fixture.url('/form.html?bs=e3b'))
    await until(
      async () => (await listSites()).some((s) => s.site === '127.0.0.1'),
      'cookie saved again on revisit'
    )
    await shell.clickTab(settingsTab)
    await until(
      async () => (await page.shot()).sites.some((r) => r.site === '127.0.0.1'),
      'settings page lists the revisited site'
    )
    await page.clearAll()
    await until(async () => (await listSites()).length === 0, 'every site gone after delete all')
    await until(async () => {
      const x = await page.shot()
      return x.sites.length === 0 && x.siteTotal === null
    }, 'site list empty, no total line')

    await closeTab(visit)
    await closeTab(revisit)
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
