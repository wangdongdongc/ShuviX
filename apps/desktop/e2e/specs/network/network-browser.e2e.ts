/**
 * 远程访问与内置浏览器（2026-11-01，shared/browserRemoteUrls.ts）—— 别的设备（网络客户端）调的是桌面窗口那一批
 * `browser-view:*` 通道；修之前 `create-tab('file:///…')` 再 `capture` 就把这台电脑上任意一个文件读成了截图。
 * 现在网络客户端只能让内置浏览器打开 / 退进到 / 重开 / 截图 http(s) 网页、`about:blank` 与 `shuvix://` 内部页面，
 * 拒绝是 `ok:false` + `code 'remote_url_refused'`、消息只说协议；坐在这台电脑前的人（主窗口的 IPC）不受限。
 * 标签页的地址与截图（list-tabs / get-url / capture）归 `admin`，策略能按 scope + access 关掉它们。
 *
 * 一个实例，从外面看：网络客户端是 spec 进程（node）里连 `ws://127.0.0.1:<port>/ws` 的 WebSocket（内置准入放这台电脑），
 * 「桌面那一侧」是主窗口的 `window.api.browserView.*`，页面经 DevTools 的 target 直接读，夹具网站记下每个请求。
 * 「没有本地文件 tab」= `listTabs` 里没有那个 file: 地址的行，DevTools 的 target 里也没有停在它上面的页面。
 *
 * E-1 ws create-tab [file:] → ok:false、remote_url_refused，消息里没有路径 / 文件名；tab 数不变，没有 file: tab
 * E-2 ws create-tab [http 夹具页] → ok:true，listTabs 里有它，夹具网站收到了请求；ws create-tab [] → 空白页；
 *     仍然没有 file: tab
 * E-3 ws navigate [那个 http tab, file:] → ok:false、同一个 code；那个 tab 一直停在原来的网页上
 * E-4 桌面 createTab(file:) 照常：listTabs 有那一行，页面里读得到文件内容
 * E-5 ws capture [file: tab, 800] → ok:false、同一个 code、消息里没有路径；ws capture [http tab, 800] → PNG 的 data URL
 * E-6 桌面在 file: 上开一个 tab、再导航去网页：ws go-back（退回去是 file:）→ ok:false、tab 不动；桌面 goBack → 回到
 *     file:；ws go-forward（进到网页）→ ok:true、回到网页
 * E-7 桌面关掉 file: tab（记下给 ⌘⇧T）：ws reopen-closed-tab → ok:false、没有重开出 file: tab；之后桌面
 *     reopenClosedTab → 重开的就是那个 file:（记录没被网络客户端用掉）
 * E-8 「退一步」核对的就是去的那一条：桌面在 file: 上开 tab、再导航去夹具页，页面自己（没有用户手势）pushState 一条；
 *     ws go-back → 落在没 push 之前的夹具页上（Chromium 的 goBack 会跳过这种条目、落到更早的 file: 上），从头到尾
 *     那个 tab 没显示过 file:
 * web 客户端的浏览器管理页（#browser-manager，2026-11-01）—— web 客户端开在应用自己的浏览器里（openWebClient），
 * 管理页再作为又一个应用浏览器的 tab 开出来（connectTabPage 按 `#browser-manager` 认它）。界面语言先设成 en：
 * E-10 web 客户端顶栏有 [data-open-browser-window]；点它（带手势）→ 开出管理页那个 tab，在标签页一节，行里有桌面
 *      开过的夹具页
 * E-11 管理页开着：桌面 createTab(夹具页) 再导航去另一页 → 管理页的行先出现那个 tab，再换成新地址 / 标题，管理页
 *      没有重新加载（页面上打的记号还在）
 * E-12 记下桌面选中的那页；管理页新建输入框里敲夹具地址 + Open → 多一行、夹具网站收到请求；桌面 listTabs 里它
 *      active:false，选中的还是原来那页
 * E-13 'file:///etc/hosts' + Open → 错误里是本地化的那句（不是 remote_url_refused 这个 code）；没有 /etc/hosts 的行，
 *      listTabs 里也没有它（桌面自己开的 file: tab —— E-7 重开的那个 —— 照样列着）
 * E-14 切到设置 → hash 是 #browser-manager?section=settings，[data-browser-settings-page] 挂着，没有「View history」，
 *      没有 data-headless、没有无头说明
 * E-15 夹具页上写一个值为 NB-COOKIE-VAL 的 Cookie；管理页设置里打开 127.0.0.1 这个网站、展开那条 Cookie → 名字在、
 *      值那一格是说明、页面上没有 NB-COOKIE-VAL；ws browser-data:site-details → ok:true、每个值都是 ''、
 *      cookieValuesHidden: true
 * E-16 桌面开一个夹具页（typed，记成用户的访问）；ws browser-history:list → ok:true、空表（读历史不给别的设备）；
 *      管理页设置里确认「Delete browsing history」→ 浏览器窗口外壳的 browserHistory.list({}) 变空；ws 照样 ok:true、空表
 * E-17 切回标签页一节；桌面开的夹具页那一行点截图开关 → 面板 shown、开关 aria-expanded 'true'、图是 PNG 的 data URL；
 *      再点 → 面板收起
 * E-9 （最后）一份策略拒绝网络客户端 `object.scope == 'browser' && object.access == 'admin'`：list-tabs / get-url /
 *     capture → ok:false、code 'denied'、消息是规则的 prompt；is-window-open（read）与 create-tab（write）照常。
 *     管理页上：写策略之前先点开 E-2 那个网页 tab 一行的截图（shown）；策略生效之后「重新截图」→ 面板 failed、
 *     那一句是「Could not take a screenshot: <规则的 prompt>」—— 在 create-tab 之前做（它触发 tabsChanged，管理页的
 *     行会换成被拒的那一句）
 *
 * 约定同别的 network spec：从不在缺省端口 7766 上打开；所有连接都连 127.0.0.1。tab 总数一直在 12 个以内。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import {
  connectTabPage,
  startFixtureServer,
  type FixtureServer
} from '../../harness/browserFixtures'
import { listTargets, sleep, until, type CdpClient } from '../../harness/cdp'
import { freePort, launchApp, type E2EApp } from '../../harness/launch'
import {
  browserTabs,
  openWebClient,
  removeUserPolicy,
  waitBrowserTab,
  writeUserPolicy,
  type BrowserTab,
  type WebClientHandle
} from '../../harness/networkFixtures'
import {
  browserManagerPane,
  browserSettingsPagePane,
  browserSiteDetailsPane,
  webBrowserButtonPane,
  type BrowserManagerPane,
  type BrowserManagerShot
} from '../../harness/pages'
import { waitRendererReady } from '../../harness/seed'
import { connectWs, type WsClient, type WsResultFrame } from '../../harness/wsClient'

const MARKER = 'NB-SECRET-42'
const REFUSED = 'remote_url_refused'
const POLICY_FILE = 'nb-browser-admin.md'
const POLICY_PROMPT = 'NB-9 tab addresses and screenshots are off for other devices.'

/** 拒绝网络客户端调 browser scope 里 admin 的通道（标签页地址、截图） */
const BROWSER_ADMIN_POLICY = [
  '---',
  'shuvix: policy v1',
  'name: nb-browser-admin',
  'shuvix-displayName: NB browser admin',
  'shuvix-policy-scope:',
  '  subject.kind: [network]',
  '  object.type: [channel]',
  'shuvix-policy-rules:',
  '  - effect: deny',
  '    action: [invoke]',
  `    match: "object.scope == 'browser' && object.access == 'admin'"`,
  `    prompt: ${POLICY_PROMPT}`,
  '---',
  ''
].join('\n')

