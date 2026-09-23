/**
 * 内置浏览器的独立窗口（browserWindowService）、停放窗口（stagingWindow）与 tab 服务
 * （browserViewService）的接线 —— 「agent 的浏览器动作绝不打扰主窗口里的用户」这条规矩的窗口一侧。
 *
 *   ST-U1   tab 从停放窗口出生：第一个 tab 才建它（show:false、不可聚焦、不进任务栏、1280×800
 *           内容区、装守卫、从不加载页面、从不显示）；view 挂在它上面、铺满 1280×800、只 setVisible(true)；
 *           浏览器窗口不因此出现；第二个 tab 复用它。开发态 openBrowserWindow 从 dev server 加载 #browser-window；
 *   ST-U2   只有用户能把浏览器窗口弄出来（openBrowserWindow）：建 / show + focus；关窗 = 隐藏后复用；
 *           最小化的先 restore；没有 tab 时不建停放窗口；停放窗口从不显示、从不聚焦；
 *   ST-U3   浏览器窗口处于 (a) 从没建过 (b) 可见但没焦点 (c) 被关（隐藏）(d) 最小化且报告不可见
 *           时，tab 的全部动作（建 / 空白建 / 激活 / 关 / 抓图 / 页面 window.open 一个 https）都不建窗口、
 *           不把任何窗口弄到眼前、不 app.focus、不弹框；(c) 仍关着、(d) 仍最小化；
 *   ST-U4   关窗 = 隐藏、退出之后不拦；destroyBrowserWindow 之后 createTab 照常（落在停放窗口、不建窗口）；
 *   ST-U5   isHostWebContents 只认宿主窗口自己的 webContents；
 *   ST-U7   上墙与下墙：浏览器窗口（宿主 zoom 1.25）上的两个槽 —— view 按槽矩形 ×1.25 取整挂上去、
 *           页面缩放 0.5；三种下墙（布局表里没了它 / 墙级门关 / 换宿主为 null）都是先从浏览器窗口摘下
 *           再挂到停放窗口（从不同时挂在两个窗口上）、铺回 1280×800、**不动页面缩放**、不 setVisible(false)；
 *           重复同一张表不增删；
 *   ST-U8   主窗口关闭联动：墙上的 tab 先停回停放窗口再销毁浏览器窗口、存一次状态；macOS 上 tab 与停放
 *           窗口都留着，其余平台全部关掉、停放窗口也销毁；重开的新窗口按存下的尺寸建，开窗时不挂任何
 *           view，新宿主报了布局表之后才上墙；
 *   ST-U9   证书错误的询问只在用户正看着浏览器窗口（可见、未最小化、有焦点）时弹，挂在浏览器窗口上；
 *           否则静默拒绝、不因此信任 host；同 host 的并发合并成一个框；
 *   ST-U11  tab 数的应用事件 `browser.tabsChanged`：每次建 / 关成功各一条、count = 此刻的 tab 数；
 *           关不存在的、开第 13 个（抛错）都不发；
 *   ST-U12  initBrowserWindowService 幂等。
 *
 * electron 整个换成 ./fakeElectron.ts 的假件；browserViewService / browserWindowService / stagingWindow /
 * appEventBus 与 externalOpen 的裁决都用真的（externalOpen 只把 guardAppWindow 换成间谍）。模块级状态
 * 每条用例都要新的，所以 beforeEach 里 resetModules，load() 重新导入。
 * 全文件的不变量（afterEach）：没有哪个 view 被 setVisible 过 `true` 以外的值；没有哪个 view 同时
 * 挂在两个活着的窗口上。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { fakeElectron, type FakeView, type FakeWindow, type Rect } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

const state = vi.hoisted(() => {
  const s = {
    /** settingsDao 背后的一张内存表 */
    settings: new Map<string, string>(),
    upsert: vi.fn<(key: string, value: string) => void>(),
    guardAppWindow: vi.fn<(win: unknown) => void>(),
    isDev: false
  }
  s.upsert.mockImplementation((key, value) => void s.settings.set(key, value))
  return s
})

// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('@electron-toolkit/utils', () => ({
  is: {
    get dev() {
      return state.isDev
    }
  }
}))
vi.mock('../../../dao/settingsDao', () => ({
  settingsDao: {
    findByKey: (key: string) => state.settings.get(key),
    upsert: (key: string, value: string) => state.upsert(key, value)
  }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))
vi.mock('../../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../externalOpen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../externalOpen')>()),
  guardAppWindow: (win: unknown) => state.guardAppWindow(win)
}))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    handleExternalDetach: vi.fn(),
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: vi.fn(async () => {})
  }
}))

const fx = fakeElectron()

type ViewService = typeof import('../browserViewService')
type WindowService = typeof import('../browserWindowService')
type Bus = typeof import('../../../utils/appEventBus').appEventBus

