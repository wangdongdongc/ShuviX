/**
 * 地址栏的站点信息气泡（2026-10-16，Chrome 的 page info）：连接状态、这页的 cookie 与「删除此网站的数据」、
 * 「网站设置」。气泡渲染在页面上方的透明 view 里，页面不受影响（BS-E7 钉它的视口与 document.hidden 不变）。
 * 夹具网站记下每一个请求（连同请求带的 Cookie 头）。一个实例按顺序走：
 *
 *   BS-E7  夹具页（http，写一个 cookie）上点站点信息按钮：气泡开出来，连接是 insecure，cookie 数与 IPC
 *          `browserData.siteInfo` 一致；开着时弹层文档的主题与外壳一样；页面从开到关一直没被动过（视口、可见性都没变，
 *          resize / visibilitychange 一次都没发）；Esc 关掉气泡；
 *   BS-E8  删除此网站的数据 → 确认：页面重新加载（夹具 +1），那次加载的请求**没带**被删的 cookie，气泡关掉；
 *   SD-E2  IPC `siteInfo(url).site` 是网站数据的分组键 `127.0.0.1`；再开气泡 → 网站设置 → 设置页被选中、直接是
 *          `127.0.0.1` 的站点详情（`[data-site-details="127.0.0.1"]`，读出了那个 cookie）；返回 → 网站列表，搜索框是
 *          `127.0.0.1`（主机名，不含端口），那一行在。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { waitRendererReady } from '../../harness/seed'
import {
  browserSettingsPagePane,
  browserSiteDetailsPane,
  browserSiteInfoPane,
  browserWallPane,
  type BrowserSettingsPagePane,
  type BrowserSiteDetailsPane,
  type BrowserSiteInfoPane,
  type BrowserWallPane
} from '../../harness/pages'
import {
  connectTabPage,
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

/** BS-E7：页面自己看到的样子（从开气泡到关气泡都不该变） */
interface PageView {
  width: number
  height: number
  visibility: string
  resizes: number
  visibilityChanges: number
}

let app: E2EApp
let fixture: FixtureServer
let bw: CdpClient
let wall: BrowserWallPane
let siteInfo: BrowserSiteInfoPane
let page: BrowserSettingsPagePane
let details: BrowserSiteDetailsPane
let tab = ''

const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const selectedId = async (): Promise<string | undefined> =>
  (await listTabs()).find((t) => t.active)?.id
const ipcSiteInfo = (
  url: string
): Promise<{ cookieCount: number; certException: boolean; site?: string }> =>
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
  details = browserSiteDetailsPane(bw)
  await until(() => wall.mounted(), 'browser window shell mounted')
}, 120_000)

afterAll(async () => {
  bw?.close()
  await fixture?.close()
  await app?.stop()
})