let app: E2EApp
let ws: WsClient
let fixture: FixtureServer
let secretPath = ''
/** E-1…E-7 的本地文件 */
let FILE = ''
/** E-6 的本地文件（各用各的，断言「停在 file: 上的页面」时互不干扰） */
let FILE6 = ''
/** E-8 的本地文件 */
let FILE8 = ''
/** E-2 网络客户端开的网页 tab */
let httpTab = ''
let HTTP = ''
/** E-4 桌面开的 file: tab */
let fileTab = ''
/** 网络端口（E-10 起开 web 客户端用） */
let netPort = 0
/** E-10 起：web 客户端与浏览器管理页 */
let web: WebClientHandle | undefined
let mgrPage: CdpClient | undefined
let mgr: BrowserManagerPane
const COOKIE_VALUE = 'NB-COOKIE-VAL'

// ─── 小工具 ─────────────────────────────────────────────────────────────

const q = (value: unknown): string => JSON.stringify(value)

const tabs = (): Promise<BrowserTab[]> => browserTabs(app)

const getUrl = (tabId: string): Promise<string> =>
  app.main.eval<string>(`window.api.browserView.getUrl(${q(tabId)})`)

/** 桌面（主窗口）建一个 tab，回它的 id */
const deskCreateTab = (url?: string): Promise<string> =>
  app.main.eval<string>(
    url === undefined
      ? 'window.api.browserView.createTab()'
      : `window.api.browserView.createTab(${q(url)})`
  )