const STATE_KEY = 'window.browserWindow'
const STAGING_BOUNDS: Rect = { x: 0, y: 0, width: 1280, height: 800 }
const REAL_PLATFORM = process.platform

/** 重新导入各模块（模块级状态全新），登记窗口服务 —— 与 index.ts 的 createWindow 同一步 */
async function load(
  theme = '#123456'
): Promise<{ views: ViewService; wins: WindowService; bus: Bus }> {
  const views = await import('../browserViewService')
  const wins = await import('../browserWindowService')
  const { appEventBus } = await import('../../../utils/appEventBus')
  wins.initBrowserWindowService({ getThemeBgColor: () => theme })
  return { views, wins, bus: appEventBus }
}

/** 一次 close 事件（用户点关闭 / window.close()） */
function fireClose(win: FakeWindow): { preventDefault: Mock } {
  const event = { preventDefault: vi.fn() }
  win.emit('close', event)
  return event
}

/** 唯一的浏览器窗口（没有 / 不止一个都算错） */
function theBrowserWindow(): FakeWindow {
  const all = fx.browserWindows()
  if (all.length !== 1) throw new Error(`expected one browser window, got ${all.length}`)
  return all[0]
}

function theStaging(): FakeWindow {
  const s = fx.staging()
  if (!s) throw new Error('停放窗口还没建出来')
  return s
}

/** 以这个 view 的名义 window.open(url)：返回 handler 的同步返回值 */
function popup(view: FakeView, url: string): unknown {
  const handler = view.webContents.openHandler
  if (!handler) throw new Error('createTab 没有登记 setWindowOpenHandler')
  return handler({ url })
}

function stubPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

/** 让出事件循环一拍（证书询问是 async 的） */
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

beforeEach(() => {
  vi.resetModules()
  fx.reset()
  state.settings.clear()
  state.upsert.mockClear()
  state.guardAppWindow.mockClear()
  state.isDev = false
})

afterEach(() => {
  vi.unstubAllEnvs()
  stubPlatform(REAL_PLATFORM)
  // 全文件的不变量
  expect(fx.hiddenViews(), 'a tab view was setVisible(false)').toEqual([])
  expect(fx.doubleParented, 'a tab view hung on two windows at once').toEqual([])
})

describe('停放窗口（ST-U1）', () => {
  it('ST-U1 第一个 tab 才建停放窗口：show:false / 不可聚焦 / 不进任务栏 / 1280×800 内容区 / 装守卫 / 从不加载页面、从不显示；view 挂在它上面铺满 1280×800；浏览器窗口不出现；第二个 tab 复用它', async () => {
    const { views, wins } = await load()
    expect(fx.windows).toHaveLength(0)

    views.createTab('https://a.example/')
    expect(fx.windows).toHaveLength(1)
    const staging = theStaging()
    expect(staging).toBe(fx.windows[0])
    expect(staging.opts).toMatchObject({
      show: false,
      focusable: false,
      skipTaskbar: true,
      useContentSize: true,
      width: 1280,
      height: 800
    })
    expect(state.guardAppWindow).toHaveBeenCalledWith(staging)
    expect(staging.loadURL).not.toHaveBeenCalled()
    expect(staging.loadFile).not.toHaveBeenCalled()

    const [v0] = fx.views
    expect(staging.children).toEqual([v0])
    expect(v0.setBounds).toHaveBeenLastCalledWith(STAGING_BOUNDS)
    expect(v0.setVisible).toHaveBeenCalledWith(true)
    expect(fx.surfacingOf(staging)).toEqual([])
    expect(staging.visible).toBe(false)
    expect(fx.browserWindows()).toEqual([])
    expect(wins.isBrowserWindowOpen()).toBe(false)

    views.createTab('https://b.example/')
    expect(fx.windows).toEqual([staging])
    const v1 = fx.views[1]
    expect(staging.children).toEqual([v0, v1])
    expect(v1.setBounds).toHaveBeenLastCalledWith(STAGING_BOUNDS)
    expect(fx.allSurfacing()).toEqual([])
    expect(wins.isBrowserWindowOpen()).toBe(false)
  })

  it('ST-U1 开发态 openBrowserWindow 从 dev server 加载，落在 #browser-window', async () => {
    state.isDev = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const { wins } = await load()
    wins.openBrowserWindow()
    const bw = theBrowserWindow()
    expect(bw.loadFile).not.toHaveBeenCalled()
    expect(bw.loadURL).toHaveBeenCalledWith('http://localhost:5173#browser-window')
  })
})

