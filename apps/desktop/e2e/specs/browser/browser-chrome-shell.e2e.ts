/**
 * 浏览器窗口照 Chrome 的样子（2026-10-16）：单页视图、选中只属于用户、agent 只留标记、地址栏、按站点缩放、
 * 原生菜单、快捷键碰不到 agent 的按键（假提供商脚本化；夹具网站记下每一个请求）。一个实例按顺序走：
 *
 *   CB-E1  三个用户开的 tab（IPC createTab），窗口开着、单页视图：单页视图显示的、listTabs 的 active、标签条上
 *          选中的三者一致；只有它的视口等于页面区宽度，其余（停放着）1280 宽；在标签条上点另一个 → 两者对调，
 *          页面一次都没重载（夹具的请求计数不变）；
 *   CB-E2  用户选中着 A、窗口开着，一条勾了 mcp:browser 的会话 open_tab B → snapshot → 点 target=_blank 链接：
 *          A 一直是选中的、一直在屏幕上（视口不变）；B 在标签条上、没选中、带这个会话的圆点；弹出页是一个新的、
 *          没选中的 tab；agent 的 list_tabs：A `(active)`，B 与弹出页 `(opened by you)`；
 *   CB-E3  选中 A 时没有提示条；选中 B → 提示条写着会话标题，「查看对话」把主窗口切到那条会话；再选回 A，
 *          提示条消失；
 *   CB-E4  ⋮ → 放大两次 → 缩放标识 125，A 的视口 ≈ 100% 时的 / 1.25，同站的 tab 在 listTabs 里都是 125；
 *          切到平铺墙（写进设置）→ A 换成卡片的缩放；切回单页 → 又是 125；点缩放标识 → 回 100；
 *   CB-E5  地址栏：mousedown 进编辑，完整地址整段选中；打 `127.0.0.1:<port>/counter.html?omni=1` + Enter →
 *          夹具收到请求、选中那页的地址是 http://…；打字 + Esc 不导航；标签条上的 + → 新的空白页被选中、
 *          地址栏 input 是 document.activeElement、页面区是新标签页；
 *   CB-E6  原生菜单（桩）：标签右键的 8 个动作；关闭右侧 / 关闭其他照办；⋮ 的重开把最后一个被用户关掉的
 *          地址开回来并选中；搜索标签页选中一个；⋮ 切到平铺墙；
 *   CB-E7  agent 在自己的 tab 上 press_key `Meta+w` / `Control+w` / `Meta+t` / `Meta+Shift+t`（窗口开着、再隐藏
 *          着各一遍）：页面收到了这些 keydown，但 tab 数、选中、窗口开没开都不变 —— CDP 的按键不经过浏览器
 *          的快捷键。
 *
 * 不钉的已知缺口：平铺墙里点卡片的**原生页面**不会选中那张卡片（CDP 的鼠标事件也会触发 before-mouse-event，
 * 所以没法用它分辨「用户点的」）—— 本 spec 两边都不断。
 *
 * 「屏幕上显示的是哪页」按页面自己的 innerWidth 量（经 DevTools 直连 tab 的 page target）：单页视图里选中的那页
 * ≈ 页面区宽度，停放着的是停放窗口的 1280。窗口「开没开」一律问 IPC `isWindowOpen()`（理由见
 * browser-window.e2e.ts 文件头）。会话给显式标题（缺省标题会让自动起标题的 hook 抢走脚本里的轮次）。
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
  sidebarPane,
  type BrowserShellPane,
  type BrowserWallPane
} from '../../harness/pages'
import {
  BROWSER_TOOL_NAMES,
  browserDriver,
  browserTool,
  connectTabPage,
  startFixtureServer,
  tabIdOf,
  uidOf,
  type BrowserDriver,
  type FixtureServer
} from '../../harness/browserFixtures'

const MODEL = 'e2e-model'
const ALL_BROWSER_TOOLS = BROWSER_TOOL_NAMES.map(browserTool).sort()
/** 停放窗口的内容区宽度（= 停放中的 tab 的视口宽，CSS px @ 缩放 1） */
const STAGING_WIDTH = 1280
/** 卡片的逻辑宽度（tabUtils.CARD_LOGICAL_W）：墙上的页面按它排版再整体缩小 */
const CARD_LOGICAL_W = 1100
const SESSION_TITLE = 'CB chrome shell agent'