/** 某个 tab 的显示地址等于 `url` */
const waitUrl = (tabId: string, url: string, what: string): Promise<true> =>
  until(async () => (await getUrl(tabId)) === url || null, what)

/** DevTools 里停在 `url` 上的页面 target */
async function targetsAt(url: string): Promise<string[]> {
  return (await listTargets(app.port))
    .filter((t) => t.type === 'page' && t.url === url)
    .map((t) => t.url)
}

/** DevTools 里停在本地文件上的页面（应用自己的窗口也是 file:，按产物目录排除） */
async function fileTargets(): Promise<string[]> {
  return (await listTargets(app.port))
    .filter((t) => t.type === 'page' && t.url.startsWith('file://'))
    .filter((t) => !t.url.includes('/out/renderer'))
    .map((t) => t.url)
}

/** 一个 file: tab 都没有：listTabs 里没有，DevTools 里也没有 */
async function expectNoFileTab(): Promise<void> {
  expect((await tabs()).filter((t) => t.url.startsWith('file:'))).toEqual([])
  expect(await fileTargets()).toEqual([])
}

/** 一次拒绝：`ok:false`、code、消息不复述地址（路径、文件名、fake HOME 都不出现） */
function expectRefused(frame: WsResultFrame): void {
  expect(frame.ok, JSON.stringify(frame)).toBe(false)
  expect(frame.error?.code).toBe(REFUSED)
  const message = frame.error?.message ?? ''
  expect(message.length).toBeGreaterThan(0)
  for (const leaked of ['secret', 'private', MARKER, app.home]) {
    expect(message).not.toContain(leaked)
  }
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  fixture = await startFixtureServer()
  HTTP = fixture.url('/ask-me.html?nb=main')

  const dir = join(app.home, 'private')
  mkdirSync(dir, { recursive: true })
  secretPath = join(dir, 'secret.txt')
  writeFileSync(secretPath, `${MARKER}\n`)
  FILE = pathToFileURL(secretPath).href
  const file6 = join(dir, 'secret-e6.txt')
  writeFileSync(file6, `${MARKER} e6\n`)
  FILE6 = pathToFileURL(file6).href
  const file8 = join(dir, 'secret-e8.txt')
  writeFileSync(file8, `${MARKER} e8\n`)
  FILE8 = pathToFileURL(file8).href

  let port: number
  do {
    port = await freePort()
  } while (port === 7766)
  netPort = port
  await app.main.eval(`window.api.network.setPort(${port})`)
  await app.main.eval('window.api.network.setEnabled(true)')
  ws = await until(() => connectWs(port).catch(() => null), 'network socket on 127.0.0.1')
}, 120_000)

afterAll(async () => {
  mgrPage?.close()
  web?.page.close()
  ws?.close()
  if (app) removeUserPolicy(app.home, POLICY_FILE)
  await fixture?.close()
  await app?.stop()
})

