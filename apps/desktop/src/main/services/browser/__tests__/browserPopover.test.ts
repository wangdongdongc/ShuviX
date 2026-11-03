/**
 * 浏览器窗口的弹层（站点信息气泡、地址栏下拉）住的透明 view（browserPopover.ts）：页面一动不动，弹层画在它上面。
 *
 *   BPV-1   页面在墙上，弹层开、挪、关：页面的 view 什么都没收到（矩形、可见性、缩放、抓图、增删），停放窗口不变；
 *   BPV-2   外壳 window.open('about:blank', 约定的名字) → allow；createWindow 回 Electron 给的 webContents，
 *           view 挂在窗口上、0×0、背景全透明；
 *   BPV-3   名字或地址对不上（别的名字、空名字、https、about:blank#x）→ 回 null，走窗口原有的守卫；
 *   BPV-4   弹层的 webContents：window.open 一律 deny、不交给系统；导航一律拦下；⌘W 拦下并照常关掉选中的页；
 *   BPV-5   矩形按外壳的缩放换算（CSS px → DIP）；缩放不一样才 setZoomFactor，第二次不再调；
 *   BPV-6   关 = 尺寸 0，不摘下、不 setVisible(false)；之后照样能再开；
 *   BPV-7   take：窗口在前台，打开时把焦点给弹层一次；重报不再给；
 *   BPV-8   take：窗口没焦点 / 隐藏 / 最小化：矩形照摆，焦点不动，也不把窗口弄到眼前；
 *   BPV-9   keep-shell：打开不拿焦点；系统把焦点给了弹层 → 还给外壳，窗口不在前台时不还；
 *   BPV-10  take 时、关着时收到 focus 事件：不还给外壳；
 *   BPV-11  关的时候焦点在弹层上且窗口在前台 → 还给外壳；否则不动；
 *   BPV-12  开着时新挂上的 view（换了页、DevTools 前端、切 tab）不盖住弹层：先挂它，再把弹层提上来；
 *   BPV-13  关着时页面挂上来不提弹层（没有多余的增删）；打开时才放到最上面；
 *   BPV-14  开着时重报、页面停回停放窗口：弹层不增删；
 *   BPV-15  还没有弹层、webContents 销毁了、view.webContents 没了：开关 / 提上来 / 收掉都不抛、什么也不做；
 *   BPV-16  窗口没了（closed 事件、closeBrowserWindowWithMain、destroyBrowserWindow）：窗口还活着就摘下，webContents
 *           关一次；之后再设什么也不做，再收一次不抛；
 *   BPV-17  关窗 = 隐藏，弹层留着；真销毁后新窗口的弹层把焦点还给新窗口的外壳；
 *   BPV-18  第二次 window.open：旧 view 摘下、旧 webContents 关掉，只动新的。
 *
 * electron 是 ./fakeElectron.ts；browserViewService / browserWindowService / devtoolsDock / 本模块都是真的。
 * window.open 的处理函数从 guardAppWindow 的第三个参数拿（那是外壳窗口真正装上去的）。
 * 全文件不变量（afterEach）：没有 view 被 setVisible 过 true 以外的值，没有 view 同时挂在两个窗口上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fakeElectron,
  type FakeView,
  type FakeViewWebContents,
  type FakeWindow,
  type Rect
} from './fakeElectron'
import { BROWSER_POPOVER_FRAME } from '../../../../shared/browserPopover'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

type OpenDetails = { url: string; frameName: string }
type OpenResponse = { action: string; createWindow: (options: unknown) => unknown } | null

const state = vi.hoisted(() => ({
  allowOpen: new Map<unknown, (details: OpenDetails) => OpenResponse>()
}))

// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../dao/settingsDao', () => ({
  settingsDao: { findByKey: () => undefined, upsert: () => {} }
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}))
vi.mock('../../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../externalOpen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../externalOpen')>()),
  guardAppWindow: (
    win: unknown,
    _source?: unknown,
    allowOpen?: (details: OpenDetails) => OpenResponse
  ) => {
    if (allowOpen) state.allowOpen.set(win, allowOpen)
  }
}))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    session: vi.fn(async () => ({ enableDialogHandling: async () => {} })),
    handleExternalDetach: vi.fn(),
    detach: vi.fn(async () => {}),
    cdpState: () => ({ attached: false, intercepting: false }),
    peek: () => undefined,
    detachAll: vi.fn(async () => {})
  }
}))

const fx = fakeElectron()

type ViewService = typeof import('../browserViewService')
type WindowService = typeof import('../browserWindowService')
type PopoverModule = typeof import('../browserPopover')
type Dock = typeof import('../devtoolsDock')

let views: ViewService
let wins: WindowService
let popover: PopoverModule
let dock: Dock

const HIDDEN: Rect = { x: 0, y: 0, width: 0, height: 0 }
const PLACEMENT = { x: 80, y: 42, width: 360, height: 244 }
const PAGE = { x: 0, y: 76, width: 900, height: 400 }
const VIEWPORT = { width: 900, height: 476 }

/** 用户把浏览器窗口打开（可见、有焦点），清掉开窗本身的动作记录 */
function openByUser(): FakeWindow {
  wins.openBrowserWindow()
  const bw = fx.browserWindows().at(-1)
  if (!bw) throw new Error('no browser window')
  fx.clearCalls()
  return bw
}