interface TabRow {
  id: string
  url: string
  title: string
  active: boolean
  zoomPercent: number
  openerSessionId?: string
  agentSessionId?: string
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let fixture: FixtureServer
let driver: BrowserDriver
let bw: CdpClient
let wall: BrowserWallPane
let shell: BrowserShellPane
/** 勾了 mcp:browser 的会话（CB-E2 起） */
let sid = ''
/** CB-E1 的三个用户 tab */
let a = ''
let b = ''
let c = ''
/** CB-E2 agent 开的 tab 与它点出来的弹出页 */
let agentTab = ''
let agentShort = ''
let popupTab = ''

// ─── IPC 助手 ───

const isWindowOpen = (): Promise<boolean> =>
  app.main.eval<boolean>('window.api.browserView.isWindowOpen()')
const listTabs = (): Promise<TabRow[]> =>
  app.main.eval<TabRow[]>('window.api.browserView.listTabs()')
const createTab = (url: string): Promise<string> =>
  app.main.eval<string>(`window.api.browserView.createTab(${JSON.stringify(url)})`)
const selectedId = async (): Promise<string | undefined> =>
  (await listTabs()).find((t) => t.active)?.id
const settingOf = async (key: string): Promise<string | undefined> =>
  (await app.main.eval<Record<string, string>>('window.api.settings.getAll()'))[key]

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

/** 直接（经 DevTools，不经 agent）在某个 tab 的页面里求值；按它此刻的地址认 page target */
async function evalInTab<T>(tabId: string, expression: string): Promise<T | null> {
  const row = (await listTabs()).find((t) => t.id === tabId)
  if (!row) return null
  const page = await connectTabPage(app.port, (u) => u === row.url)
  if (!page) return null
  try {
    return await page.eval<T>(expression)
  } catch {
    return null
  } finally {
    page.close()
  }
}
const innerWidthOf = (tabId: string): Promise<number | null> =>
  evalInTab<number>(tabId, 'innerWidth')

/**
 * 反复读、直到断言全过；超时就把最后一次读数连同失败的断言一起抛出来（布局走 rAF + IPC，有过渡帧）。
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

/** 单页视图页面区的宽度（CSS px） */
async function pageWidth(): Promise<number> {
  const rect = await eventually(
    () => wall.singlePageRect(),
    (r) => {
      expect(r).not.toBeNull()
      expect(r!.width).toBeGreaterThan(400)
    },
    'single-page area laid out'
  )
  return Math.round(rect!.width)
}

/** 某个 tab 显示在单页视图里：视口 ≈ 页面区宽（÷ 缩放） */
async function expectOnScreen(tabId: string, zoom = 1): Promise<number> {
  const expected = (await pageWidth()) / zoom
  const w = await eventually(
    () => innerWidthOf(tabId),
    (v) => {
      expect(v).not.toBeNull()
      expect(Math.abs(v! - expected)).toBeLessThanOrEqual(3)
    },
    `tab ${tabId} on screen (viewport ≈ ${expected.toFixed(0)})`
  )
  return w!
}

/** 某个 tab 停放着：视口 = 停放窗口的 1280 */
async function expectParked(tabId: string): Promise<void> {
  await eventually(
    () => innerWidthOf(tabId),
    (v) => expect(v).toBe(STAGING_WIDTH),
    `tab ${tabId} parked (viewport ${STAGING_WIDTH})`
  )
}

/** 三方一致：单页视图显示的 / listTabs 的 active / 标签条上选中的 */
async function expectSelected(tabId: string): Promise<void> {
  await eventually(
    async () => ({
      page: await wall.singlePageTabId(),
      active: await selectedId(),
      strip: await wall.selectedTabIds()
    }),
    (v) => expect(v).toEqual({ page: tabId, active: tabId, strip: [tabId] }),
    `tab ${tabId} selected everywhere`
  )
}

/** list_tabs 正文里某个短号 / 某个地址那一行 */
function lineOf(listed: string, pick: { short?: string; url?: string }): string {
  const line = listed
    .split('\n')
    .find((l) =>
      pick.short ? l.startsWith(`[${pick.short}]`) : pick.url ? l.endsWith(` — ${pick.url}`) : false
    )
  if (!line) throw new Error(`no list_tabs line for ${JSON.stringify(pick)} in:\n${listed}`)
  return line
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

  await app.main.eval('window.api.browserView.openWindow()')
  await until(() => isWindowOpen(), 'browser window open')
  bw = await until(() => app.browserWindow(), 'browser window page')
  wall = browserWallPane(bw)
  shell = browserShellPane(bw)
  await until(() => wall.mounted(), 'browser window shell mounted')
}, 120_000)

