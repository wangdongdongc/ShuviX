/**
 * 浏览器窗口的内部页面 `shuvix://settings`（2026-10-16）：一个 webContents 只是 about:blank 占位、页面本身是
 * 外壳 DOM 的 tab —— 用户开它、用户把一个 tab 变成它，agent 一律看不见它（假提供商脚本化；夹具网站记下每一个
 * 请求）。一个实例按顺序走：
 *
 *   BS-E4  ⋮ → 设置：开出设置页并选中它（标签条上写 Settings）；从别的 tab 再来一次 → 还是那一个 id、被选中、
 *          tab 数不变；
 *   BS-E5  勾了 mcp:browser 的会话：list_tabs 里没有 shuvix:// 那一行（也没有它的 uuid）；拿设置页的 uuid 去
 *          snapshot / close_tab → 「No browser tab」，设置页还在；
 *   BS-E6  在夹具网站的 tab 上往地址栏敲 shuvix://settings：同一个 tab（id 不变）变成设置页、agent 的 list_tabs
 *          不再列它；再敲夹具地址 → 变回网页（夹具多收到一次请求），agent 的 list_tabs 以同一个短号重新列出它。
 *
 * 会话给显式标题（缺省标题会让自动起标题的 hook 抢走脚本里的轮次）。界面文字按三语候选认。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { eventRecorder, seedFakeProvider, waitRendererReady } from '../../harness/seed'
import {
  browserSettingsPagePane,
  browserShellPane,
  browserWallPane,
  type BrowserSettingsPagePane,
  type BrowserShellPane,
  type BrowserWallPane
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
const SETTINGS_URL = 'shuvix://settings'
/** 设置页标签的名字（三语） */
const SETTINGS_LABELS = ['Settings', '设置', '設定']

interface TabRow {
  id: string
  url: string
  active: boolean
  internalPage?: string
}

let app: E2EApp
let provider: FakeProvider
let fixture: FixtureServer
let driver: BrowserDriver
let bw: CdpClient
let shell: BrowserShellPane
let wall: BrowserWallPane
let page: BrowserSettingsPagePane
/** 勾了 mcp:browser 的会话 */
let sid = ''
/** BS-E4 开出来的设置页 */
let settingsTab = ''

// ─── IPC 助手 ───

const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const createTab = (url: string): Promise<string> =>
  app.main.eval<string>(`window.api.browserView.createTab(${JSON.stringify(url)})`)
const closeTab = (id: string): Promise<unknown> =>
  app.main.eval(`window.api.browserView.closeTab(${JSON.stringify(id)})`)
const selectedId = async (): Promise<string | undefined> =>
  (await listTabs()).find((t) => t.active)?.id
const settingsRows = async (): Promise<TabRow[]> =>
  (await listTabs()).filter((t) => t.internalPage === 'settings')

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
  const tools = (info?.tools ?? [])
    .map((t) => t.name)
    .filter((n) => n.startsWith('mcp__browser__'))
    .sort()
  expect(tools).toEqual(ALL_BROWSER_TOOLS)
  return id
}

/** agent 的 list_tabs 正文 */
async function agentListTabs(tag: string): Promise<string> {
  provider.reset()
  const run = await driver.run(sid, [{ id: tag, tool: 'list_tabs', args: {} }])
  expect(run.ends[tag]?.isError, run.ends[tag]?.result).toBe(false)
  return run.ends[tag].result
}

/** list_tabs 里某个地址那一行的短号；没有回 null */
function shortForUrl(listed: string, url: string): string | null {
  const line = listed.split('\n').find((l) => l.endsWith(` — ${url}`))
  return /^\[(t\d+)\]/.exec(line ?? '')?.[1] ?? null
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  const events = eventRecorder(app.main)
  await events.install()
  fixture = await startFixtureServer()
  driver = browserDriver({ main: app.main, provider, events })

  await app.main.eval('window.api.browserView.openWindow()')
  await until(
    () => app.main.eval<boolean>('window.api.browserView.isWindowOpen()'),
    'browser window open'
  )
  bw = await until(() => app.browserWindow(), 'browser window page')
  shell = browserShellPane(bw)
  wall = browserWallPane(bw)
  page = browserSettingsPagePane(bw)
  await until(() => wall.mounted(), 'browser window shell mounted')
}, 120_000)

afterAll(async () => {
  bw?.close()
  await provider?.close()
  await fixture?.close()
  await app?.stop()
})