describe('别的设备打不开本地文件', () => {
  it('E-1 ws create-tab [file:] → ok:false、remote_url_refused；没有建出 tab', async () => {
    const before = (await tabs()).length
    const frame = await ws.invokeRaw('browser-view:create-tab', [FILE])
    expectRefused(frame)
    expect(frame.error?.message).toContain('file:')
    // 万一真建了，tab 要过一拍才出现在列表与 DevTools 里
    await sleep(500)
    expect((await tabs()).length).toBe(before)
    await expectNoFileTab()
  }, 60_000)

  it('E-2 ws create-tab [网页] 照常、夹具网站收到请求；ws create-tab [] 是空白页；仍然没有 file: tab', async () => {
    const before = (await tabs()).length
    const frame = await ws.invokeRaw('browser-view:create-tab', [HTTP])
    expect(frame.ok, JSON.stringify(frame)).toBe(true)
    expect(typeof frame.value).toBe('string')
    httpTab = frame.value as string
    await until(
      async () => (await tabs()).find((t) => t.id === httpTab && t.url === HTTP) ?? null,
      'the network-created tab is listed with its address'
    )
    await until(() => fixture.hits('/ask-me.html?nb=main') > 0, 'the fixture site saw the request')

    const blank = await ws.invokeRaw('browser-view:create-tab', [])
    expect(blank.ok, JSON.stringify(blank)).toBe(true)
    const blankTab = blank.value as string
    expect(typeof blankTab).toBe('string')
    await until(
      async () => (await tabs()).some((t) => t.id === blankTab) || null,
      'the blank tab is listed'
    )
    expect((await tabs()).length).toBe(before + 2)
    await expectNoFileTab()
  }, 60_000)

  it('E-3 ws navigate [网页 tab, file:] → ok:false；那个 tab 一直停在网页上', async () => {
    const frame = await ws.invokeRaw('browser-view:navigate', [httpTab, FILE])
    expectRefused(frame)
    expect(await getUrl(httpTab)).toBe(HTTP)
    await sleep(800)
    expect(await getUrl(httpTab)).toBe(HTTP)
    await expectNoFileTab()
  }, 60_000)

  it('E-4 桌面 createTab(file:) 照常：listTabs 有那一行，页面里读得到文件内容', async () => {
    fileTab = await deskCreateTab(FILE)
    expect(typeof fileTab).toBe('string')
    await until(
      async () => (await tabs()).find((t) => t.id === fileTab && t.url === FILE) ?? null,
      'the desktop file tab is listed'
    )
    const page = await until(
      () => connectTabPage(app.port, (u) => u === FILE),
      'the file tab page target'
    )
    try {
      const text = await until(async () => {
        const t = await page.eval<string>('document.body?.innerText ?? ""')
        return t.includes(MARKER) ? t : null
      }, 'the file content shows in the page')
      expect(text).toContain(MARKER)
    } finally {
      page.close()
    }
  }, 60_000)

  it('E-5 ws capture [file: tab] → ok:false、消息里没有路径；ws capture [网页 tab] → PNG data URL', async () => {
    const refused = await ws.invokeRaw('browser-view:capture', [fileTab, 800])
    expectRefused(refused)

    const shot = await until(async () => {
      const frame = await ws.invokeRaw('browser-view:capture', [httpTab, 800])
      return frame.ok && typeof frame.value === 'string' && frame.value.length > 1000 ? frame : null
    }, 'a screenshot of the web page tab')
    const data = shot.value as string
    expect(data.startsWith('data:image/png;base64,')).toBe(true)
    expect(data.length).toBeGreaterThan(1000)
  }, 60_000)
})