describe('只有用户能把浏览器窗口弄出来（ST-U2）', () => {
  it('ST-U2 openBrowserWindow 建出窗口（加载 #browser-window、装守卫）并 show + focus；没有 tab 时不建停放窗口；关窗（隐藏）后再点复用同一个实例', async () => {
    const { wins } = await load()
    wins.openBrowserWindow()
    expect(fx.windows).toHaveLength(1)
    const bw = theBrowserWindow()
    expect(fx.staging()).toBeUndefined()
    expect(bw.opts.show).toBe(false)
    expect(bw.loadFile).toHaveBeenCalledTimes(1)
    expect(bw.loadFile.mock.calls[0][1]).toEqual({ hash: 'browser-window' })
    expect(state.guardAppWindow).toHaveBeenCalledWith(bw)
    expect(bw.show).toHaveBeenCalledTimes(1)
    expect(bw.focus).toHaveBeenCalledTimes(1)
    expect(bw.showInactive).not.toHaveBeenCalled()
    expect(wins.isBrowserWindowOpen()).toBe(true)

    const event = fireClose(bw)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(bw.hide).toHaveBeenCalledTimes(1)
    expect(wins.isBrowserWindowOpen()).toBe(false)

    fx.clearCalls()
    wins.openBrowserWindow()
    expect(fx.windows).toEqual([bw])
    expect(bw.show).toHaveBeenCalledTimes(1)
    expect(bw.focus).toHaveBeenCalledTimes(1)
    expect(bw.destroy).not.toHaveBeenCalled()
    expect(wins.isBrowserWindowOpen()).toBe(true)
  })

  it('ST-U2 最小化的窗口：用户点开时先 restore，再 show + focus', async () => {
    const { wins } = await load()
    wins.openBrowserWindow()
    const bw = theBrowserWindow()
    bw.minimized = true
    bw.visible = false
    fx.clearCalls()

    wins.openBrowserWindow()
    expect(fx.windows).toEqual([bw])
    expect(bw.restore).toHaveBeenCalledTimes(1)
    expect(bw.show).toHaveBeenCalledTimes(1)
    expect(bw.focus).toHaveBeenCalledTimes(1)
  })

  it('ST-U2 有 tab 时开窗：只有浏览器窗口被 show + focus，停放窗口从不显示、从不聚焦', async () => {
    const { views, wins } = await load()
    views.createTab('https://a.example/', { activate: true })
    wins.openBrowserWindow()
    fireClose(theBrowserWindow())
    wins.openBrowserWindow()

    expect(fx.surfacingOf(theStaging())).toEqual([])
    expect(theStaging().visible).toBe(false)
    expect(fx.surfacingOf(theBrowserWindow())).toEqual(['show×2', 'focus×2'])
  })
})

/** ST-U3 / ST-U10 的四种窗口状态 */
const WINDOW_STATES = [
  ['a', 'never created'],
  ['b', 'visible, not focused'],
  ['c', 'hidden via close'],
  ['d', 'minimized, reporting visible:false']
] as const
type WindowStateId = (typeof WINDOW_STATES)[number][0]

/** 把浏览器窗口摆成某个状态（用户自己的操作），然后清掉全部动作记录 */
function arrange(wins: WindowService, id: WindowStateId): FakeWindow | undefined {
  if (id === 'a') {
    fx.clearCalls()
    return undefined
  }
  wins.openBrowserWindow()
  const bw = theBrowserWindow()
  if (id === 'b') bw.focused = false
  if (id === 'c') fireClose(bw)
  if (id === 'd') {
    bw.minimized = true
    bw.visible = false
    bw.focused = false
  }
  fx.clearCalls()
  return bw
}

describe('tab 的动作不碰浏览器窗口（ST-U3）', () => {
  it.each(WINDOW_STATES)(
    'ST-U3 (%s) 浏览器窗口 %s：建 / 空白建 / 激活 / 抓图 / window.open https / 关 —— 不建窗口、不弄到眼前、不 app.focus、不弹框',
    async (id) => {
      const { views, wins } = await load()
      const bw = arrange(wins, id)
      const browserWindowsBefore = fx.browserWindows().length

      const a = views.createTab('https://a.example/', { activate: true })
      const blank = views.createTab()
      views.activateTab(blank)
      expect(await views.captureTab(a)).toMatch(/^data:image\/png;base64,/)
      expect(popup(fx.views[0], 'https://b/')).toStrictEqual({ action: 'deny' })
      expect(fx.views).toHaveLength(3)
      expect(views.listTabs().find((t) => t.url === 'https://b/')?.active).toBe(true)
      views.closeTab(blank)
      await flush()

      expect(fx.browserWindows()).toHaveLength(browserWindowsBefore)
      expect(fx.windows).toHaveLength(browserWindowsBefore + 1) // + 停放窗口
      expect(fx.allSurfacing()).toEqual([])
      expect(fx.dialog.showMessageBox).not.toHaveBeenCalled()
      expect(fx.shell.openExternal).not.toHaveBeenCalled()
      // 全部 tab 都在停放窗口里（浏览器窗口的 renderer 没报过布局表）
      expect(theStaging().children.map((v) => v.label)).toEqual(['v0', 'v2'])
      if (id === 'c') expect(wins.isBrowserWindowOpen()).toBe(false)
      if (id === 'd') expect(bw?.minimized).toBe(true)
      if (bw) expect(bw.children).toEqual([])
    }
  )
})