describe('⋮ → 设置（BS-E4）', () => {
  it('BS-E4 开出设置页并选中（标签条写 Settings）；从别的 tab 再来一次 → 同一个 id 被选中、tab 数不变', async () => {
    const a = await createTab(fixture.url('/counter.html?bs=e4'))
    await until(async () => (await selectedId()) === a, 'fixture tab selected')
    expect(await settingsRows()).toEqual([])

    await shell.moreMenu('settings')
    const rows = await until(async () => {
      const list = await settingsRows()
      return list.length === 1 && list[0].active ? list : null
    }, 'settings tab opened and selected')
    settingsTab = rows[0].id
    expect(rows[0].url).toBe(SETTINGS_URL)
    await until(async () => (await page.shot()).present, 'settings page shown')
    expect(await wall.selectedTabIds()).toEqual([settingsTab])
    const label = await shell.tabLabel(settingsTab)
    expect(SETTINGS_LABELS, `tab label: ${label}`).toContain(label)
    expect(await shell.omniboxDisplay()).toBe(SETTINGS_URL)

    await shell.clickTab(a)
    await until(async () => (await selectedId()) === a, 'back on the fixture tab')
    const count = (await listTabs()).length
    await shell.moreMenu('settings')
    await until(async () => (await selectedId()) === settingsTab, 'same settings tab selected')
    expect((await settingsRows()).map((t) => t.id)).toEqual([settingsTab])
    expect(await listTabs()).toHaveLength(count)
    await closeTab(a)
  }, 90_000)
})

describe('agent 看不见设置页（BS-E5）', () => {
  beforeAll(async () => {
    sid = await tickedSession('BS internal pages agent')
  }, 60_000)

  it('BS-E5 list_tabs 里没有 shuvix:// 与它的 uuid；拿它的 uuid 去 snapshot / close_tab → No browser tab，设置页还在', async () => {
    expect(settingsTab).not.toBe('')
    const visible = await createTab(fixture.url('/counter.html?bs=e5'))
    await until(
      async () =>
        (await listTabs()).find((r) => r.id === visible)?.url ===
        fixture.url('/counter.html?bs=e5'),
      'fixture page committed'
    )
    const listed = await agentListTabs('bse5_list')
    expect(listed).not.toContain('shuvix://')
    expect(listed).not.toContain(settingsTab)
    expect(shortForUrl(listed, fixture.url('/counter.html?bs=e5'))).not.toBeNull()

    provider.reset()
    const run = await driver.run(sid, [
      { id: 'bse5_snap', tool: 'snapshot', args: { tabId: settingsTab } },
      { id: 'bse5_close', tool: 'close_tab', args: { tabId: settingsTab } }
    ])
    for (const id of ['bse5_snap', 'bse5_close']) {
      expect(run.ends[id]?.isError, `${id}: ${run.ends[id]?.result}`).toBe(true)
      expect(run.ends[id].result).toContain(`No browser tab "${settingsTab}"`)
    }
    expect((await settingsRows()).map((t) => t.id)).toEqual([settingsTab])
    await closeTab(visible)
  }, 90_000)
})

describe('地址栏把一个 tab 变成设置页、再变回来（BS-E6）', () => {
  it('BS-E6 敲 shuvix://settings：同一个 tab 变成设置页、agent 不再列它；敲回夹具地址：夹具 +1、以同一个短号重新列出', async () => {
    // 先关掉 BS-E4 的设置页：本用例只看「地址栏变出来的那一个」
    await closeTab(settingsTab)
    await until(async () => (await settingsRows()).length === 0, 'settings tab closed')

    const url = fixture.url('/counter.html?bs=e6')
    const t = await createTab(url)
    await until(() => fixture.hits('/counter.html?bs=e6') === 1, 'fixture page requested once')
    await until(async () => (await selectedId()) === t, 'fixture tab selected')
    await until(
      async () => (await listTabs()).find((r) => r.id === t)?.url === url,
      'fixture page committed'
    )
    const short = shortForUrl(await agentListTabs('bse6_before'), url)
    expect(short).not.toBeNull()
    const count = (await listTabs()).length

    // ── 地址栏：shuvix://settings ──
    await until(async () => (await shell.omniboxDisplay()) === url, 'omnibox shows the page')
    await shell.beginOmniboxEdit()
    await shell.typeInOmnibox(SETTINGS_URL)
    await shell.pressInOmnibox('Enter')
    await until(async () => {
      const row = (await listTabs()).find((r) => r.id === t)
      return row?.internalPage === 'settings' && row.url === SETTINGS_URL
    }, 'the same tab turned into the settings page')
    expect(await listTabs()).toHaveLength(count)
    expect(await selectedId()).toBe(t)
    await until(async () => (await page.shot()).present, 'settings page shown')
    await until(
      async () => (await shell.omniboxDisplay()) === SETTINGS_URL,
      'omnibox shows shuvix://settings'
    )
    const hidden = await agentListTabs('bse6_hidden')
    expect(hidden).not.toContain(url)
    expect(hidden).not.toContain('shuvix://')
    expect(hidden).not.toContain(`[${short}]`)

    // ── 地址栏：夹具地址 → 变回网页 ──
    await shell.beginOmniboxEdit()
    await shell.typeInOmnibox(url)
    await shell.pressInOmnibox('Enter')
    await until(() => fixture.hits('/counter.html?bs=e6') === 2, 'fixture page requested again')
    await until(async () => {
      const row = (await listTabs()).find((r) => r.id === t)
      return !!row && row.internalPage === undefined && row.url === url
    }, 'the tab is a web page again')
    await until(async () => !(await page.shot()).present, 'settings page gone')
    const back = await agentListTabs('bse6_back')
    expect(shortForUrl(back, url)).toBe(short)
    expect(back).not.toContain('shuvix://')
  }, 120_000)
})