afterAll(async () => {
  bw?.close()
  await provider?.close()
  await fixture?.close()
  await app?.stop()
})

describe('单页视图与选中（CB-E1）', () => {
  it('CB-E1 三个用户 tab：显示的 / active / 标签条选中的一致；只有它在屏幕上，其余停放 1280；在标签条上点另一个 → 对调，不重载', async () => {
    expect(await wall.viewMode()).toBe('single')
    a = await createTab(fixture.url('/counter.html?cb=e1a'))
    b = await createTab(fixture.url('/counter.html?cb=e1b'))
    c = await createTab(fixture.url('/counter.html?cb=e1c'))
    await until(
      () =>
        fixture.hits('/counter.html?cb=e1a') === 1 &&
        fixture.hits('/counter.html?cb=e1b') === 1 &&
        fixture.hits('/counter.html?cb=e1c') === 1,
      'three fixture pages requested once'
    )
    await eventually(
      () => wall.tabIds(),
      (ids) => expect(ids).toEqual([a, b, c]),
      'three tabs in the strip'
    )
    // 用户开的 tab 开在前台：最后开的那个被选中
    await expectSelected(c)
    await expectOnScreen(c)
    await expectParked(a)
    await expectParked(b)

    await shell.clickTab(a)
    await expectSelected(a)
    await expectOnScreen(a)
    await expectParked(c)
    await expectParked(b)

    await sleep(500)
    expect(fixture.hits('/counter.html?cb=e1a')).toBe(1)
    expect(fixture.hits('/counter.html?cb=e1b')).toBe(1)
    expect(fixture.hits('/counter.html?cb=e1c')).toBe(1)
  }, 60_000)
})

