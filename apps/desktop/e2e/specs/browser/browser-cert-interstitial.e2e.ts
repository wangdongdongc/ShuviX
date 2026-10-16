/**
 * 证书错误是 Chrome 的整页警告、从不弹框（2026-10-16）：一台现场用 openssl 签的自签名 https 夹具
 * （`127.0.0.1`，记下每一个到了 HTTP 层的请求）。没有 openssl 的机器上整个跳过。
 *
 *   BS-E9  createTab 到 https 夹具：页面区是 `[data-cert-interstitial="127.0.0.1:<port>"]`，服务器一个 HTTP 请求都
 *          没收到（TLS 握手就被拒了）；**从主窗口**调 proceedUnsafe(tabId) → false，certExceptions() 仍是 []；在浏览器
 *          窗口里点 Advanced → Proceed → 页面加载（服务器收到请求），certExceptions() = ['127.0.0.1']；第二个去同一
 *          主机（同端口另一条路径）的 tab 直接加载；站点信息气泡写着「你关掉了这个站点的证书警告」；设置页的
 *          「放行过的网站」写着 127.0.0.1。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { waitRendererReady } from '../../harness/seed'
import {
  browserCertInterstitialPane,
  browserSettingsPagePane,
  browserShellPane,
  browserSiteInfoPane,
  browserWallPane
} from '../../harness/pages'
import {
  opensslAvailable,
  startSelfSignedHttpsServer,
  type HttpsFixtureServer
} from '../../harness/browserFixtures'

interface TabRow {
  id: string
  url: string
  active: boolean
  internalPage?: string
}

/** 站点信息气泡里「你关掉了这个站点的证书警告」（三语） */
const CERT_EXCEPTION_LINE = [
  'You turned off certificate warnings for this site',
  '你已让这个网站跳过证书检查',
  'このサイトの証明書の警告をオフにしました'
]

const HAS_OPENSSL = opensslAvailable()

let app: E2EApp
let https: HttpsFixtureServer
let bw: CdpClient

const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const selectedId = async (): Promise<string | undefined> =>
  (await listTabs()).find((t) => t.active)?.id
const createTab = (url: string): Promise<string> =>
  app.main.eval<string>(`window.api.browserView.createTab(${JSON.stringify(url)})`)
const certExceptions = (): Promise<string[]> =>
  app.main.eval<string[]>('window.api.browserData.certExceptions()')

describe.skipIf(!HAS_OPENSSL)('证书警告页（BS-E9，需要 openssl 签自签名证书）', () => {
  beforeAll(async () => {
    https = await startSelfSignedHttpsServer()
    app = await launchApp()
    await waitRendererReady(app.main)
    await app.main.eval('window.api.browserView.openWindow()')
    await until(
      () => app.main.eval<boolean>('window.api.browserView.isWindowOpen()'),
      'browser window open'
    )
    bw = await until(() => app.browserWindow(), 'browser window page')
    await until(() => browserWallPane(bw).mounted(), 'browser window shell mounted')
  }, 120_000)

  afterAll(async () => {
    bw?.close()
    await app?.stop()
    await https?.close()
  })

  it('BS-E9 整页警告、服务器没收到请求；主窗口调 proceedUnsafe 无效；浏览器窗口里 Advanced → Proceed 才放行（只放主机名）；同主机的新 tab 直接加载；气泡与设置页都写着它', async () => {
    const shell = browserShellPane(bw)
    const wall = browserWallPane(bw)
    const cert = browserCertInterstitialPane(bw)
    const siteInfo = browserSiteInfoPane(bw)
    const page = browserSettingsPagePane(bw)
    const hostPort = `127.0.0.1:${https.port}`
    expect(await certExceptions()).toEqual([])

    // ── 整页警告，TLS 握手就被拒了 ──
    const one = https.url('/one')
    const t1 = await createTab(one)
    await until(async () => (await selectedId()) === t1, 'https tab selected')
    await until(async () => (await cert.host()) === hostPort, 'certificate warning shown')
    expect(await cert.proceedVisible()).toBe(false)
    expect(await wall.singlePageTabId()).toBeNull()
    expect(https.requests()).toEqual([])

    // ── 主窗口调 proceedUnsafe：不认（只认浏览器窗口外壳）──
    expect(
      await app.main.eval<boolean>(`window.api.browserView.proceedUnsafe(${JSON.stringify(t1)})`)
    ).toBe(false)
    expect(await certExceptions()).toEqual([])
    expect(await cert.host()).toBe(hostPort)
    expect(https.requests()).toEqual([])

    // ── 浏览器窗口里：Advanced → Proceed ──
    await cert.clickAdvanced()
    await until(() => cert.proceedVisible(), 'proceed link after Advanced')
    await cert.clickProceed()
    await until(() => https.hits('/one') >= 1, 'page requested after proceeding')
    await until(async () => (await cert.host()) === null, 'warning gone')
    await until(async () => (await wall.singlePageTabId()) === t1, 'page area shows the page')
    expect(await certExceptions()).toEqual(['127.0.0.1'])

    // ── 同主机的第二个 tab：直接加载，不再警告 ──
    const two = https.url('/two')
    const t2 = await createTab(two)
    await until(async () => (await selectedId()) === t2, 'second https tab selected')
    await until(() => https.hits('/two') === 1, 'second page requested directly')
    await until(async () => (await wall.singlePageTabId()) === t2, 'second page shown')
    expect(await cert.host()).toBeNull()

    // ── 站点信息气泡：「你关掉了这个站点的证书警告」──
    expect(
      (
        await app.main.eval<{ certException: boolean }>(
          `window.api.browserData.siteInfo(${JSON.stringify(two)})`
        )
      ).certException
    ).toBe(true)
    await until(() => siteInfo.buttonPresent(), 'site-info button')
    await siteInfo.clickButton()
    const bubble = await until(async () => {
      const b = await siteInfo.bubble()
      return b && CERT_EXCEPTION_LINE.some((t) => b.connectionText.includes(t)) ? b : null
    }, 'bubble names the certificate exception')
    expect(bubble.host).toBe(hostPort)
    await siteInfo.pressEscape()
    await until(async () => (await siteInfo.bubble()) === null, 'bubble closed')

    // ── 设置页的「放行过的网站」──
    await shell.moreMenu('settings')
    await until(async () => {
      const row = (await listTabs()).find((t) => t.active)
      return row?.internalPage === 'settings'
    }, 'settings tab selected')
    await until(
      async () => (await page.shot()).certExceptionsText === '127.0.0.1',
      'settings page lists 127.0.0.1 under allowed sites'
    )
  }, 120_000)
})