/** 外壳 window.open：回处理函数的同步返回值 */
function shellOpen(
  bw: FakeWindow,
  url = 'about:blank',
  frameName = BROWSER_POPOVER_FRAME
): OpenResponse {
  const handler = state.allowOpen.get(bw)
  if (!handler) throw new Error('guardAppWindow did not get allowOpen')
  return handler({ url, frameName })
}

/** 外壳开出那块透明 view（Electron 建好 webContents、交给 createWindow） */
function mintPopover(bw: FakeWindow): { view: FakeView; wc: FakeViewWebContents } {
  const res = shellOpen(bw)
  if (!res) throw new Error('window.open was refused')
  const wc = fx.mintWebContents()
  res.createWindow({ webContents: wc })
  const view = fx.views.find((v) => v.webContents === wc)
  if (!view) throw new Error('no view around the webContents')
  return { view, wc }
}

/** 单页视图：这一页上墙 */
function onPage(tabId: string): void {
  views.setPanelVisible(true)
  views.setLayout([{ tabId, bounds: PAGE, viewport: VIEWPORT }])
}

/** 建一个 tab，回它的 id 与 view */
function tab(url = 'https://a.example/', activate = true): { id: string; view: FakeView } {
  const id = views.createTab(url, { activate })
  return { id, view: fx.views[fx.views.length - 1] }
}

const open = (focus: 'take' | 'keep-shell' = 'take', bounds = PLACEMENT): void =>
  popover.setBrowserPopover({ bounds, focus })

beforeEach(async () => {
  vi.resetModules()
  fx.reset()
  state.allowOpen.clear()
  views = await import('../browserViewService')
  wins = await import('../browserWindowService')
  popover = await import('../browserPopover')
  dock = await import('../devtoolsDock')
  wins.initBrowserWindowService({ getThemeBgColor: () => '#000000' })
})

afterEach(() => {
  expect(fx.hiddenViews(), 'a view was setVisible(false)').toEqual([])
  expect(fx.doubleParented, 'a view hung on two windows at once').toEqual([])
})