describe('后退 / 前进 / 重开 也只到网页', () => {
  it('E-6 退回去是 file: → ws go-back 被拒、tab 不动；桌面 goBack 照常；ws go-forward 回到网页', async () => {
    const HTTP6 = fixture.url('/ask-me.html?nb=6')
    const tab6 = await deskCreateTab(FILE6)
    await waitUrl(tab6, FILE6, 'E-6 tab shows its file')
    await until(async () => (await targetsAt(FILE6)).length > 0 || null, 'E-6 file page committed')
    await app.main.eval(`window.api.browserView.navigate(${q(tab6)}, ${q(HTTP6)})`)
    await waitUrl(tab6, HTTP6, 'E-6 tab navigated to the web page')
    await until(() => fixture.hits('/ask-me.html?nb=6') > 0, 'E-6 fixture page loaded')

    const back = await ws.invokeRaw('browser-view:go-back', [tab6])
    expectRefused(back)
    await sleep(800)
    expect(await getUrl(tab6)).toBe(HTTP6)
    expect(await targetsAt(FILE6)).toEqual([])

    // 坐在这台电脑前的人照样能退回去
    await app.main.eval(`window.api.browserView.goBack(${q(tab6)})`)
    await waitUrl(tab6, FILE6, 'E-6 desktop goBack lands on the file')

    const forward = await ws.invokeRaw('browser-view:go-forward', [tab6])
    expect(forward.ok, JSON.stringify(forward)).toBe(true)
    await waitUrl(tab6, HTTP6, 'E-6 network go-forward lands on the web page')
  }, 60_000)

  it('E-7 关掉的 file: tab：ws reopen-closed-tab 被拒、记录留着；桌面 reopenClosedTab 重开的就是它', async () => {
    // 桌面关的（标签上的 ×）记下地址给 ⌘⇧T —— 最后关的是它，下一次重开的就是它
    await app.main.eval(`window.api.browserView.closeTab(${q(fileTab)})`)
    await until(
      async () => !(await tabs()).some((t) => t.id === fileTab) || null,
      'the file tab is closed'
    )
    await until(async () => (await targetsAt(FILE)).length === 0 || null, 'the file page is gone')
    const before = (await tabs()).length

    const frame = await ws.invokeRaw('browser-view:reopen-closed-tab', [])
    expectRefused(frame)
    await sleep(500)
    expect((await tabs()).length).toBe(before)
    expect((await tabs()).filter((t) => t.url === FILE)).toEqual([])
    expect(await targetsAt(FILE)).toEqual([])

    const reopened = await app.main.eval<string | null>('window.api.browserView.reopenClosedTab()')
    expect(typeof reopened).toBe('string')
    await waitUrl(reopened as string, FILE, 'the desktop reopened the file tab')
  }, 60_000)

  it('E-8 页面自己 pushState 之后 ws go-back：落在没 push 之前的网页上，从没显示过 file:', async () => {
    const HTTP8 = fixture.url('/deny.html?nb=8')
    const PUSHED = fixture.url('/deny.html?nb=8&pushed')
    const tab8 = await deskCreateTab(FILE8)
    await waitUrl(tab8, FILE8, 'E-8 tab shows its file')
    await until(async () => (await targetsAt(FILE8)).length > 0 || null, 'E-8 file page committed')
    await app.main.eval(`window.api.browserView.navigate(${q(tab8)}, ${q(HTTP8)})`)
    await waitUrl(tab8, HTTP8, 'E-8 tab navigated to the web page')

    const page = await until(
      () => connectTabPage(app.port, (u) => u === HTTP8),
      'E-8 web page target'
    )
    try {
      await until(
        () => page.eval<boolean>('document.readyState === "complete"'),
        'E-8 web page loaded'
      )
      // 没有用户手势（不是 evalWithGesture）：Chromium 把 push 之前那一条标成「可跳过」
      await page.eval(`history.pushState(null, '', '/deny.html?nb=8&pushed')`)
    } finally {
      page.close()
    }
    await waitUrl(tab8, PUSHED, 'E-8 the page pushed an entry')

    const frame = await ws.invokeRaw('browser-view:go-back', [tab8])
    const seen: string[] = []
    const fileSeen: string[] = []
    for (let i = 0; i < 10; i++) {
      seen.push(await getUrl(tab8))
      fileSeen.push(...(await targetsAt(FILE8)))
      await sleep(150)
    }
    expect(seen.filter((u) => u.startsWith('file:'))).toEqual([])
    expect(fileSeen).toEqual([])
    expect(frame.ok, JSON.stringify(frame)).toBe(true)
    await waitUrl(tab8, HTTP8, 'E-8 network go-back lands on the un-pushed web page')
    expect(await getUrl(tab8)).not.toMatch(/^file:/)
    expect(await targetsAt(FILE8)).toEqual([])
    expect((await tabs()).length).toBeLessThan(12)
  }, 60_000)
})

/** 等管理页满足 `pred`，回那一刻的样子 */
const waitMgr = (
  pred: (shot: BrowserManagerShot) => boolean,
  what: string
): Promise<BrowserManagerShot> =>
  until(async () => {
    const shot = await mgr.shot()
    return pred(shot) ? shot : null
  }, `browser manager: ${what}`)

