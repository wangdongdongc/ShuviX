/**
 * 地址栏的站点信息气泡（2026-10-16，Chrome 的 page info）：连接状态、这页的 cookie 与「删除此网站的数据」、
 * 「网站设置」。气泡是 DOM 弹层、原生页面画在它上面，所以开着时页面区换成截图（`[data-page-cover]`）。
 * 夹具网站记下每一个请求（连同请求带的 Cookie 头）。一个实例按顺序走：
 *
 *   BS-E7  夹具页（http，写一个 cookie）上点站点信息按钮：气泡开出来，连接是 insecure，cookie 数与 IPC
 *          `browserData.siteInfo` 一致；开着时页面区有一张 `data:` 截图；Esc 关掉气泡并撤掉截图；
 *   BS-E8  删除此网站的数据 → 确认：页面重新加载（夹具 +1），那次加载的请求**没带**被删的 cookie，气泡关掉；
 *          再开气泡 → 网站设置 → 设置页被选中，网站数据的搜索框是 `127.0.0.1`（主机名，不含端口），那一行在。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { waitRendererReady } from '../../harness/seed'
import {
  browserSettingsPagePane,
  browserSiteInfoPane,
  browserWallPane,
  type BrowserSettingsPagePane,
  type BrowserSiteInfoPane,
  type BrowserWallPane
} from '../../harness/pages'
import {
  FIXTURE_COOKIE,
  startFixtureServer,
  type FixtureServer
} from '../../harness/browserFixtures'

interface TabRow {
  id: string
  url: string
  active: boolean
  internalPage?: string
}

const PAGE = '/form.html?bs=site-info'

let app: E2EApp
let fixture: FixtureServer
let bw: CdpClient
let wall: BrowserWallPane
let siteInfo: BrowserSiteInfoPane
let page: BrowserSettingsPagePane
let tab = ''

const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const selectedId = async (): Promise<string | undefined> =>
  (await listTabs()).find((t) => t.active)?.id
const ipcSiteInfo = (url: string): Promise<{ cookieCount: number; certException: boolean }> =>
  app.main.eval(`window.api.browserData.siteInfo(${JSON.stringify(url)})`)

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  fixture = await startFixtureServer()
  await app.main.eval('window.api.browserView.openWindow()')
  await until(
    () => app.main.eval<boolean>('window.api.browserView.isWindowOpen()'),
    'browser window open'
  )
  bw = await until(() => app.browserWindow(), 'browser window page')
  wall = browserWallPane(bw)
  siteInfo = browserSiteInfoPane(bw)
  page = browserSettingsPagePane(bw)
  await until(() => wall.mounted(), 'browser window shell mounted')
}, 120_000)

afterAll(async () => {
  bw?.close()
  await fixture?.close()
  await app?.stop()
})

describe('站点信息气泡（BS-E7 / BS-E8）', () => {
  it('BS-E7 夹具页：气泡开出来（insecure、cookie 数与 IPC 一致），开着时页面区是 data: 截图；Esc 关掉、撤掉截图', async () => {
    const url = fixture.url(PAGE)
    tab = await app.main.eval<string>(`window.api.browserView.createTab(${JSON.stringify(url)})`)
    await until(() => fixture.hits(PAGE) === 1, 'fixture page requested')
    await until(async () => (await selectedId()) === tab, 'fixture tab selected')
    await until(
      async () => (await ipcSiteInfo(url)).cookieCount > 0,
      'fixture cookie stored for this page'
    )
    await until(async () => (await wall.singlePageTabId()) === tab, 'page area shows the tab')
    // 页面刚挂进页面区的头几帧 capturePage 会回一张空图（气泡照开，只是页面区那段时间空着 —— 产品接受的退路）：
    // 先等它真的画出来，才断得了「开着时页面区是截图」
    await until(
      () =>
        bw.eval<boolean>(
          `window.api.browserView.capture(${JSON.stringify(tab)}, 64).then((s) => s.length > 0)`
        ),
      'the page has rendered a frame'
    )
    await until(() => siteInfo.buttonPresent(), 'site-info button in the omnibox')
    expect(await siteInfo.bubble()).toBeNull()
    expect(await siteInfo.coverSrc()).toBeNull()

    await siteInfo.clickButton()
    const bubble = await until(siteInfo.bubble, 'site-info bubble open')
    expect(bubble.connection).toBe('insecure')
    expect(bubble.host).toBe(new URL(url).host)
    const expected = (await ipcSiteInfo(url)).cookieCount
    expect(expected).toBeGreaterThan(0)
    await until(
      async () => (await siteInfo.bubble())?.cookies === String(expected),
      `bubble shows ${expected} cookie(s)`
    )
    const src = await until(siteInfo.coverSrc, 'page cover while the bubble is open')
    expect(src.startsWith('data:image/')).toBe(true)

    await siteInfo.pressEscape()
    await until(async () => (await siteInfo.bubble()) === null, 'bubble closed by Escape')
    await until(async () => (await siteInfo.coverSrc()) === null, 'page cover removed')
    expect(await wall.singlePageTabId()).toBe(tab)
  }, 90_000)

  it('BS-E8 删除此网站的数据：重新加载（夹具 +1、那次请求没带 cookie）、气泡关掉；网站设置 → 设置页，搜索框 127.0.0.1、那一行在', async () => {
    expect(tab).not.toBe('')
    const url = fixture.url(PAGE)
    const before = fixture.hits(PAGE)
    // 这一页此刻确实带着 cookie（对照组：之后那次重新加载才看得出「没带」）
    expect((await ipcSiteInfo(url)).cookieCount).toBeGreaterThan(0)

    await siteInfo.clickButton()
    await until(async () => {
      const b = await siteInfo.bubble()
      return !!b && b.cookies !== '' && b.cookies !== '0'
    }, 'bubble open with cookies')
    await siteInfo.clearData()

    await until(() => fixture.hits(PAGE) === before + 1, 'page reloaded after deleting its data')
    const reload = fixture.requests().filter((r) => r.path === PAGE)[before]
    expect(reload.cookie).not.toContain(`${FIXTURE_COOKIE}=`)
    await until(async () => (await siteInfo.bubble()) === null, 'bubble closed after delete')
    await until(async () => (await siteInfo.coverSrc()) === null, 'page cover removed')
    // 重新加载那一页又写了一个 cookie（夹具每次都写）—— 网站数据里于是又有 127.0.0.1
    await until(async () => (await ipcSiteInfo(url)).cookieCount > 0, 'cookie set again on reload')

    // ── 网站设置 ──
    await siteInfo.clickButton()
    await until(siteInfo.bubble, 'bubble open again')
    await siteInfo.openSiteSettings()
    await until(async () => {
      const row = (await listTabs()).find((t) => t.active)
      return row?.internalPage === 'settings'
    }, 'settings tab selected')
    const shot = await until(async () => {
      const x = await page.shot()
      return x.present && x.siteSearch === '127.0.0.1' && x.sites.length > 0 ? x : null
    }, 'settings page filtered to 127.0.0.1')
    expect(shot.sites.map((r) => r.host)).toContain('127.0.0.1')
    expect(await siteInfo.bubble()).toBeNull()
    expect(await siteInfo.coverSrc()).toBeNull()
  }, 90_000)
})