describe('页面一动不动（BPV-1）', () => {
  it('BPV-1 页面在墙上，弹层开、挪、关：页面的 view 什么都没收到，停放窗口不变', () => {
    const bw = openByUser()
    const a = tab()
    const other = tab('https://b.example/', false)
    onPage(a.id)
    const { view: pop } = mintPopover(bw)
    const staging = fx.staging()!
    const stagingBefore = [...staging.children]
    expect(stagingBefore).toEqual([other.view])
    a.view.setBounds.mockClear()
    a.view.setVisible.mockClear()
    a.view.webContents.setZoomFactor.mockClear()
    a.view.webContents.capturePage.mockClear()
    fx.log.length = 0

    open('take')
    open('take', { ...PLACEMENT, height: 300 })
    popover.setBrowserPopover(null)

    expect(a.view.setBounds).not.toHaveBeenCalled()
    expect(a.view.setVisible).not.toHaveBeenCalled()
    expect(a.view.webContents.setZoomFactor).not.toHaveBeenCalled()
    expect(a.view.webContents.capturePage).not.toHaveBeenCalled()
    expect(fx.log.filter((line) => line.includes(`(${a.view.label})`))).toEqual([])
    expect(fx.log.filter((line) => line.startsWith('staging'))).toEqual([])
    expect(staging.children).toEqual(stagingBefore)
    expect(bw.children).toContain(a.view)
    expect(bw.children).toContain(pop)
  })
})

describe('外壳的 window.open（BPV-2 / BPV-3）', () => {
  it('BPV-2 about:blank + 约定的名字：allow；createWindow 回给的 webContents；view 是窗口的子 view、0×0、背景全透明', () => {
    const bw = openByUser()
    const res = shellOpen(bw)
    expect(res?.action).toBe('allow')
    const wc = fx.mintWebContents()
    expect(res?.createWindow({ webContents: wc })).toBe(wc)

    const view = fx.views.at(-1)!
    expect(view.webContents).toBe(wc)
    expect(bw.children).toContain(view)
    expect(view.setBounds).toHaveBeenLastCalledWith(HIDDEN)
    expect(view.setBackgroundColor.mock.calls).toEqual([['#00000000']])
  })

  it.each([
    ['about:blank + 别的名字', 'about:blank', 'somewhere-else'],
    ['about:blank + 空名字', 'about:blank', ''],
    ['https + 约定的名字', 'https://evil.example/', BROWSER_POPOVER_FRAME],
    ['about:blank#x + 约定的名字', 'about:blank#x', BROWSER_POPOVER_FRAME]
  ])('BPV-3 %s：回 null，什么 view 都不建', (_label, url, frameName) => {
    const bw = openByUser()
    const viewsBefore = fx.views.length
    expect(shellOpen(bw, url, frameName)).toBeNull()
    expect(fx.views).toHaveLength(viewsBefore)
  })
})

describe('弹层自己的 webContents（BPV-4）', () => {
  const REAL_PLATFORM = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  })

  it('BPV-4 window.open 一律 deny、不交给系统；导航一律拦下', () => {
    const bw = openByUser()
    const { wc } = mintPopover(bw)
    expect(wc.openHandler?.({ url: 'https://evil.example/' })).toEqual({ action: 'deny' })
    expect(fx.shell.openExternal).not.toHaveBeenCalled()

    const nav = { preventDefault: vi.fn() }
    wc.fire('will-navigate', nav, 'https://evil.example/')
    expect(nav.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('BPV-4 焦点在弹层里按 ⌘W：拦下，照常关掉选中的那页', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const bw = openByUser()
    const a = tab()
    const { wc } = mintPopover(bw)
    const event = { preventDefault: vi.fn() }
    const handlers = wc.handlers.get('before-input-event') ?? []
    expect(handlers).toHaveLength(1)
    handlers[0](event, {
      type: 'keyDown',
      key: 'w',
      code: 'KeyW',
      shift: false,
      control: false,
      alt: false,
      meta: true
    })
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(views.listTabs().map((t) => t.id)).not.toContain(a.id)
  })
})

describe('开、关、挪（BPV-5 / BPV-6）', () => {
  it('BPV-5 矩形按外壳的缩放换算；缩放不一样才 setZoomFactor，第二次不再调', () => {
    const bw = openByUser()
    bw.webContents.zoom = 1.25
    const { view, wc } = mintPopover(bw)

    open('take')
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 100, y: 53, width: 450, height: 305 })
    expect(wc.setZoomFactor.mock.calls).toEqual([[1.25]])

    open('take')
    expect(wc.setZoomFactor).toHaveBeenCalledTimes(1)
  })

  it('BPV-6 关 = 尺寸 0，还挂着、没 setVisible；之后照样能再开', () => {
    const bw = openByUser()
    const { view } = mintPopover(bw)
    open('take')
    popover.setBrowserPopover(null)
    expect(view.setBounds).toHaveBeenLastCalledWith(HIDDEN)
    expect(bw.children).toContain(view)
    expect(fx.hiddenViews()).toEqual([])
    expect(view.setVisible).not.toHaveBeenCalled()

    open('take')
    expect(view.setBounds).toHaveBeenLastCalledWith(PLACEMENT)
    expect(bw.children.at(-1)).toBe(view)
  })
})