describe('web 客户端的浏览器管理页', () => {
  it('E-10 web 客户端有浏览器按钮；点它开出管理页（标签页一节），行里有桌面开过的夹具页', async () => {
    await app.main.eval("window.api.settings.set({ key: 'general.language', value: 'en' })")
    web = await openWebClient(app, netPort)
    const button = webBrowserButtonPane(web.page)
    await until(() => button.present(), 'the web client shows the browser button')
    await button.clickWithGesture()
    await waitBrowserTab(app, (u) => u.includes('#browser-manager'), 'the browser manager tab')
    mgrPage = await until(
      () => connectTabPage(app.port, (u) => u.includes('#browser-manager')),
      'the browser manager page target'
    )
    mgr = browserManagerPane(mgrPage)
    const HTTP6 = fixture.url('/ask-me.html?nb=6')
    const shot = await waitMgr(
      (s) => s.present && s.rows.some((r) => r.url === HTTP6),
      'mounted with the desktop-opened fixture tab'
    )
    expect(shot.section).toBe('tabs')
    expect(shot.headless).toBeNull()
    expect(shot.note).toBe(en.browser.manager.remoteNote)
    expect((await tabs()).length).toBeLessThanOrEqual(12)
  }, 90_000)

  it('E-11 桌面新开、再导航：管理页的行跟着变，管理页没有重新加载', async () => {
    await mgrPage!.eval('window.__nbMarker = 11')
    const A = fixture.url('/ask-me.html?nb=11')
    const B = fixture.url('/deny.html?nb=11')
    const tab11 = await deskCreateTab(A)
    await waitMgr(
      (s) => s.rows.some((r) => r.id === tab11 && r.url === A),
      'the new desktop tab appears'
    )
    await app.main.eval(`window.api.browserView.navigate(${q(tab11)}, ${q(B)})`)
    const shot = await waitMgr(
      (s) => s.rows.some((r) => r.id === tab11 && r.url === B && r.title === 'Deny'),
      'the tab row shows its new address and title'
    )
    expect(shot.rows.filter((r) => r.id === tab11)).toHaveLength(1)
    expect(await mgrPage!.eval<number | null>('window.__nbMarker ?? null')).toBe(11)
  }, 60_000)

  it('E-12 管理页新建的 tab 开在后台：多一行、夹具网站收到请求；桌面选中的不变', async () => {
    const selectedBefore = (
      await app.main.eval<Array<{ id: string; active: boolean }>>(
        'window.api.browserView.listTabs()'
      )
    ).find((t) => t.active)?.id
    expect(typeof selectedBefore).toBe('string')
    const URL12 = fixture.url('/ask-me.html?nb=12')
    await mgr.typeNewTab(URL12)
    await mgr.clickOpen()
    const shot = await waitMgr(
      (s) => s.rows.some((r) => r.url === URL12),
      'the remotely opened tab is listed'
    )
    const id12 = shot.rows.find((r) => r.url === URL12)!.id
    await until(() => fixture.hits('/ask-me.html?nb=12') > 0, 'the fixture site saw the request')
    expect((await mgr.shot()).newTabText).toBe('')
    const listed = await app.main.eval<Array<{ id: string; active: boolean }>>(
      'window.api.browserView.listTabs()'
    )
    expect(listed.find((t) => t.id === id12)?.active).toBe(false)
    expect(listed.find((t) => t.active)?.id).toBe(selectedBefore)
    expect(listed.length).toBeLessThanOrEqual(12)
  }, 60_000)

  it('E-13 file:///etc/hosts + Open → 本地化的拒绝；没有 /etc/hosts 的行、也没有那个 tab', async () => {
    await mgr.typeNewTab('file:///etc/hosts')
    await mgr.clickOpen()
    const shot = await waitMgr((s) => s.error !== null, 'the refusal is shown')
    expect(shot.error).toContain(en.browser.manager.remoteUrlRefused)
    expect(shot.error).not.toContain(REFUSED)
    expect(shot.newTabText).toBe('file:///etc/hosts')
    await sleep(500)
    // 桌面自己开的 file: tab（E-7 重开的那个）照样列着 —— 这里只看「别的设备没开出 /etc/hosts」
    expect((await mgr.shot()).rows.filter((r) => r.url === 'file:///etc/hosts')).toEqual([])
    expect((await tabs()).filter((t) => t.url === 'file:///etc/hosts')).toEqual([])
  }, 60_000)

  it('E-14 切到设置：hash、设置页挂着、没有 View history、不是无头', async () => {
    await mgr.switchSection('settings')
    const shot = await waitMgr((s) => s.section === 'settings' && s.settingsPage, 'settings shown')
    expect(await mgrPage!.eval<string>('location.hash')).toBe('#browser-manager?section=settings')
    expect(shot.openHistory).toBe(false)
    expect(shot.headless).toBeNull()
    expect(shot.headlessSearchNote).toBe(false)
  }, 60_000)

  it('E-15 站点详情里的 Cookie 没有值：展开是说明、页面上没有那个值；ws site-details 每个值都是空串', async () => {
    const page15 = fixture.url('/ask-me.html?nb=15')
    const tab15 = await deskCreateTab(page15)
    await waitUrl(tab15, page15, 'E-15 fixture tab')
    const page = await until(
      () => connectTabPage(app.port, (u) => u === page15),
      'E-15 fixture page target'
    )
    try {
      await until(
        () => page.eval<boolean>('document.readyState === "complete"'),
        'E-15 page loaded'
      )
      await page.eval(`document.cookie = 'nb_cookie=${COOKIE_VALUE}; path=/; max-age=86400'`)
    } finally {
      page.close()
    }
    await app.main.eval(`window.api.browserView.closeTab(${q(tab15)})`)

    const settings = browserSettingsPagePane(mgrPage!)
    const details = browserSiteDetailsPane(mgrPage!)
    const KEY = '127.0.0.1|/|nb_cookie'
    // 网站列表在设置页挂载时读：没有就切回标签页再回来，重新读一次
    await until(async () => {
      if ((await settings.shot()).sites.some((x) => x.site === '127.0.0.1')) return true
      await mgr.switchSection('tabs')
      await mgr.switchSection('settings')
      return null
    }, 'the 127.0.0.1 site is listed')
    await settings.openSite('127.0.0.1')
    await until(
      async () => (await details.shot()).cookies.some((c) => c.key === KEY) || null,
      'the cookie row shows'
    )
    await details.toggleCookie(KEY)
    await until(() => mgr.cookieValueHidden(KEY), 'the expanded cookie shows the hidden note')
    const row = (await details.shot()).cookies.find((c) => c.key === KEY)!
    expect(row.name).toBe('nb_cookie')
    expect(row.value).toBeNull()
    expect(await mgr.text()).not.toContain(COOKIE_VALUE)

    const frame = await ws.invokeRaw('browser-data:site-details', ['127.0.0.1'])
    expect(frame.ok, JSON.stringify(frame).slice(0, 400)).toBe(true)
    const value = frame.value as {
      cookies: Array<{ name: string; value: string }>
      cookieValuesHidden?: boolean
    }
    expect(value.cookieValuesHidden).toBe(true)
    expect(value.cookies.some((c) => c.name === 'nb_cookie')).toBe(true)
    expect(value.cookies.every((c) => c.value === '')).toBe(true)
    expect(JSON.stringify(frame)).not.toContain(COOKIE_VALUE)
    await details.back()
  }, 90_000)

  it('E-16 管理页删除浏览历史：浏览器窗口外壳读到的历史变空；ws 读历史一直是空表', async () => {
    const page16 = fixture.url('/ask-me.html?nb=16')
    await app.main.eval(`window.api.browserView.createTab(${q(page16)}, 'typed')`)
    await until(() => fixture.hits('/ask-me.html?nb=16') > 0, 'E-16 fixture page loaded')

    await app.main.eval('window.api.browserView.openWindow()')
    await until(
      () => app.main.eval<boolean>('window.api.browserView.isWindowOpen()'),
      'browser window open'
    )
    const bw = await until(() => app.browserWindow(), 'browser window page')
    try {
      const listHistory = (): Promise<{ items: Array<{ url: string }>; next: number | null }> =>
        bw.eval('window.api.browserHistory.list({})')
      await until(
        async () => (await listHistory()).items.some((i) => i.url === page16) || null,
        'the user visit is recorded'
      )
      const before = await ws.invokeRaw('browser-history:list', [{}])
      expect(before).toMatchObject({ ok: true, value: { items: [], next: null } })

      await mgr.clearHistory()
      await until(async () => (await listHistory()).items.length === 0 || null, 'history cleared')
      expect(await listHistory()).toEqual({ items: [], next: null })
      const after = await ws.invokeRaw('browser-history:list', [{}])
      expect(after).toMatchObject({ ok: true, value: { items: [], next: null } })
    } finally {
      bw.close()
    }
    expect((await tabs()).length).toBeLessThanOrEqual(11)
  }, 90_000)

  it('E-17 桌面开的夹具页一行：点开截图 → shown、PNG data URL；再点 → 收起', async () => {
    await mgr.switchSection('tabs')
    const HTTP6 = fixture.url('/ask-me.html?nb=6')
    const listed = await waitMgr(
      (s) => s.section === 'tabs' && s.rows.some((r) => r.url === HTTP6),
      'back on the tabs section with the E-6 fixture tab'
    )
    const id6 = listed.rows.find((r) => r.url === HTTP6)!.id
    expect(listed.rows.find((r) => r.id === id6)?.shotExpanded).toBe('false')
    await mgr.toggleScreenshot(id6)
    // 页面刚好没画出来时截到的是空的：重新截一次
    const shot = await until(async () => {
      const r = (await mgr.shot()).rows.find((x) => x.id === id6)
      if (r?.screenshot === 'empty') await mgr.retakeScreenshot(id6)
      return r?.screenshot === 'shown' ? r : null
    }, 'browser manager: the E-6 tab screenshot is shown')
    expect(shot.shotExpanded).toBe('true')
    expect(shot.shotSrcPrefix?.startsWith('data:image/png;base64,')).toBe(true)

    await mgr.toggleScreenshot(id6)
    const closed = await waitMgr(
      (s) => s.rows.find((r) => r.id === id6)?.screenshot === null,
      'the screenshot panel is closed'
    )
    expect(closed.rows.find((r) => r.id === id6)?.shotExpanded).toBe('false')
    expect(closed.rows.every((r) => r.screenshot === null)).toBe(true)
  }, 60_000)
})