describe('关窗 = 隐藏，退出才销毁（ST-U4）', () => {
  it('ST-U4 两个 tab 时点关闭：拦下（preventDefault）并隐藏，不销毁；tab 与 view 原样、都还在停放窗口；再打开不建新窗口、不挂 view', async () => {
    const { views, wins } = await load()
    wins.openBrowserWindow()
    const a = views.createTab('https://a.example/')
    const b = views.createTab('https://b.example/')
    const bw = theBrowserWindow()
    fx.clearCalls()

    const event = fireClose(bw)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(bw.hide).toHaveBeenCalledTimes(1)
    expect(bw.destroy).not.toHaveBeenCalled()
    expect(views.listTabs().map((t) => t.id)).toEqual([a, b])
    expect(views.getTabView(a)).toBe(fx.views[0])
    expect(views.getTabView(b)).toBe(fx.views[1])
    expect(theStaging().children).toEqual([fx.views[0], fx.views[1]])
    expect(fx.log).toEqual([])
    expect(wins.isBrowserWindowOpen()).toBe(false)

    wins.openBrowserWindow()
    expect(fx.browserWindows()).toEqual([bw])
    expect(wins.isBrowserWindowOpen()).toBe(true)
    expect(bw.contentView.addChildView).not.toHaveBeenCalled()
  })

  it('ST-U4 before-quit 之后的 close 不再拦（app 才退得掉）', async () => {
    const { wins } = await load()
    wins.openBrowserWindow()
    const bw = theBrowserWindow()

    // 正控制组：退出前照拦
    expect(fireClose(bw).preventDefault).toHaveBeenCalledTimes(1)

    fx.emitApp('before-quit')
    bw.hide.mockClear()
    const event = fireClose(bw)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(bw.hide).not.toHaveBeenCalled()
  })

  it('ST-U4 destroyBrowserWindow：销毁窗口、存下位置尺寸（一次）；之后 createTab 照常 —— 不抛、不建浏览器窗口、view 落在停放窗口', async () => {
    const { views, wins } = await load()
    wins.openBrowserWindow()
    views.createTab('https://a.example/')
    views.createTab('https://b.example/')
    const bw = theBrowserWindow()
    fx.bounds = { x: 33, y: 44, width: 1000, height: 640 }
    state.upsert.mockClear()

    wins.destroyBrowserWindow()
    expect(bw.destroy).toHaveBeenCalledTimes(1)
    expect(bw.hide).not.toHaveBeenCalled()
    expect(state.upsert).toHaveBeenCalledTimes(1)
    const [key, value] = state.upsert.mock.calls[0]
    expect(key).toBe(STATE_KEY)
    expect(JSON.parse(value)).toEqual({ x: 33, y: 44, width: 1000, height: 640 })
    expect(wins.isBrowserWindowOpen()).toBe(false)

    const windowsBefore = fx.windows.length
    expect(() => views.createTab('https://c.example/')).not.toThrow()
    expect(fx.windows).toHaveLength(windowsBefore)
    expect(fx.browserWindows()).toEqual([bw])
    expect(theStaging().children).toContain(fx.views[2])
    expect(fx.surfacingOf(bw)).toEqual(['show×1', 'focus×1']) // 只有 openBrowserWindow 那一次
    expect(state.upsert).toHaveBeenCalledTimes(1)
  })
})

describe('布局表只认宿主窗口（ST-U5）', () => {
  it('ST-U5 isHostWebContents：没有窗口时谁都不认；有了只认它自己的 webContents（7 不认 9）；窗口销毁后连 7 也不认', async () => {
    const { views, wins } = await load()
    expect(views.isHostWebContents(7)).toBe(false)

    wins.openBrowserWindow()
    const bw = theBrowserWindow()
    expect(bw.webContents.id).toBe(7)
    expect(views.isHostWebContents(7)).toBe(true)
    expect(views.isHostWebContents(9)).toBe(false)

    bw.destroyed = true
    expect(views.isHostWebContents(7)).toBe(false)
  })
})