describe('键盘焦点（BPV-7 – BPV-11）', () => {
  it('BPV-7 take + 窗口在前台：打开时把焦点给弹层一次；重报不再给', () => {
    const bw = openByUser()
    const { wc } = mintPopover(bw)
    expect(wc.focus).not.toHaveBeenCalled()
    open('take')
    expect(wc.focus).toHaveBeenCalledTimes(1)
    open('take', { ...PLACEMENT, height: 300 })
    expect(wc.focus).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      '窗口没焦点',
      (bw: FakeWindow) => {
        bw.focused = false
      }
    ],
    [
      '窗口隐藏',
      (bw: FakeWindow) => {
        bw.visible = false
      }
    ],
    [
      '窗口最小化',
      (bw: FakeWindow) => {
        bw.minimized = true
      }
    ]
  ])('BPV-8 take + %s：矩形照摆，焦点不动，谁都没被弄到眼前', (_label, arrange) => {
    const bw = openByUser()
    const { view, wc } = mintPopover(bw)
    arrange(bw)
    fx.clearCalls()
    open('take')
    expect(view.setBounds).toHaveBeenLastCalledWith(PLACEMENT)
    expect(wc.focus).not.toHaveBeenCalled()
    expect(bw.webContents.focus).not.toHaveBeenCalled()
    expect(fx.allSurfacing()).toEqual([])
  })

  it('BPV-9 keep-shell：打开不拿焦点；系统把焦点给了弹层 → 还给外壳；窗口不在前台时不还', () => {
    const bw = openByUser()
    const { wc } = mintPopover(bw)
    open('keep-shell')
    expect(wc.focus).not.toHaveBeenCalled()
    expect(bw.webContents.focus).not.toHaveBeenCalled()

    wc.fire('focus')
    expect(bw.webContents.focus).toHaveBeenCalledTimes(1)

    bw.focused = false
    wc.fire('focus')
    expect(bw.webContents.focus).toHaveBeenCalledTimes(1)
  })

  it('BPV-10 take 开着、以及关着时收到 focus 事件：不还给外壳', () => {
    const bw = openByUser()
    const { wc } = mintPopover(bw)
    open('take')
    wc.fire('focus')
    expect(bw.webContents.focus).not.toHaveBeenCalled()

    wc.focused = false
    popover.setBrowserPopover(null)
    wc.fire('focus')
    expect(bw.webContents.focus).not.toHaveBeenCalled()
  })

  it.each([
    ['焦点在弹层上、窗口在前台', true, true, 1],
    ['焦点不在弹层上、窗口在前台', false, true, 0],
    ['焦点在弹层上、窗口不在前台', true, false, 0]
  ])('BPV-11 关的时候，%s：外壳拿回焦点 %#', (_label, wcFocused, inFront, times) => {
    const bw = openByUser()
    const { wc } = mintPopover(bw)
    open('take')
    wc.focused = wcFocused
    bw.focused = inFront
    popover.setBrowserPopover(null)
    expect(bw.webContents.focus).toHaveBeenCalledTimes(times)
  })
})