describe('agent 开的 tab 与弹出页都在后台（CB-E2）', () => {
  beforeAll(async () => {
    sid = await tickedSession(SESSION_TITLE)
  }, 60_000)

  it('CB-E2 open_tab → snapshot → 点 target=_blank：A 一直选中、一直在屏幕上；B 与弹出页没选中、记在会话名下；list_tabs 的标注', async () => {
    await expectSelected(a)
    const before = await expectOnScreen(a)

    provider.reset()
    const popperUrl = fixture.url('/popper.html?cb=e2')
    const opened = await driver.run(sid, [
      { id: 'cbe2_open', tool: 'open_tab', args: { url: popperUrl } }
    ])
    expect(opened.ends.cbe2_open?.isError, opened.ends.cbe2_open?.result).toBe(false)
    agentShort = tabIdOf(opened.ends.cbe2_open.result)
    agentTab = (await listTabs()).find((t) => t.url === popperUrl)!.id
    expect(agentTab).toBeTruthy()

    provider.reset()
    const snap = await driver.run(sid, [
      { id: 'cbe2_snap', tool: 'snapshot', args: { tabId: agentShort } }
    ])
    expect(snap.ends.cbe2_snap?.isError, snap.ends.cbe2_snap?.result).toBe(false)
    const linkUid = uidOf(snap.ends.cbe2_snap.result, 'link', 'Open popup')

    provider.reset()
    const clicked = await driver.run(sid, [
      { id: 'cbe2_click', tool: 'click', args: { tabId: agentShort, uid: linkUid } }
    ])
    expect(clicked.ends.cbe2_click?.isError, clicked.ends.cbe2_click?.result).toBe(false)
    await until(() => fixture.hits('/ask-me.html?from=popper') === 1, 'popup page requested')
    const popupUrl = fixture.url('/ask-me.html?from=popper')
    const rows = await eventually(
      () => listTabs(),
      (list) => expect(list.some((t) => t.url === popupUrl)).toBe(true),
      'popup tab listed'
    )
    popupTab = rows.find((t) => t.url === popupUrl)!.id

    // ── 选中的一直是 A，A 一直在屏幕上 ──
    await expectSelected(a)
    expect(await innerWidthOf(a)).toBe(before)
    const list = await listTabs()
    expect(list.find((t) => t.id === agentTab)).toMatchObject({
      active: false,
      openerSessionId: sid,
      agentSessionId: sid
    })
    expect(list.find((t) => t.id === popupTab)).toMatchObject({
      active: false,
      openerSessionId: sid
    })
    expect(list.find((t) => t.id === a)).not.toHaveProperty('openerSessionId')

    // ── 标签条：B 与弹出页在、没选中；B 带这个会话的圆点 ──
    await eventually(
      () => wall.tabIds(),
      (ids) => expect(ids).toEqual([a, b, c, agentTab, popupTab]),
      'agent tab and popup in the strip'
    )
    expect(await wall.selectedTabIds()).toEqual([a])
    await eventually(
      () => shell.agentDot(agentTab),
      (dot) => expect(dot).toBe(sid),
      "agent tab carries the session's dot"
    )
    expect(await shell.agentDot(a)).toBeNull()

    // ── agent 的 list_tabs ──
    provider.reset()
    const listed = await driver.run(sid, [{ id: 'cbe2_list', tool: 'list_tabs', args: {} }])
    expect(listed.ends.cbe2_list?.isError, listed.ends.cbe2_list?.result).toBe(false)
    const text = listed.ends.cbe2_list.result
    const lineA = lineOf(text, { url: fixture.url('/counter.html?cb=e1a') })
    expect(lineA).toContain(' (active)')
    expect(lineA).not.toContain('(opened by you)')
    const lineB = lineOf(text, { short: agentShort })
    expect(lineB).toContain(' (opened by you)')
    expect(lineB).not.toContain('(active)')
    const linePopup = lineOf(text, { url: popupUrl })
    expect(linePopup).toContain(' (opened by you)')
    expect(linePopup).not.toContain('(active)')
    for (const url of ['/counter.html?cb=e1b', '/counter.html?cb=e1c']) {
      const line = lineOf(text, { url: fixture.url(url) })
      expect(line).not.toContain('(active)')
      expect(line).not.toContain('(opened by you)')
    }
  }, 120_000)
})

describe('提示条（CB-E3）', () => {
  it('CB-E3 选中 A 没有提示条；选中 B → 提示条写着会话标题，「查看对话」把主窗口切过去；选回 A 消失', async () => {
    await expectSelected(a)
    expect(await shell.infobar()).toBeNull()

    await shell.clickTab(agentTab)
    await expectSelected(agentTab)
    const bar = await eventually(
      () => shell.infobar(),
      (v) => {
        expect(v).not.toBeNull()
        expect(v!.sessionId).toBe(sid)
        expect(v!.text).toContain(SESSION_TITLE)
      },
      'infobar names the session'
    )
    expect(bar!.text).toContain('is using this page')

    const sidebar = sidebarPane(app.main)
    expect(await sidebar.activeTitle()).not.toBe(SESSION_TITLE)
    await shell.clickInfobarOpen()
    await until(
      async () => (await sidebar.activeTitle()) === SESSION_TITLE,
      'main window switched to the agent session'
    )

    await shell.clickTab(a)
    await expectSelected(a)
    await eventually(
      () => shell.infobar(),
      (v) => expect(v).toBeNull(),
      'infobar gone on A'
    )
  }, 60_000)
})

