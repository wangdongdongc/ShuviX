/**
 * 内置浏览器的历史记录与地址栏建议（2026-10-29，Chrome 的 History）：用户的访问进地址栏建议，agent 打开的页面
 * 记进历史、在历史记录页标出会话，但从不进地址栏建议（假提供商脚本化；夹具网站记下每一个请求）。一个实例按顺序走：
 *
 *   BH-E1  用户：标签条上的 + → 地址栏敲 `127.0.0.1:<port>/counter.html?bh=user` + Enter → 夹具收到请求；
 *          agent：一条勾了 mcp:browser 的会话 open_tab `/form.html?bh=agent`。在浏览器窗口外壳上问：
 *          list({actor:'agent'}) 恰好是表单那一个地址、带这个会话的 id 与标题；list({actor:'user'}) 有计数页、
 *          没有会话 id、没有表单页；suggest('127.0.0.1') 有计数页、没有表单页；suggest('bh=agent') 是空的。
 *          同样的调用从主窗口来：list → {items:[], next:null}、suggest → []（只认浏览器窗口外壳）；
 *   BH-E2  在用户那页的地址栏里（可信输入）打 `127.0` → 内联补全成 `127.0.0.1:<port>`、补上的那段选中 [5, len]，
 *          下拉的第一行是 `url:http://127.0.0.1:<port>/`；Enter → 夹具的 `/` 多一次请求；⋮ → 历史记录 →
 *          listTabs 里选中的是 shuvix://history；页面上今天这一组里 `/` 与计数页是用户的行（没有会话），表单页
 *          带着会话标签；agent 的 list_tabs 里没有 shuvix://history；点会话标签 → 主窗口切到那条会话。
 *
 * 地址栏打字之前先关掉「显示搜索建议」（browser.searchSuggest = 'false'）：开着时每打一个字都会向真的搜索引擎要
 * 建议。浏览器窗口在挂载时读设置，所以在开窗之前写。夹具网站没有 `/`（回 404）—— 404 照样是一次提交的导航，
 * 照样记进历史；数 `/` 的请求按路径恰好是 `/` 数（`hits('/')` 是前缀匹配，什么都算）。会话给显式标题（缺省标题
 * 会让自动起标题的 hook 抢走脚本里的轮次）。⌘Y / Ctrl+H 打不到（CDP 的按键不经过浏览器的快捷键），只在单测里钉。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import {
  browserShellPane,
  browserWallPane,
  historyPagePane,
  sidebarPane,
  type BrowserShellPane,
  type BrowserWallPane,
  type HistoryPagePane
} from '../../harness/pages'
import {
  BROWSER_TOOL_NAMES,
  browserDriver,
  browserTool,
  startFixtureServer,
  type BrowserDriver,
  type FixtureServer
} from '../../harness/browserFixtures'

const MODEL = 'e2e-model'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()
const SESSION_TITLE = 'BH history agent'

interface TabRow {
  id: string
  url: string
  active: boolean
  loading: boolean
  internalPage?: string
}

interface HistoryItemRow {
  key: string
  day: string
  url: string
  count: number
  sessionId?: string
  sessionTitle?: string
}

interface HistoryListResult {
  items: HistoryItemRow[]
  next: number | null
}

interface HistorySuggestionRow {
  url: string
  visitCount: number
  typedCount: number
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let fixture: FixtureServer
let driver: BrowserDriver
let bw: CdpClient
let wall: BrowserWallPane
let shell: BrowserShellPane
let historyPage: HistoryPagePane
let sid = ''
/** BH-E1 用户开的那个 tab（之后一直是它选中，直到打开历史记录页） */
let userTab = ''
let hostPort = ''
let counterUrl = ''
let formUrl = ''
let rootUrl = ''

// ─── IPC 助手 ───

const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
/** 历史记录页的一页 —— 在浏览器窗口外壳上问（只认它） */
const historyList = (query: Record<string, unknown>): Promise<HistoryListResult> =>
  bw.eval<HistoryListResult>(`window.api.browserHistory.list(${JSON.stringify(query)})`)
/** 地址栏建议的历史候选 —— 在浏览器窗口外壳上问 */
const historySuggest = (text: string): Promise<HistorySuggestionRow[]> =>
  bw.eval<HistorySuggestionRow[]>(`window.api.browserHistory.suggest(${JSON.stringify(text)})`)
/** 夹具上路径恰好是 `/` 的请求数 */
const rootHits = (): number => fixture.requests().filter((r) => r.path === '/').length

/** 本地日期 YYYY-MM-DD（与历史记录页的「天」同一个口径） */
function localDay(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 建一条勾了 mcp:browser 的会话并让运行时起来，回会话 id */
async function tickedSession(title: string): Promise<string> {
  const id = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title })}).then((s) => s.id)`
  )
  const wrote = await app.main.eval<{ success: boolean }>(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id, enabledTools: ['mcp:browser'] })})`
  )
  expect(wrote.success).toBe(true)
  const info = await app.main.eval<{ tools: Array<{ name: string }> } | null>(
    `window.api.agent.getInfo(${JSON.stringify(id)}, { ensure: true })`
  )
  const browserTools = (info?.tools ?? [])
    .map((t) => t.name)
    .filter((n) => n.startsWith('mcp__browser__'))
    .sort()
  expect(browserTools).toEqual(ALL_BROWSER_TOOLS)
  return id
}