describe('叠放次序（BPV-12 – BPV-14）', () => {
  /** line 在 fx.log 里出现在 before 之前 */
  const logOrder = (first: string, second: string): void => {
    const a = fx.log.indexOf(first)
    const b = fx.log.indexOf(second)
    expect(a, `${first} in ${fx.log.join(', ')}`).toBeGreaterThanOrEqual(0)
    expect(b, `${second} in ${fx.log.join(', ')}`).toBeGreaterThan(a)
  }

  it('BPV-12 开着时新挂上的 view 不盖住弹层：换页、DevTools 前端、切回来，弹层始终在最上面', () => {
    const bw = openByUser()
    const a = tab()
    const b = tab('https://b.example/', false)
    onPage(a.id)
    const { view: pop } = mintPopover(bw)
    open('take')
    expect(bw.children.at(-1)).toBe(pop)

    // 换了一页：新的页面先挂上，再把弹层提上来
    fx.log.length = 0
    views.setLayout([{ tabId: b.id, bounds: PAGE, viewport: VIEWPORT }])
    expect(bw.children.at(-1)).toBe(pop)
    logOrder(`${bw.label}.add(${b.view.label})`, `${bw.label}.add(${pop.label})`)

    // DevTools 前端挂上来
    fx.log.length = 0
    dock.openDevtoolsDock(b.id, 'devtools')
    const frontend = b.view.webContents.setDevToolsWebContents.mock.calls.at(-1)?.[0]
    const frontendView = fx.views.find((v) => v.webContents === frontend)!
    dock.setDevtoolsLayout({
      tabId: b.id,
      bounds: { x: 0, y: 476, width: 900, height: 224 },
      viewport: VIEWPORT
    })
    expect(bw.children).toContain(frontendView)
    expect(bw.children.at(-1)).toBe(pop)
    logOrder(`${bw.label}.add(${frontendView.label})`, `${bw.label}.add(${pop.label})`)

    // 切回另一页
    fx.log.length = 0
    views.setLayout([{ tabId: a.id, bounds: PAGE, viewport: VIEWPORT }])
    expect(bw.children.at(-1)).toBe(pop)
    logOrder(`${bw.label}.add(${a.view.label})`, `${bw.label}.add(${pop.label})`)
  })

  it('BPV-13 关着时页面挂上来：弹层不增删；打开时才放到最上面', () => {
    const bw = openByUser()
    const a = tab()
    const { view: pop } = mintPopover(bw)
    fx.log.length = 0

    onPage(a.id)
    expect(fx.log).toContain(`${bw.label}.add(${a.view.label})`)
    expect(fx.log).not.toContain(`${bw.label}.add(${pop.label})`)
    expect(bw.children.at(-1)).toBe(a.view)

    open('take')
    expect(bw.children.at(-1)).toBe(pop)
    expect(fx.log.filter((l) => l === `${bw.label}.add(${pop.label})`)).toHaveLength(1)
  })

  it('BPV-14 开着时重报、页面停回停放窗口：弹层不增删', () => {
    const bw = openByUser()
    const a = tab()
    onPage(a.id)
    const { view: pop } = mintPopover(bw)
    open('take')
    fx.log.length = 0

    open('take', { ...PLACEMENT, height: 300 })
    views.setLayout([])
    expect(fx.log).toContain(`staging.add(${a.view.label})`)
    expect(fx.log.filter((l) => l.includes(`(${pop.label})`))).toEqual([])
    expect(bw.children.at(-1)).toBe(pop)
  })
})

describe('弹层不在了（BPV-15）', () => {
  it('BPV-15 还没有弹层：开、关、提上来、收掉都不抛', () => {
    expect(() => popover.setBrowserPopover(null)).not.toThrow()
    expect(() => open('take')).not.toThrow()
    expect(() => popover.raiseBrowserPopover()).not.toThrow()
    expect(() => popover.destroyBrowserPopover()).not.toThrow()
    expect(fx.views).toEqual([])
  })

  it.each([
    [
      'webContents 销毁了',
      (view: FakeView, wc: FakeViewWebContents): void => {
        void view
        wc.destroyed = true
      }
    ],
    [
      'view.webContents 没了',
      (view: FakeView): void => {
        ;(view as unknown as { webContents: unknown }).webContents = undefined
      }
    ]
  ])('BPV-15 %s：开、提上来、收掉都不抛，也不再动那个 webContents', (_label, gone) => {
    const bw = openByUser()
    const { view, wc } = mintPopover(bw)
    open('take')
    gone(view, wc)
    view.setBounds.mockClear()
    wc.setZoomFactor.mockClear()
    wc.focus.mockClear()
    fx.log.length = 0

    expect(() => open('take', { ...PLACEMENT, height: 300 })).not.toThrow()
    expect(() => popover.setBrowserPopover(null)).not.toThrow()
    expect(() => popover.raiseBrowserPopover()).not.toThrow()
    expect(view.setBounds).not.toHaveBeenCalled()
    expect(wc.setZoomFactor).not.toHaveBeenCalled()
    expect(wc.focus).not.toHaveBeenCalled()
    expect(fx.log).toEqual([])

    expect(() => popover.destroyBrowserPopover()).not.toThrow()
    expect(wc.close).not.toHaveBeenCalled()
  })
})