describe('标签页的地址与截图是 admin', () => {
  it('E-9 策略拒绝 browser 的 admin 通道：list-tabs / get-url / capture → denied；is-window-open 与 create-tab 照常', async () => {
    const shotOf = async (): Promise<BrowserManagerShot['rows'][number] | undefined> =>
      (await mgr.shot()).rows.find((r) => r.id === httpTab)
    // 管理页上先把 E-2 那个网页 tab 的截图点开（策略之前截得到）
    await waitMgr(
      (s) => s.section === 'tabs' && s.rows.some((r) => r.id === httpTab),
      'the E-2 web tab row is listed'
    )
    await mgr.toggleScreenshot(httpTab)
    await until(async () => {
      const r = await shotOf()
      if (r?.screenshot === 'empty') await mgr.retakeScreenshot(httpTab)
      return r?.screenshot === 'shown' || null
    }, 'browser manager: the E-2 tab screenshot is shown')
    try {
      writeUserPolicy(app.home, POLICY_FILE, BROWSER_ADMIN_POLICY)
      const denied = { ok: false, error: { code: 'denied', message: POLICY_PROMPT } }
      const listed = await until(async () => {
        const frame = await ws.invokeRaw('browser-view:list-tabs', [])
        return frame.ok ? null : frame
      }, 'the browser-admin policy is applied')
      expect(listed).toMatchObject(denied)
      expect(await ws.invokeRaw('browser-view:get-url', [httpTab])).toMatchObject(denied)
      expect(await ws.invokeRaw('browser-view:capture', [httpTab, 800])).toMatchObject(denied)

      // 管理页的「重新截图」也被拒：面板说截不到、原因是规则的 prompt（create-tab 之前 —— 它会换掉这些行）
      await mgr.retakeScreenshot(httpTab)
      const failed = await until(async () => {
        const r = await shotOf()
        return r?.screenshot === 'failed' ? r : null
      }, 'browser manager: the retaken screenshot is refused')
      expect(failed.shotFailed).toBe(
        en.browser.manager.screenshotFailed.replace('{{reason}}', POLICY_PROMPT)
      )

      const open = await ws.invokeRaw('browser-view:is-window-open', [])
      expect(open.ok, JSON.stringify(open)).toBe(true)
      const created = await ws.invokeRaw('browser-view:create-tab', [
        fixture.url('/ask-me.html?nb=9')
      ])
      expect(created.ok, JSON.stringify(created)).toBe(true)
      expect(typeof created.value).toBe('string')
      // 桌面那一侧不受这份策略管
      expect(await getUrl(httpTab)).toBe(HTTP)
    } finally {
      removeUserPolicy(app.home, POLICY_FILE)
    }
  }, 60_000)
})