/**
 * 反复读、直到断言全过；超时就把最后一次读数连同失败的断言一起抛出来（导航提交、记历史、布局都是异步的）。
 */
async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => void,
  what: string,
  timeoutMs = 15_000
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const value = await read()
    try {
      check(value)
      return value
    } catch (err) {
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `${what}: ${(err as Error).message}\nlast reading: ${JSON.stringify(value)}`
        )
      }
    }
    await sleep(200)
  }
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  fixture = await startFixtureServer()
  driver = browserDriver({ main: app.main, provider, events })
  hostPort = fixture.origin.replace(/^http:\/\//, '')
  counterUrl = fixture.url('/counter.html?bh=user')
  formUrl = fixture.url('/form.html?bh=agent')
  rootUrl = fixture.url('/')

  // 搜索建议关掉：地址栏打字时不向真的搜索引擎发请求（浏览器窗口挂载时读，所以在开窗之前写）
  await app.main.eval("window.api.settings.set({ key: 'browser.searchSuggest', value: 'false' })")

  await app.main.eval('window.api.browserView.openWindow()')
  await until(
    () => app.main.eval<boolean>('window.api.browserView.isWindowOpen()'),
    'browser window open'
  )
  bw = await until(() => app.browserWindow(), 'browser window page')
  wall = browserWallPane(bw)
  shell = browserShellPane(bw)
  historyPage = historyPagePane(bw)
  await until(() => wall.mounted(), 'browser window shell mounted')
  expect(await wall.viewMode()).toBe('single')

  sid = await tickedSession(SESSION_TITLE)
}, 120_000)

afterAll(async () => {
  bw?.close()
  await provider?.close()
  await fixture?.close()
  await app?.stop()
})

describe('用户的访问进地址栏建议，agent 的只进历史（BH-E1）', () => {
  it('BH-E1 用户从地址栏去计数页、agent open_tab 表单页：agent 过滤只有表单页（带会话）、用户过滤没有它；建议里只有用户的；主窗口问什么都是空的', async () => {
    // ── 用户：+ → 地址栏敲地址 + Enter ──
    await shell.clickNewTab()
    const fresh = await eventually(
      () => listTabs(),
      (list) => {
        expect(list).toHaveLength(1)
        expect(list[0]).toMatchObject({ active: true, url: 'about:blank' })
      },
      'a new selected blank tab'
    )
    userTab = fresh[0].id
    await eventually(
      () => shell.omniboxInput(),
      (input) => expect(input).toMatchObject({ value: '', focused: true }),
      'omnibox input focused on the new tab'
    )
    // 不等新 tab 自己那次 about:blank 提交完就打字、回车（harness 比真人快）：那次不记的提交不能用掉地址栏的
    // typed 标记，否则这一访问记成 link、BH-E2 的内联补全就没有了
    await shell.typeInOmnibox(`${hostPort}/counter.html?bh=user`)
    await shell.pressInOmnibox('Enter')
    await until(() => fixture.hits('/counter.html?bh=user') === 1, 'typed navigation requested')
    await eventually(
      () => listTabs(),
      (list) => expect(list.find((t) => t.active)).toMatchObject({ id: userTab, url: counterUrl }),
      'user tab on the typed address'
    )

    // ── agent：open_tab 表单页 ──
    provider.reset()
    const opened = await driver.run(sid, [
      { id: 'bhe1_open', tool: 'open_tab', args: { url: formUrl } }
    ])
    expect(opened.ends.bhe1_open?.isError, opened.ends.bhe1_open?.result).toBe(false)
    await until(() => fixture.hits('/form.html?bh=agent') === 1, 'agent page requested')

    // ── 历史（浏览器窗口外壳上问）──
    const agentRows = await eventually(
      () => historyList({ actor: 'agent' }),
      (page) => expect(page.items.map((i) => i.url)).toEqual([formUrl]),
      'agent history = the form page only'
    )
    expect(agentRows.items[0]).toMatchObject({
      url: formUrl,
      sessionId: sid,
      sessionTitle: SESSION_TITLE,
      count: 1,
      day: localDay()
    })
    expect(agentRows.next).toBeNull()

    const userRows = await eventually(
      () => historyList({ actor: 'user' }),
      (page) => expect(page.items.map((i) => i.url)).toContain(counterUrl),
      'user history has the counter page'
    )
    expect(userRows.items.map((i) => i.url)).not.toContain(formUrl)
    const counterRow = userRows.items.find((i) => i.url === counterUrl)!
    expect(counterRow).not.toHaveProperty('sessionId')
    expect(counterRow).not.toHaveProperty('sessionTitle')

    // ── 地址栏建议：只有用户自己去过的 ──
    const suggested = await historySuggest('127.0.0.1')
    expect(suggested.map((s) => s.url)).toContain(counterUrl)
    expect(suggested.map((s) => s.url)).not.toContain(formUrl)
    expect(suggested.find((s) => s.url === counterUrl)).toMatchObject({
      visitCount: 1,
      typedCount: 1
    })
    expect(await historySuggest('bh=agent')).toEqual([])

    // ── 主窗口问：只认浏览器窗口外壳，回空 ──
    expect(await app.main.eval<HistoryListResult>('window.api.browserHistory.list({})')).toEqual({
      items: [],
      next: null
    })
    expect(await app.main.eval<unknown[]>("window.api.browserHistory.suggest('127')")).toEqual([])
  }, 120_000)
})