describe('窗口没了（BPV-16 / BPV-17）', () => {
  it.each([
    ['closed 事件（窗口已销毁）', 'closed', false],
    ['closeBrowserWindowWithMain', 'with-main', true],
    ['destroyBrowserWindow', 'quit', true]
  ] as const)('BPV-16 %s：收掉弹层，之后再设什么也不做', (_label, how, hostAlive) => {
    const bw = openByUser()
    const { view, wc } = mintPopover(bw)
    open('take')
    fx.log.length = 0

    if (how === 'closed') bw.destroy()
    if (how === 'with-main') wins.closeBrowserWindowWithMain()
    if (how === 'quit') wins.destroyBrowserWindow()

    expect(wc.close).toHaveBeenCalledTimes(1)
    const removed = fx.log.indexOf(`${bw.label}.remove(${view.label})`)
    if (hostAlive) {
      expect(removed).toBeGreaterThanOrEqual(0)
      expect(removed).toBeLessThan(fx.log.indexOf(`${bw.label}.destroy`))
    } else {
      expect(removed).toBe(-1)
    }

    view.setBounds.mockClear()
    open('take')
    expect(view.setBounds).not.toHaveBeenCalled()
    expect(() => popover.destroyBrowserPopover()).not.toThrow()
    expect(wc.close).toHaveBeenCalledTimes(1)
  })

  it('BPV-17 关窗 = 隐藏，弹层留着；真销毁后，新窗口的弹层把焦点还给新窗口的外壳', () => {
    const bw = openByUser()
    const first = mintPopover(bw)
    open('keep-shell')

    bw.emit('close', { preventDefault: vi.fn() })
    expect(bw.hide).toHaveBeenCalledTimes(1)
    expect(first.wc.close).not.toHaveBeenCalled()

    wins.openBrowserWindow()
    first.view.setBounds.mockClear()
    open('keep-shell', { ...PLACEMENT, height: 300 })
    expect(first.view.setBounds).toHaveBeenLastCalledWith({ ...PLACEMENT, height: 300 })

    wins.closeBrowserWindowWithMain()
    expect(first.wc.close).toHaveBeenCalledTimes(1)
    bw.webContents.focus.mockClear()

    const second = openByUser()
    expect(second).not.toBe(bw)
    const next = mintPopover(second)
    open('keep-shell')
    next.wc.fire('focus')
    expect(second.webContents.focus).toHaveBeenCalledTimes(1)
    expect(bw.webContents.focus).not.toHaveBeenCalled()
  })
})

describe('第二次 window.open（BPV-18）', () => {
  it('BPV-18 旧 view 摘下、旧 webContents 关掉；之后只动新的', () => {
    const bw = openByUser()
    const first = mintPopover(bw)
    const second = mintPopover(bw)

    expect(first.wc.close).toHaveBeenCalledTimes(1)
    expect(bw.children).not.toContain(first.view)
    expect(bw.children).toContain(second.view)

    first.view.setBounds.mockClear()
    open('take')
    expect(first.view.setBounds).not.toHaveBeenCalled()
    expect(second.view.setBounds).toHaveBeenLastCalledWith(PLACEMENT)
  })
})