describe('上墙与下墙（ST-U7）', () => {
  /** 槽矩形（CSS px）：×1.25 之后有进位有舍去，才看得出取整 */
  const RA: Rect = { x: 3, y: 41, width: 577, height: 371 }
  const RB: Rect = { x: 591, y: 41, width: 577, height: 371 }
  const scaled = (r: Rect): Rect => ({
    x: Math.round(r.x * 1.25),
    y: Math.round(r.y * 1.25),
    width: Math.round(r.width * 1.25),
    height: Math.round(r.height * 1.25)
  })

  /** 浏览器窗口开着（宿主 zoom 1.25），A、B 两张卡片在墙上（页面缩放 0.5） */
  async function onTheWall(): Promise<{
    views: ViewService
    bw: FakeWindow
    a: string
    b: string
    va: FakeView
    vb: FakeView
    entries: Array<{ tabId: string; bounds: Rect; zoom: number }>
  }> {
    const { views, wins } = await load()
    wins.openBrowserWindow()
    const bw = theBrowserWindow()
    bw.webContents.zoom = 1.25
    const a = views.createTab('https://a.example/')
    const b = views.createTab('https://b.example/')
    const [va, vb] = fx.views
    const entries = [
      { tabId: a, bounds: RA, zoom: 0.5 },
      { tabId: b, bounds: RB, zoom: 0.5 }
    ]
    views.setLayout(entries)
    views.setPanelVisible(true)
    return { views, bw, a, b, va, vb, entries }
  }

  it('ST-U7 上墙：view 挂到浏览器窗口、矩形 = 槽 ×1.25 取整、页面缩放 0.5、setVisible(true)；停放窗口空了', async () => {
    const { bw, va, vb } = await onTheWall()
    expect(bw.children).toEqual([va, vb])
    expect(theStaging().children).toEqual([])
    expect(va.setBounds).toHaveBeenLastCalledWith(scaled(RA))
    expect(vb.setBounds).toHaveBeenLastCalledWith(scaled(RB))
    expect(scaled(RA)).toEqual({ x: 4, y: 51, width: 721, height: 464 })
    expect(va.webContents.zoom).toBe(0.5)
    expect(va.webContents.setZoomFactor).toHaveBeenLastCalledWith(0.5)
    expect(va.setVisible).toHaveBeenLastCalledWith(true)
    expect(vb.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('ST-U7 重复同一张表 / 同一个墙级门：一次增删都没有', async () => {
    const { views, entries } = await onTheWall()
    fx.clearCalls()
    views.setLayout(entries)
    views.setPanelVisible(true)
    views.setLayout([...entries])
    expect(fx.log).toEqual([])
  })

  it.each([
    ['布局表里没了 A', 'layout-without-a'],
    ['墙级门关（setPanelVisible(false)）', 'panel-hidden'],
    ['换宿主为 null（setHostWindow(null)）', 'host-null']
  ] as const)(
    'ST-U7 下墙：%s —— 先从浏览器窗口摘下再挂到停放窗口、铺回 1280×800、页面缩放不动（仍 0.5）、不 setVisible(false)',
    async (_label, exit) => {
      const { views, bw, b, va, vb } = await onTheWall()
      fx.clearCalls()

      if (exit === 'layout-without-a') {
        views.setLayout([{ tabId: b, bounds: RB, zoom: 0.5 }])
      } else if (exit === 'panel-hidden') {
        views.setPanelVisible(false)
      } else {
        views.setHostWindow(null)
      }

      const affected = exit === 'layout-without-a' ? [va] : [va, vb]
      const staging = theStaging()
      for (const v of affected) {
        const removed = fx.log.indexOf(`${bw.label}.remove(${v.label})`)
        const added = fx.log.indexOf(`staging.add(${v.label})`)
        expect(removed, `${v.label} removed from the browser window`).toBeGreaterThanOrEqual(0)
        expect(added, `${v.label} added to staging`).toBeGreaterThan(removed)
        expect(staging.children).toContain(v)
        expect(bw.children).not.toContain(v)
        expect(v.setBounds).toHaveBeenLastCalledWith(STAGING_BOUNDS)
        // Chromium 的缩放按 host 共享：停放时重置会跟墙上的同站卡片打架
        expect(v.webContents.setZoomFactor).not.toHaveBeenCalled()
        expect(v.webContents.zoom).toBe(0.5)
        expect(v.setVisible).toHaveBeenLastCalledWith(true)
      }
      if (exit === 'layout-without-a') {
        // B 还在墙上，一动没动
        expect(fx.log.filter((line) => line.includes(`(${vb.label})`))).toEqual([])
        expect(bw.children).toEqual([vb])
      }
    }
  )
})

describe('主窗口关闭联动（ST-U8）', () => {
  it.each(['darwin', 'win32'] as const)(
    'ST-U8 %s：墙上的 tab 先停回停放窗口再销毁浏览器窗口（销毁不是隐藏）、状态存一次',
    async (platform) => {
      stubPlatform(platform)
      const { views, wins } = await load()
      wins.openBrowserWindow()
      const first = theBrowserWindow()
      const a = views.createTab('https://a.example/')
      const b = views.createTab('https://b.example/')
      const [va, vb] = fx.views
      const staging = theStaging()
      views.setLayout([
        { tabId: a, bounds: { x: 0, y: 40, width: 580, height: 372 }, zoom: 0.53 },
        { tabId: b, bounds: { x: 590, y: 40, width: 580, height: 372 }, zoom: 0.53 }
      ])
      views.setPanelVisible(true)
      expect(first.children).toEqual([va, vb])
      fx.bounds = { x: 5, y: 6, width: 1111, height: 777 }
      fx.clearCalls()
      state.upsert.mockClear()

      wins.closeBrowserWindowWithMain()

      // 墙上的两张先回停放窗口，然后才销毁浏览器窗口
      expect(fx.log.slice(0, 5)).toEqual([
        `${first.label}.remove(v0)`,
        'staging.add(v0)',
        `${first.label}.remove(v1)`,
        'staging.add(v1)',
        `${first.label}.destroy`
      ])
      expect(first.destroy).toHaveBeenCalledTimes(1)
      expect(first.hide).not.toHaveBeenCalled()
      expect(state.upsert).toHaveBeenCalledTimes(1)
      expect(state.upsert.mock.calls[0][0]).toBe(STATE_KEY)
      expect(JSON.parse(state.upsert.mock.calls[0][1])).toEqual({
        x: 5,
        y: 6,
        width: 1111,
        height: 777
      })
      expect(wins.isBrowserWindowOpen()).toBe(false)
      expect(views.isHostWebContents(first.webContents.id)).toBe(false)

      if (platform === 'win32') {
        // 关主窗口就是要退出：tab 全部关掉，停放窗口也销毁（隐藏窗口会挡住 window-all-closed）
        expect(views.listTabs()).toEqual([])
        expect(va.webContents.close).toHaveBeenCalledTimes(1)
        expect(vb.webContents.close).toHaveBeenCalledTimes(1)
        expect(staging.destroyed).toBe(true)
        return
      }

      // macOS：tab 与停放窗口都留着，主窗口关着时后台 agent 照样能用
      expect(views.listTabs().map((t) => t.id)).toEqual([a, b])
      expect(staging.destroyed).toBe(false)
      expect(staging.children).toEqual([va, vb])
      expect(va.webContents.close).not.toHaveBeenCalled()
      views.createTab('https://c.example/')
      const vc = fx.views[2]
      expect(fx.windows.filter((w) => w.opts.focusable === false)).toEqual([staging])
      expect(staging.children).toContain(vc)
    }
  )

  it('ST-U8 win32 关主窗口之后：再开浏览器窗口、再开 tab —— 新停放窗口按需再建，旧的不复用', async () => {
    stubPlatform('win32')
    const { views, wins } = await load()
    wins.openBrowserWindow()
    views.createTab('https://a.example/')
    const oldStaging = theStaging()
    wins.closeBrowserWindowWithMain()
    expect(oldStaging.destroyed).toBe(true)

    wins.openBrowserWindow()
    views.createTab('https://b.example/')
    const stagings = fx.windows.filter((w) => w.opts.focusable === false)
    expect(stagings).toHaveLength(2)
    expect(stagings[1]).not.toBe(oldStaging)
    expect(stagings[1].destroyed).toBe(false)
    expect(stagings[1].children).toEqual([fx.views[1]])
    expect(views.listTabs()).toHaveLength(1)
  })

  it('ST-U8 darwin 重开：新窗口按存下的尺寸建、开窗时一个 view 都不挂；新宿主的墙级门先到也不上墙；新宿主报了布局表才上墙', async () => {
    stubPlatform('darwin')
    const { views, wins } = await load()
    wins.openBrowserWindow()
    const first = theBrowserWindow()
    const a = views.createTab('https://a.example/')
    const b = views.createTab('https://b.example/')
    const c = views.createTab('https://c.example/')
    const [va, vb, vc] = fx.views
    const entries = [
      { tabId: a, bounds: { x: 0, y: 40, width: 580, height: 372 }, zoom: 0.53 },
      { tabId: b, bounds: { x: 590, y: 40, width: 580, height: 372 }, zoom: 0.53 }
    ]
    views.setLayout(entries)
    views.setPanelVisible(true)
    fx.bounds = { x: 5, y: 6, width: 1111, height: 777 }
    wins.closeBrowserWindowWithMain()

    wins.openBrowserWindow()
    const all = fx.browserWindows()
    expect(all).toHaveLength(2)
    const second = all[1]
    expect(second).not.toBe(first)
    expect(second.opts).toMatchObject({ x: 5, y: 6, width: 1111, height: 777, show: false })
    expect(second.contentView.addChildView).not.toHaveBeenCalled()
    expect(second.show).toHaveBeenCalledTimes(1)
    expect(second.focus).toHaveBeenCalledTimes(1)
    expect(views.isHostWebContents(second.webContents.id)).toBe(true)
    expect(wins.isBrowserWindowOpen()).toBe(true)

    // 新宿主的墙级门先到：表还是空的（换宿主时作废了），谁都不上墙
    views.setPanelVisible(true)
    expect(second.contentView.addChildView).not.toHaveBeenCalled()
    expect(
      theStaging()
        .children.map((v) => v.label)
        .sort()
    ).toEqual([va, vb, vc].map((v) => v.label))

    // 新宿主报了布局表：A、B 从停放窗口搬上新窗口，C 不在表里、留在停放窗口
    fx.clearCalls()
    views.setLayout(entries)
    expect(second.children).toEqual([va, vb])
    expect(theStaging().children).toEqual([vc])
    expect(fx.log).toEqual([
      'staging.remove(v0)',
      `${second.label}.add(v0)`,
      'staging.remove(v1)',
      `${second.label}.add(v1)`
    ])
    expect(first.contentView.addChildView).not.toHaveBeenCalled()
    expect(views.listTabs().map((t) => t.id)).toEqual([a, b, c])
  })

  it('ST-U8 浏览器窗口从没建过时主窗口关闭（macOS）：不建窗口、不存状态', async () => {
    stubPlatform('darwin')
    const { wins } = await load()
    wins.closeBrowserWindowWithMain()
    expect(fx.windows).toHaveLength(0)
    expect(state.upsert).not.toHaveBeenCalled()
  })
})

describe('证书错误只在用户正看着浏览器窗口时问（ST-U9）', () => {
  const HOST = 'self-signed.example'
  const URL_A = `https://${HOST}/a`

  interface CertCall {
    event: { preventDefault: Mock }
    cb: Mock<(trusted: boolean) => void>
    done: Promise<unknown>
  }

  /** 以 view 的名义报一次证书错误；done 在处理函数（async）走完时落定 */
  function certError(view: FakeView, url = URL_A): CertCall {
    const event = { preventDefault: vi.fn() }
    const cb = vi.fn<(trusted: boolean) => void>()
    const results = view.webContents.fire(
      'certificate-error',
      event,
      url,
      'net::ERR_CERT_AUTHORITY_INVALID',
      {},
      cb
    )
    expect(results, 'createTab 没有登记 certificate-error 处理函数').toHaveLength(1)
    return { event, cb, done: Promise.resolve(results[0]) }
  }

  /** 下一次询问框一直不答，返回作答函数（0 = 继续访问，1 = 取消） */
  function holdNextDialog(): (response: number) => void {
    let answer: ((value: { response: number }) => void) | undefined
    fx.dialog.showMessageBox.mockImplementationOnce(() => new Promise((r) => (answer = r)))
    return (response) => {
      if (!answer) throw new Error('询问框还没弹出来')
      answer({ response })
    }
  }

  type Front = 'none' | 'hidden' | 'unfocused' | 'minimized' | 'front'

  /** 一个 tab + 浏览器窗口摆成某个状态；每个状态只差一个条件，四个判据各自有用例盯着 */
  async function setup(front: Front): Promise<{ view: FakeView; bw: FakeWindow | undefined }> {
    const { views, wins } = await load()
    views.createTab('https://opener.example/')
    const view = fx.views[0]
    if (front === 'none') return { view, bw: undefined }
    wins.openBrowserWindow()
    const bw = theBrowserWindow()
    const flags: Record<Exclude<Front, 'none'>, [boolean, boolean, boolean]> = {
      // [visible, minimized, focused]
      hidden: [false, false, true],
      unfocused: [true, false, false],
      minimized: [true, true, true],
      front: [true, false, true]
    }
    ;[bw.visible, bw.minimized, bw.focused] = flags[front]
    fx.clearCalls()
    return { view, bw }
  }

  afterEach(() => {
    // 从不挂在停放窗口上
    const staging = fx.staging()
    for (const [parent] of fx.dialog.showMessageBox.mock.calls) {
      expect(parent).not.toBe(staging)
    }
  })

  it('ST-U9 设置里开了「忽略证书错误」：直接放行，不弹框（窗口在前台也不问）', async () => {
    state.settings.set('tool.browser.ignoreCertificateErrors', 'true')
    const { view } = await setup('front')
    const call = certError(view)
    await call.done
    expect(call.event.preventDefault).toHaveBeenCalledTimes(1)
    expect(call.cb).toHaveBeenCalledWith(true)
    expect(fx.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it.each(['none', 'hidden', 'unfocused', 'minimized'] as const)(
    'ST-U9 浏览器窗口 %s：静默拒绝（cb(false)），不弹框',
    async (front) => {
      const { view } = await setup(front)
      const call = certError(view)
      await call.done
      expect(call.event.preventDefault).toHaveBeenCalledTimes(1)
      expect(call.cb).toHaveBeenCalledTimes(1)
      expect(call.cb).toHaveBeenCalledWith(false)
      expect(fx.dialog.showMessageBox).not.toHaveBeenCalled()
      expect(fx.allSurfacing()).toEqual([])
    }
  )

  it('ST-U9 窗口可见且有焦点：恰好一个挂在浏览器窗口上的框；点继续 → cb(true) 且信任该 host —— 之后窗口没焦点也直接放行', async () => {
    const { view, bw } = await setup('front')
    const answer = holdNextDialog()
    const first = certError(view)
    await flush()
    expect(fx.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(fx.dialog.showMessageBox.mock.calls[0][0]).toBe(bw)
    expect(first.cb).not.toHaveBeenCalled()

    answer(0)
    await first.done
    expect(first.event.preventDefault).toHaveBeenCalledTimes(1)
    expect(first.cb).toHaveBeenCalledWith(true)

    bw!.focused = false
    const second = certError(view, `https://${HOST}/other`)
    await second.done
    expect(second.cb).toHaveBeenCalledWith(true)
    expect(fx.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('ST-U9 点取消 → cb(false)，不信任；下一次（窗口仍在前台）再问', async () => {
    const { view } = await setup('front')
    const answer = holdNextDialog()
    const first = certError(view)
    await flush()
    answer(1)
    await first.done
    expect(first.cb).toHaveBeenCalledWith(false)

    const second = certError(view)
    await flush()
    expect(fx.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    await second.done // 缺省回答是取消
    expect(second.cb).toHaveBeenCalledWith(false)
  })

  it('ST-U9 同一 host 的两次并发错误：只弹一个框，两个回调都拿到这个回答', async () => {
    const { view } = await setup('front')
    const answer = holdNextDialog()
    const one = certError(view, `https://${HOST}/page`)
    const two = certError(view, `https://${HOST}/style.css`)
    await flush()
    expect(fx.dialog.showMessageBox).toHaveBeenCalledTimes(1)

    answer(0)
    await Promise.all([one.done, two.done])
    expect(one.cb).toHaveBeenCalledWith(true)
    expect(two.cb).toHaveBeenCalledWith(true)
    expect(fx.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('ST-U9 静默拒绝不等于信任：窗口没焦点时拒掉的 host，用户回到窗口后重试照样问', async () => {
    const { view, bw } = await setup('unfocused')
    const silent = certError(view)
    await silent.done
    expect(silent.cb).toHaveBeenCalledWith(false)
    expect(fx.dialog.showMessageBox).not.toHaveBeenCalled()

    bw!.focused = true
    const retry = certError(view)
    await flush()
    expect(fx.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(fx.dialog.showMessageBox.mock.calls[0][0]).toBe(bw)
    await retry.done
    expect(retry.cb).toHaveBeenCalledWith(false)
  })

  it('ST-U9 解析不了的地址：cb(false)，不弹框（窗口在前台也一样）', async () => {
    const { view } = await setup('front')
    const call = certError(view, 'not a url')
    await call.done
    expect(call.event.preventDefault).toHaveBeenCalledTimes(1)
    expect(call.cb).toHaveBeenCalledWith(false)
    expect(fx.dialog.showMessageBox).not.toHaveBeenCalled()
  })
})

describe('tab 数的应用事件（ST-U11）', () => {
  it('ST-U11 每次建 / 关成功各一条 browser.tabsChanged，count = 此刻 listTabs 的长度；关不存在的、开第 13 个都不发', async () => {
    const { views, bus } = await load()
    const seen: Array<{ count: number; listed: number }> = []
    bus.subscribe((event) => {
      if (event.type === 'browser.tabsChanged') {
        seen.push({ count: event.count, listed: views.listTabs().length })
      }
    })

    const a = views.createTab('https://a.example/')
    expect(seen).toEqual([{ count: 1, listed: 1 }])
    views.createTab('https://b.example/')
    expect(seen.at(-1)).toEqual({ count: 2, listed: 2 })
    // 页面 window.open 转来的 http(s)：也是一次建 tab
    popup(fx.views[0], 'https://c.example/')
    expect(seen.at(-1)).toEqual({ count: 3, listed: 3 })
    views.closeTab(a)
    expect(seen.at(-1)).toEqual({ count: 2, listed: 2 })
    expect(seen).toHaveLength(4)

    views.closeTab('nope')
    expect(seen).toHaveLength(4)

    for (let i = 3; i <= 12; i++) views.createTab(`https://t${i}.example/`)
    expect(seen).toHaveLength(14)
    expect(seen.at(-1)).toEqual({ count: 12, listed: 12 })

    expect(() => views.createTab('https://thirteen.example/')).toThrow(/Too many browser tabs/)
    expect(seen).toHaveLength(14)
    for (const s of seen) expect(s.count).toBe(s.listed)
  })
})

describe('initBrowserWindowService 幂等（ST-U12）', () => {
  it('ST-U12 调两次：before-quit 只登记一次；主题色取法换成新的', async () => {
    const { wins } = await load('#111111')
    wins.initBrowserWindowService({ getThemeBgColor: () => '#abcdef' })
    expect(fx.appHandlers.get('before-quit')).toHaveLength(1)

    wins.openBrowserWindow()
    const bw = theBrowserWindow()
    expect(bw.opts.backgroundColor).toBe('#abcdef')
    // 窗口自己的 close 拦截也只挂了一次
    expect(bw.handlerCount('close')).toBe(1)
  })
})