describe('站点信息气泡（BS-E7 / BS-E8 / SD-E2）', () => {
  it('BS-E7 夹具页：气泡开出来（insecure、cookie 数与 IPC 一致），弹层跟着外壳的主题；页面一动不动；Esc 关掉', async () => {
    const url = fixture.url(PAGE)
    tab = await app.main.eval<string>(`window.api.browserView.createTab(${JSON.stringify(url)})`)
    await until(() => fixture.hits(PAGE) === 1, 'fixture page requested')
    await until(async () => (await selectedId()) === tab, 'fixture tab selected')
    await until(
      async () => (await ipcSiteInfo(url)).cookieCount > 0,
      'fixture cookie stored for this page'
    )
    await until(async () => (await wall.singlePageTabId()) === tab, 'page area shows the tab')
    await until(() => siteInfo.buttonPresent(), 'site-info button in the omnibox')
    expect(await siteInfo.bubble()).toBeNull()

    // 页面自己看到的：视口、可见性，以及从现在起发生过几次 resize / visibilitychange
    const pageClient = await until(
      () => connectTabPage(app.port, (u) => u === url),
      'DevTools connection to the page'
    )
    const pageView = (): Promise<PageView> =>
      pageClient.eval<PageView>(`({
        width: window.innerWidth,
        height: window.innerHeight,
        visibility: document.visibilityState,
        resizes: window.__bsResizes,
        visibilityChanges: window.__bsVisibilityChanges
      })`)
    // 页面刚从停放窗口搬到页面区，那次搬动的 resize 要到下一帧才发：等它发完再开始数
    await pageClient.eval(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    )
    await pageClient.eval(`(() => {
      window.__bsResizes = 0
      window.__bsVisibilityChanges = 0
      window.addEventListener('resize', () => window.__bsResizes++)
      document.addEventListener('visibilitychange', () => window.__bsVisibilityChanges++)
    })()`)
    const before = await pageView()
    expect(before.resizes).toBe(0)
    expect(before.visibilityChanges).toBe(0)

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
    expect(await pageView()).toEqual(before)

    // 弹层的文档是外壳 window.open 出来的，主题从外壳的 <html> 抄过去
    const themes = await bw.eval<{ popover: string | null; shell: string | null }>(`({
      popover: window
        .open('', 'shuvix-browser-popover')
        .document.documentElement.getAttribute('data-theme'),
      shell: document.documentElement.getAttribute('data-theme')
    })`)
    expect(themes.shell).toBeTruthy()
    expect(themes.popover).toBe(themes.shell)

    await siteInfo.pressEscape()
    await until(async () => (await siteInfo.bubble()) === null, 'bubble closed by Escape')
    expect(await wall.singlePageTabId()).toBe(tab)
    expect(await pageView()).toEqual(before)
    pageClient.close()
  }, 90_000)

  it('BS-E8 删除此网站的数据：重新加载（夹具 +1、那次请求没带 cookie）、气泡关掉', async () => {
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
    // 重新加载那一页又写了一个 cookie（夹具每次都写）—— 网站数据里于是又有 127.0.0.1
    await until(async () => (await ipcSiteInfo(url)).cookieCount > 0, 'cookie set again on reload')
  }, 90_000)

  it('SD-E2 siteInfo 带着网站 127.0.0.1；网站设置 → 设置页直接是 127.0.0.1 的详情；返回 → 列表，搜索框 127.0.0.1、那一行在', async () => {
    expect(tab).not.toBe('')
    const url = fixture.url(PAGE)
    const info = await until(async () => {
      const r = await ipcSiteInfo(url)
      return r.cookieCount > 0 ? r : null
    }, 'site info with a cookie')
    // 分组键：主机名，不含端口
    expect(info.site).toBe('127.0.0.1')

    await siteInfo.clickButton()
    // 等气泡问到了 siteInfo（cookie 数出来了）再点：还没回答时点「网站设置」只会落到列表、不进详情
    await until(async () => {
      const b = await siteInfo.bubble()
      return !!b && b.cookies !== '' && b.cookies !== null
    }, 'bubble open with site info answered')
    await siteInfo.openSiteSettings()
    await until(async () => {
      const row = (await listTabs()).find((t) => t.active)
      return row?.internalPage === 'settings'
    }, 'settings tab selected')
    const shot = await until(async () => {
      const x = await details.shot()
      return x.site === '127.0.0.1' && !x.loading && x.cookies.length > 0 ? x : null
    }, 'site details of 127.0.0.1')
    expect(shot.cookies.map((c) => c.name)).toContain(FIXTURE_COOKIE)
    expect(shot.empty).toBe(false)
    expect(await siteInfo.bubble()).toBeNull()
    // 在详情里：网站列表不在
    expect((await page.shot()).sites).toEqual([])

    // ── 返回 → 网站列表，搜索框是主机名（不含端口），那一行在 ──
    await details.back()
    const list = await until(async () => {
      const x = await page.shot()
      return x.present && x.siteSearch === '127.0.0.1' && x.sites.length > 0 ? x : null
    }, 'settings page list filtered to 127.0.0.1')
    expect(list.sites.map((r) => r.site)).toContain('127.0.0.1')
    expect((await details.shot()).site).toBeNull()
  }, 90_000)
})