describe('内联补全与历史记录页（BH-E2）', () => {
  it('BH-E2 打 127.0 → 补成主机名、补上的选中、第一行是站点首页；Enter 去 /；⋮ → 历史记录页：今天这组里两行是用户的、表单页带会话标签；agent 看不到它；点标签 → 主窗口切到那条会话', async () => {
    if ((await listTabs()).find((t) => t.active)?.id !== userTab) await shell.clickTab(userTab)
    await eventually(
      () => listTabs(),
      (list) => expect(list.find((t) => t.active)?.id).toBe(userTab),
      'user tab selected'
    )

    // ── 可信输入打 127.0：内联补全 ──
    await shell.beginOmniboxEdit()
    const typed = await shell.typeInOmniboxTrusted('127.0')
    expect(typed).toEqual({
      value: hostPort,
      selectionStart: 5,
      selectionEnd: hostPort.length
    })
    // 下拉要等页面区的截图顶上才开
    const rows = await eventually(
      () => shell.omniboxPopupRows(),
      (r) => expect(r.length).toBeGreaterThan(0),
      'omnibox popup rows'
    )
    expect(rows[0]).toEqual({ kind: 'url', key: `url:${rootUrl}`, selected: true })

    // ── Enter：去站点首页（夹具回 404，照样是一次提交的导航）──
    const before = rootHits()
    await shell.pressInOmnibox('Enter')
    await until(() => rootHits() === before + 1, 'site root requested')
    await eventually(
      () => listTabs(),
      (list) => expect(list.find((t) => t.id === userTab)?.url).toBe(rootUrl),
      'user tab on the site root'
    )
    await eventually(
      () => historyList({ actor: 'user' }),
      (page) => expect(page.items.map((i) => i.url)).toContain(rootUrl),
      'site root recorded as a user visit'
    )

    // ── ⋮ → 历史记录 ──
    const menu = await shell.moreMenu('history')
    expect(menu.map((it) => it.id)).toContain('history')
    const historyTab = await eventually(
      () => listTabs(),
      (list) =>
        expect(list.find((t) => t.active)).toMatchObject({
          url: 'shuvix://history',
          internalPage: 'history'
        }),
      'history tab selected'
    )
    const historyTabId = historyTab.find((t) => t.active)!.id
    expect(historyTabId).not.toBe(userTab)

    // ── 页面：今天这一组 ──
    await until(() => historyPage.present(), 'history page mounted')
    const today = localDay()
    const items = await eventually(
      () => historyPage.items(),
      (list) => {
        const urls = list.map((i) => i.url)
        expect(urls).toContain(rootUrl)
        expect(urls).toContain(counterUrl)
        expect(urls).toContain(formUrl)
      },
      'history page lists the three visits'
    )
    expect(await historyPage.days()).toContain(today)
    for (const url of [rootUrl, counterUrl]) {
      expect(items.find((i) => i.url === url)).toMatchObject({
        day: today,
        sessionId: null,
        agentChip: null
      })
    }
    expect(items.find((i) => i.url === formUrl)).toMatchObject({
      day: today,
      sessionId: sid,
      agentChip: SESSION_TITLE
    })

    // ── agent 的 list_tabs 里没有历史记录页 ──
    provider.reset()
    const listed = await driver.run(sid, [{ id: 'bhe2_list', tool: 'list_tabs', args: {} }])
    expect(listed.ends.bhe2_list?.isError, listed.ends.bhe2_list?.result).toBe(false)
    expect(listed.ends.bhe2_list.result).not.toContain('shuvix://history')
    expect(listed.ends.bhe2_list.result).toContain(formUrl)

    // ── 点会话标签：主窗口切到那条会话 ──
    const sidebar = sidebarPane(app.main)
    expect(await sidebar.activeTitle()).not.toBe(SESSION_TITLE)
    await historyPage.clickAgentChip(sid)
    await until(
      async () => (await sidebar.activeTitle()) === SESSION_TITLE,
      'main window switched to the agent session'
    )
  }, 120_000)
})