describe('按站点缩放（CB-E4）', () => {
  it('CB-E4 ⋮ 放大两次 → 125；平铺墙用卡片缩放、切回单页又是 125；点标识回 100', async () => {
    await expectSelected(a)
    expect(await shell.zoomIndicator()).toBeNull()
    const w100 = await expectOnScreen(a)

    await shell.moreMenu('zoomIn')
    await eventually(
      () => shell.zoomIndicator(),
      (z) => expect(z).toBe(110),
      'zoom indicator 110'
    )
    await shell.moreMenu('zoomIn')
    await eventually(
      () => shell.zoomIndicator(),
      (z) => expect(z).toBe(125),
      'zoom indicator 125'
    )
    await eventually(
      () => innerWidthOf(a),
      (w) => expect(Math.abs(w! - w100 / 1.25)).toBeLessThanOrEqual(3),
      `A at 125% (viewport ≈ ${(w100 / 1.25).toFixed(0)})`
    )
    // 夹具的 tab 全在 127.0.0.1 这一个站点上：每个都是 125
    await eventually(
      () => listTabs(),
      (list) => expect(list.map((t) => t.zoomPercent)).toEqual(list.map(() => 125)),
      'every same-site tab at 125'
    )

    // ── 平铺墙：卡片的缩放（按逻辑宽度排版），设置记下来 ──
    await wall.useView('wall')
    await until(async () => (await settingOf('browser.viewMode')) === 'wall', 'viewMode saved')
    await eventually(
      () => innerWidthOf(a),
      (w) => {
        expect(w).not.toBeNull()
        expect(w!).toBeGreaterThanOrEqual(CARD_LOGICAL_W - 50)
        expect(w!).toBeLessThanOrEqual(CARD_LOGICAL_W + 50)
      },
      'A at the card zoom on the wall'
    )

    // ── 回单页：又是用户的 125 ──
    await wall.useView('single')
    await until(async () => (await settingOf('browser.viewMode')) === 'single', 'viewMode saved')
    await eventually(
      () => innerWidthOf(a),
      (w) => expect(Math.abs(w! - w100 / 1.25)).toBeLessThanOrEqual(3),
      'A back at 125% in the single view'
    )
    expect(await shell.zoomIndicator()).toBe(125)

    // ── 点标识：回 100 ──
    await shell.clickZoomIndicator()
    await eventually(
      () => shell.zoomIndicator(),
      (z) => expect(z).toBeNull(),
      'zoom indicator gone'
    )
    await eventually(
      () => innerWidthOf(a),
      (w) => expect(Math.abs(w! - w100)).toBeLessThanOrEqual(3),
      'A back at 100%'
    )
    expect((await listTabs()).map((t) => t.zoomPercent).every((z) => z === 100)).toBe(true)
  }, 90_000)
})

describe('地址栏（CB-E5）', () => {
  it('CB-E5 进编辑整段选中；host:port/路径 + Enter → http:// 导航；Esc 不导航；+ → 新空白页选中、光标在地址栏', async () => {
    await expectSelected(a)
    const urlA = (await listTabs()).find((t) => t.id === a)!.url
    expect(await shell.omniboxDisplay()).toBe(urlA)

    await shell.beginOmniboxEdit()
    const editing = await shell.omniboxInput()
    expect(editing).toEqual({
      value: urlA,
      focused: true,
      selectionStart: 0,
      selectionEnd: urlA.length
    })

    const hostPort = fixture.origin.replace(/^http:\/\//, '')
    await shell.typeInOmnibox(`${hostPort}/counter.html?omni=1`)
    await shell.pressInOmnibox('Enter')
    await until(() => fixture.hits('/counter.html?omni=1') === 1, 'omnibox navigation requested')
    const navigated = `http://${hostPort}/counter.html?omni=1`
    await eventually(
      () => listTabs(),
      (list) => expect(list.find((t) => t.active)).toMatchObject({ id: a, url: navigated }),
      'selected tab on the typed address'
    )
    await eventually(
      () => shell.omniboxDisplay(),
      (d) => expect(d).toBe(navigated),
      'omnibox shows the new address'
    )

    // ── 打字 + Esc：不导航，显示复原 ──
    await shell.beginOmniboxEdit()
    await shell.typeInOmnibox(`${hostPort}/counter.html?escaped=1`)
    await shell.pressInOmnibox('Escape')
    await eventually(
      () => shell.omniboxDisplay(),
      (d) => expect(d).toBe(navigated),
      'omnibox display restored after Escape'
    )
    expect(await shell.omniboxInput()).toBeNull()
    await sleep(800)
    expect(fixture.hits('/counter.html?escaped=1')).toBe(0)
    expect((await listTabs()).find((t) => t.id === a)?.url).toBe(navigated)

    // ── 标签条上的 +：新的空白页选中，光标在地址栏 ──
    const countBefore = (await listTabs()).length
    await shell.clickNewTab()
    const fresh = await eventually(
      () => listTabs(),
      (list) => {
        expect(list).toHaveLength(countBefore + 1)
        expect(list.at(-1)).toMatchObject({ active: true, url: 'about:blank' })
      },
      'a new selected blank tab'
    )
    const blankId = fresh.at(-1)!.id
    await eventually(
      () => wall.selectedTabIds(),
      (ids) => expect(ids).toEqual([blankId]),
      'blank tab selected in the strip'
    )
    await eventually(
      () => shell.omniboxInput(),
      (input) => expect(input).toMatchObject({ value: '', focused: true }),
      'omnibox input focused on the new tab'
    )
    expect(await shell.newTabPageShown()).toBe(true)
    expect(await wall.singlePageTabId()).toBeNull()
  }, 90_000)
})

describe('原生菜单（CB-E6）', () => {
  it('CB-E6 标签右键 8 个动作；关闭右侧 / 关闭其他；⋮ 重开最后关掉的并选中；搜索标签页选中；⋮ 切平铺墙', async () => {
    const ids = (await listTabs()).map((t) => t.id)
    expect(ids.slice(0, 5)).toEqual([a, b, c, agentTab, popupTab])
    expect(ids).toHaveLength(6)

    const items = await shell.tabMenu(a, null)
    expect(items.filter((it) => it.id).map((it) => it.id)).toEqual([
      'newTab',
      'reload',
      'duplicate',
      'copyLink',
      'openExternal',
      'close',
      'closeOthers',
      'closeRight'
    ])
    // 取消了：什么也没动
    await sleep(300)
    expect((await listTabs()).map((t) => t.id)).toEqual(ids)

    // ── 关闭右侧（c 右边的全关）──
    await shell.tabMenu(c, 'closeRight')
    await eventually(
      async () => (await listTabs()).map((t) => t.id),
      (now) => expect(now).toEqual([a, b, c]),
      'tabs right of c closed'
    )

    // ── 关闭其他（a 以外的全关：先 b 后 c）──
    await shell.tabMenu(a, 'closeOthers')
    await eventually(
      async () => (await listTabs()).map((t) => t.id),
      (now) => expect(now).toEqual([a]),
      'every tab but a closed'
    )

    // ── ⋮ 重开：最后一个被用户关掉的（c），开在前台 ──
    const cUrl = fixture.url('/counter.html?cb=e1c')
    await shell.moreMenu('reopen')
    const reopened = await eventually(
      () => listTabs(),
      (list) => {
        expect(list).toHaveLength(2)
        expect(list[1]).toMatchObject({ url: cUrl, active: true })
      },
      'closed tab c reopened and selected'
    )
    const cAgain = reopened[1].id
    await expectSelected(cAgain)

    // ── 搜索标签页：列全部、选中的打勾；选 a ──
    const listed = await shell.tabSearchMenu(a)
    expect(listed.map((it) => it.id)).toEqual([a, cAgain])
    expect(listed.filter((it) => it.label?.startsWith('✓ ')).map((it) => it.id)).toEqual([cAgain])
    await expectSelected(a)

    // ── ⋮ 切到平铺墙 ──
    await shell.moreMenu('viewWall')
    await until(async () => (await wall.viewMode()) === 'wall', 'wall view via the ⋮ menu')
    await until(async () => (await settingOf('browser.viewMode')) === 'wall', 'viewMode saved')
    await wall.useView('single')
  }, 90_000)
})

describe('agent 的按键碰不到浏览器快捷键（CB-E7）', () => {
  /** 按四个组合键；回页面收到的非修饰键（页面自己捕获阶段的 keydown 记录） */
  async function pressAll(short: string, tabId: string, tag: string): Promise<string[]> {
    await evalInTab(tabId, 'window.__keys.length = 0')
    provider.reset()
    const run = await driver.run(sid, [
      { id: `${tag}_mw`, tool: 'press_key', args: { tabId: short, key: 'Meta+w' } },
      { id: `${tag}_cw`, tool: 'press_key', args: { tabId: short, key: 'Control+w' } },
      { id: `${tag}_mt`, tool: 'press_key', args: { tabId: short, key: 'Meta+t' } },
      { id: `${tag}_mst`, tool: 'press_key', args: { tabId: short, key: 'Meta+Shift+t' } }
    ])
    for (const id of [`${tag}_mw`, `${tag}_cw`, `${tag}_mt`, `${tag}_mst`]) {
      expect(run.ends[id]?.isError, `${id}: ${run.ends[id]?.result}`).toBe(false)
    }
    const keys = (await evalInTab<string[]>(tabId, 'window.__keys.slice()')) ?? []
    return keys.filter((k) => !['Meta', 'Control', 'Shift', 'Alt'].includes(k))
  }

  it('CB-E7 窗口开着、再隐藏着：页面收到 ⌘W / Ctrl+W / ⌘T / ⌘⇧T，tab 数、选中、窗口状态都不变', async () => {
    await expectSelected(a)
    provider.reset()
    const url = fixture.url('/select.html?cb=e7')
    const opened = await driver.run(sid, [{ id: 'cbe7_open', tool: 'open_tab', args: { url } }])
    expect(opened.ends.cbe7_open?.isError, opened.ends.cbe7_open?.result).toBe(false)
    const short = tabIdOf(opened.ends.cbe7_open.result)
    const tabId = (await listTabs()).find((t) => t.url === url)!.id
    await expectSelected(a)

    const snapshot = async (): Promise<{ ids: string[]; selected?: string; open: boolean }> => ({
      ids: (await listTabs()).map((t) => t.id),
      selected: await selectedId(),
      open: await isWindowOpen()
    })

    // ── 窗口开着 ──
    const before = await snapshot()
    expect(before.open).toBe(true)
    expect(await pressAll(short, tabId, 'cbe7a')).toEqual(['w', 'w', 't', 'T'])
    await sleep(500)
    expect(await snapshot()).toEqual(before)

    // ── 窗口隐藏着（用户关窗 = 隐藏）──
    await bw.eval('window.close()')
    await until(async () => !(await isWindowOpen()) || null, 'browser window hidden')
    const hidden = await snapshot()
    expect(hidden.open).toBe(false)
    expect(hidden.ids).toEqual(before.ids)
    expect(await pressAll(short, tabId, 'cbe7b')).toEqual(['w', 'w', 't', 'T'])
    await sleep(500)
    expect(await snapshot()).toEqual(hidden)
  }, 120_000)
})
