/**
 * 浏览器窗口的停靠区（页面下方，2026-10-21）：原生 DevTools + agent 的 devtool 两个页签，按 tab 记、只由用户开关。
 * 经真的 browserViewService + devtoolsDock 走一遍。
 *
 *   DD-U1   开在「Agent」页签：不建原生 DevTools 前端；发 tab-devtools{tabId, devtools:{panel:'agent'}}；
 *           listTabs 这一行带 devtools{panel:'agent'}、别的行没有这个键；不存在的 tab 什么也不做；
 *   DD-U2   切到「DevTools」：恰好建一个前端（setDevToolsWebContents(前端) 先于
 *           openDevTools({mode:'detach', activate:false})），前端接上快捷键、不进 tab 表、不用浏览器的
 *           partition；来回切不再建第二个；
 *   DD-U3   上墙：只有「有窗口 + panelVisible + 上报的矩形是这一页 + 停在 DevTools 页签」时挂到浏览器窗口上，
 *           矩形乘窗口 webContents 的缩放（取整）；setPanelVisible(false)、矩形换成别的页 / null、切到「Agent」
 *           都摘下，回来时挂回同一个前端；两页都开着 DevTools 时同一时刻只挂一个；
 *   DD-U4   浏览器窗口从没建过：前端照建，但不挂到任何窗口（停放窗口也不挂）；
 *   DD-U5   换浏览器窗口（旧窗口销毁）：旧窗口报的矩形作废，前端不跟到新窗口，新窗口报了矩形才挂上；
 *   DD-U6   关停靠区：页面 closeDevTools、前端 webContents.close、从窗口上摘下、发 devtools:null、行上没有
 *           devtools；再开是一个**新的**前端；「Agent」页签上关不碰 DevTools；没开着的关什么也不做；
 *   DD-U7   toggleDevtools（runShortcut / F12）只作用于选中的那页，再按一次关掉；选中的是内部页面
 *           （shuvix://settings）什么也不做；焦点在前端里时 F12 照样关，⌘/Ctrl+= 留给 DevTools 自己；
 *   DD-U8   closeTab / 页面自己关掉（destroyed）：前端一起收（close、摘下），之后再报它的矩形也不挂；
 *   DD-U9   navigateTab 去 shuvix://settings 关掉这一页的停靠区；去网页地址不关；
 *   DD-U10  页面上的 devtools-closed（DevTools 自己没了）：正看着 DevTools 页签 → 停靠区一起关；停在「Agent」、
 *           前端在后台 → 只丢掉前端（停靠区留着，切回 DevTools 建新的）；停在「Agent」、没建过前端的不动；
 *   DD-U11  devtools-open-url：http(s) 开成后台新 tab；file: / javascript: / devtools: 什么也不开；开满 12 个不抛；
 *   DD-U12  页面右键：窗口在前台 + 这页挂在浏览器窗口上 + agent 没在动作 → 弹原生菜单
 *           （popup({window: 浏览器窗口})）；最后一项是「检查」，点它开在 DevTools 页签并
 *           inspectElement(params.x, params.y)（在建好前端之后）；停在「Agent」时点它切到 DevTools；
 *   DD-U13  不弹：agent 正在这页上动作 / 窗口没焦点 / 最小化 / 隐藏 / 这页停在停放窗口 / 窗口从没建过；
 *   DD-U14  菜单项：网页链接（新标签页里打开 → 后台 tab；复制链接地址 → clipboard），非网页链接没有这两项；
 *           可编辑区按 editFlags 给剪切 / 复制 / 粘贴 / 全选；只有选中文字给复制；后退 / 前进按能否、刷新；
 *   DD-U15  destroyAllTabs 收掉所有前端。
 *
 * electron 是 ./fakeElectron.ts；agentGuards / browserCdpService 是间谍（agentActing 按用例拨的 tab 集合回答）；
 * browserViewService / devtoolsDock / agentDevtools / browserWindowService / stagingWindow 都是真的。
 * 发给浏览器窗口的事件 = 浏览器窗口 webContents.send 的调用。每条用例 resetModules 重新导入。
 * 全文件不变量（afterEach）：没有 view 被 setVisible 过 true 以外的值，没有 view 同时挂在两个窗口上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fakeElectron,
  type FakeMenu,
  type FakeView,
  type FakeWindow,
  type Rect
} from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

const state = vi.hoisted(() => ({
  /** agentActing 回 true 的 tab */
  acting: new Set<string>(),
  uninstallAgentGuards: vi.fn((_tabId: string) => {}),
  handleExternalDetach: vi.fn((_tabId: string, _reason?: string) => {}),
  detach: vi.fn(async (_tabId: string) => {})
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
  guardAppWindow: () => {}
}))
vi.mock('../agentGuards', () => ({
  installAgentGuards: vi.fn(async () => {}),
  uninstallAgentGuards: (tabId: string) => state.uninstallAgentGuards(tabId),
  hasAgentGuards: () => false,
  agentActing: (tabId: string) => state.acting.has(tabId)
}))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    session: vi.fn(async () => ({ enableDialogHandling: async () => {} })),
    handleExternalDetach: (tabId: string, reason?: string) =>
      state.handleExternalDetach(tabId, reason),
    detach: (tabId: string) => state.detach(tabId),
    cdpState: () => ({ attached: false, intercepting: false }),
    peek: () => undefined,
    detachAll: vi.fn(async () => {})
  }
}))

const fx = fakeElectron()

type ViewService = typeof import('../browserViewService')
type WindowService = typeof import('../browserWindowService')
type Dock = typeof import('../devtoolsDock')

const DOCK = 'browser-view:tab-devtools'
const PAGE: Rect = { x: 0, y: 76, width: 900, height: 400 }
/** 停靠区里原生 DevTools 那块（CSS px） */
const SLOT: Rect = { x: 0, y: 477, width: 901, height: 223 }
const MAX_TABS = 12

let views: ViewService
let wins: WindowService
let dock: Dock

async function load(): Promise<void> {
  views = await import('../browserViewService')
  wins = await import('../browserWindowService')
  dock = await import('../devtoolsDock')
  wins.initBrowserWindowService({ getThemeBgColor: () => '#000000' })
}

/** 用户经顶栏按钮把浏览器窗口建出来（可见、有焦点），清掉开窗本身的动作记录与事件 */
function openByUser(): FakeWindow {
  wins.openBrowserWindow()
  const all = fx.browserWindows()
  const bw = all.at(-1)
  if (!bw) throw new Error('no browser window')
  fx.clearCalls()
  bw.webContents.send.mockClear()
  return bw
}

/** 建一个 tab，回它的 id 与 view */
function tab(url?: string, opts?: { activate?: boolean }): { id: string; view: FakeView } {
  const id = views.createTab(url, opts)
  return { id, view: fx.views[fx.views.length - 1] }
}

/** 单页视图：墙级门打开，表里只有这几页 */
function onWall(...ids: string[]): void {
  views.setPanelVisible(true)
  views.setLayout(ids.map((tabId) => ({ tabId, bounds: PAGE })))
}

/** 浏览器窗口收到的事件（按 channel 过滤） */
function sent(bw: FakeWindow, channel: string): unknown[] {
  return bw.webContents.send.mock.calls.filter(([c]) => c === channel).map(([, p]) => p)
}

const row = (id: string): ReturnType<ViewService['listTabs']>[number] | undefined =>
  views.listTabs().find((t) => t.id === id)
const selected = (): string | undefined => views.listTabs().find((t) => t.active)?.id

/** 给这一页建过的原生 DevTools 前端（按 setDevToolsWebContents 的调用顺序） */
function frontendsOf(page: FakeView): FakeView[] {
  return page.webContents.setDevToolsWebContents.mock.calls.map(([wc]) => {
    const v = fx.views.find((x) => x.webContents === wc)
    if (!v) throw new Error('setDevToolsWebContents got something that is not a view webContents')
    return v
  })
}

function onlyFrontendOf(page: FakeView): FakeView {
  const list = frontendsOf(page)
  if (list.length !== 1) throw new Error(`expected one frontend, got ${list.length}`)
  return list[0]
}

/** 一次 before-input-event：回 preventDefault 间谍 */
function key(view: FakeView, input: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const list = view.webContents.handlers.get('before-input-event') ?? []
  if (list.length !== 1) throw new Error(`expected one before-input-event, got ${list.length}`)
  const event = { preventDefault: vi.fn() }
  list[0](event, {
    type: 'keyDown',
    key: '',
    code: '',
    shift: false,
    control: false,
    alt: false,
    meta: false,
    ...input
  })
  return event.preventDefault
}

/** 页面 context-menu 事件的 params（缺省：普通页面上的一处空白） */
function menuParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x: 30,
    y: 40,
    linkURL: '',
    isEditable: false,
    selectionText: '',
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    ...over
  }
}

function rightClick(view: FakeView, params = menuParams()): void {
  view.webContents.fire('context-menu', {}, params)
}

function labels(menu: FakeMenu): string[] {
  return menu.items.map((i) => (i.type === 'separator' ? '---' : String(i.label)))
}

function item(menu: FakeMenu, label: string): Record<string, unknown> {
  const found = menu.items.find((i) => i.label === label)
  if (!found) throw new Error(`no menu item ${label}`)
  return found
}

function click(menuItem: Record<string, unknown>): void {
  ;(menuItem.click as () => void)()
}

const PLAIN_ITEMS = [
  'browser.back',
  'browser.forward',
  'browser.refresh',
  '---',
  'browser.pageMenu.inspect'
]

beforeEach(async () => {
  vi.resetModules()
  fx.reset()
  state.acting.clear()
  state.uninstallAgentGuards.mockClear()
  state.handleExternalDetach.mockClear()
  state.detach.mockClear()
  await load()
})

afterEach(() => {
  vi.restoreAllMocks()
  expect(fx.hiddenViews(), 'a view was setVisible(false)').toEqual([])
  expect(fx.doubleParented, 'a view hung on two windows at once').toEqual([])
})

// ─────────────────────────────────────────────────────────────────────────

describe('开在哪个页签（DD-U1 / DD-U2）', () => {
  it('DD-U1 开在「Agent」：不建前端；发 tab-devtools{panel:agent}；行带 devtools、别的行没有', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    const viewsBefore = fx.views.length

    dock.openDevtoolsDock(a.id, 'agent')
    expect(fx.views).toHaveLength(viewsBefore)
    expect(a.view.webContents.setDevToolsWebContents).not.toHaveBeenCalled()
    expect(a.view.webContents.openDevTools).not.toHaveBeenCalled()
    expect(sent(bw, DOCK)).toEqual([{ tabId: a.id, devtools: { panel: 'agent' } }])
    expect(row(a.id)).toMatchObject({ devtools: { panel: 'agent' }, agentDevtoolsCalls: 0 })
    expect(row(b.id)).not.toHaveProperty('devtools')
    expect(dock.devtoolsDockOf(a.id)).toEqual({ panel: 'agent' })
    expect(dock.devtoolsDockOf(b.id)).toBeUndefined()
  })

  it('DD-U1 不存在的 tab：什么也不做', () => {
    const bw = openByUser()
    tab('https://a.test/', { activate: true })
    const viewsBefore = fx.views.length
    dock.openDevtoolsDock('no-such-tab', 'devtools')
    dock.openDevtoolsDock('no-such-tab', 'agent')
    expect(fx.views).toHaveLength(viewsBefore)
    expect(sent(bw, DOCK)).toEqual([])
    expect(dock.devtoolsDockOf('no-such-tab')).toBeUndefined()
  })

  it('DD-U2 切到「DevTools」：恰好一个前端，setDevToolsWebContents 先于 openDevTools({mode:detach, activate:false})', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    dock.openDevtoolsDock(a.id, 'agent')
    const viewsBefore = fx.views.length

    dock.openDevtoolsDock(a.id, 'devtools')
    expect(fx.views).toHaveLength(viewsBefore + 1)
    const frontend = onlyFrontendOf(a.view)
    expect(frontend).toBe(fx.views.at(-1))
    const wc = a.view.webContents
    expect(wc.openDevTools.mock.calls).toEqual([[{ mode: 'detach', activate: false }]])
    expect(wc.setDevToolsWebContents.mock.invocationCallOrder[0]).toBeLessThan(
      wc.openDevTools.mock.invocationCallOrder[0]
    )
    // 前端：接上浏览器快捷键、用应用自己的 session、不在 tab 表里、从没导航过
    expect(frontend.webContents.handlers.get('before-input-event')).toHaveLength(1)
    expect(frontend.opts.webPreferences).not.toHaveProperty('partition')
    expect(frontend.webContents.loaded).toEqual([])
    expect(views.listTabs().map((t) => t.id)).toEqual([a.id])
    expect(sent(bw, DOCK)).toEqual([
      { tabId: a.id, devtools: { panel: 'agent' } },
      { tabId: a.id, devtools: { panel: 'devtools' } }
    ])
    expect(row(a.id)?.devtools).toEqual({ panel: 'devtools' })
  })

  it('DD-U2 来回切：agent → devtools → agent → devtools，始终同一个前端', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.openDevtoolsDock(a.id, 'agent')
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.openDevtoolsDock(a.id, 'agent')
    dock.openDevtoolsDock(a.id, 'devtools')
    expect(frontendsOf(a.view)).toHaveLength(1)
    expect(a.view.webContents.openDevTools).toHaveBeenCalledTimes(1)
    expect(a.view.webContents.closeDevTools).not.toHaveBeenCalled()
    expect(onlyFrontendOf(a.view).webContents.close).not.toHaveBeenCalled()
    expect(
      sent(bw, DOCK).map((p) => (p as { devtools: { panel: string } }).devtools.panel)
    ).toEqual(['devtools', 'agent', 'devtools', 'agent', 'devtools'])
  })
})

describe('原生 DevTools 上墙（DD-U3 – DD-U5）', () => {
  it('DD-U3 有窗口 + panelVisible + 矩形是这一页 + DevTools 页签 → 挂上，矩形乘窗口缩放；其余摘下', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    onWall(a.id)
    bw.webContents.zoom = 1.25

    dock.openDevtoolsDock(a.id, 'devtools')
    const frontend = onlyFrontendOf(a.view)
    // 还没上报矩形：不挂
    expect(bw.children).not.toContain(frontend)

    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    expect(bw.children).toContain(frontend)
    expect(frontend.setBounds.mock.calls.at(-1)).toEqual([
      { x: 0, y: 596, width: 1126, height: 279 }
    ])

    // 对话框覆盖层开着：摘下；关掉后挂回同一个
    views.setPanelVisible(false)
    expect(bw.children).not.toContain(frontend)
    views.setPanelVisible(true)
    expect(bw.children).toContain(frontend)

    // 矩形报的是别的页（它没开停靠区）/ null：摘下
    dock.setDevtoolsLayout({ tabId: b.id, bounds: SLOT })
    expect(bw.children).not.toContain(frontend)
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    expect(bw.children).toContain(frontend)
    dock.setDevtoolsLayout(null)
    expect(bw.children).not.toContain(frontend)

    // 切到「Agent」页签：矩形还在也摘下；切回来挂回去
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    dock.openDevtoolsDock(a.id, 'agent')
    expect(bw.children).not.toContain(frontend)
    dock.openDevtoolsDock(a.id, 'devtools')
    expect(bw.children).toContain(frontend)

    expect(frontendsOf(a.view)).toHaveLength(1)
    expect(frontend.webContents.close).not.toHaveBeenCalled()
    // 前端从没去过停放窗口
    expect(fx.staging()?.children ?? []).not.toContain(frontend)
  })

  it('DD-U3 墙级门一开始就关着：不挂；窗口缩放变了重摆时按新缩放', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    views.setLayout([{ tabId: a.id, bounds: PAGE }])
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    const frontend = onlyFrontendOf(a.view)
    expect(bw.children).not.toContain(frontend)

    views.setPanelVisible(true)
    expect(bw.children).toContain(frontend)
    expect(frontend.setBounds.mock.calls.at(-1)).toEqual([SLOT])

    bw.webContents.zoom = 0.5
    views.setLayout([{ tabId: a.id, bounds: PAGE }])
    expect(frontend.setBounds.mock.calls.at(-1)).toEqual([
      { x: 0, y: 239, width: 451, height: 112 }
    ])
  })

  it('DD-U3 两页都开着 DevTools：矩形换到 B 时 A 的前端先摘下、再挂 B 的，同一时刻只挂一个', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    onWall(a.id)
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.openDevtoolsDock(b.id, 'devtools')
    const fa = onlyFrontendOf(a.view)
    const fb = onlyFrontendOf(b.view)
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    expect(bw.children).toContain(fa)
    expect(bw.children).not.toContain(fb)
    fx.clearCalls()

    views.activateTab(b.id)
    onWall(b.id)
    dock.setDevtoolsLayout({ tabId: b.id, bounds: SLOT })
    expect(bw.children).toContain(fb)
    expect(bw.children).not.toContain(fa)
    const log = fx.log.filter((l) => l.endsWith(`(${fa.label})`) || l.endsWith(`(${fb.label})`))
    expect(log).toEqual([`${bw.label}.remove(${fa.label})`, `${bw.label}.add(${fb.label})`])
  })

  it('DD-U4 浏览器窗口从没建过：前端照建，但哪个窗口都不挂', () => {
    const a = tab('https://a.test/', { activate: true })
    dock.openDevtoolsDock(a.id, 'devtools')
    views.setPanelVisible(true)
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    const frontend = onlyFrontendOf(a.view)
    expect(fx.windows.some((w) => w.children.includes(frontend))).toBe(false)
    expect(frontend.setBounds).not.toHaveBeenCalled()
    expect(row(a.id)?.devtools).toEqual({ panel: 'devtools' })
  })

  it('DD-U5 浏览器窗口销毁后重开：旧矩形作废，新窗口报了矩形才挂上', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    onWall(a.id)
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    const frontend = onlyFrontendOf(a.view)
    expect(bw.children).toContain(frontend)

    bw.destroy()
    const bw2 = openByUser()
    expect(bw2).not.toBe(bw)
    expect(bw2.children).not.toContain(frontend)

    // 新窗口的 renderer 先报页面布局：前端仍不挂（它还没报 DevTools 那块）
    onWall(a.id)
    expect(bw2.children).toContain(a.view)
    expect(bw2.children).not.toContain(frontend)

    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    expect(bw2.children).toContain(frontend)
    // 停靠区本身没变：还是同一个前端
    expect(frontendsOf(a.view)).toHaveLength(1)
    expect(row(a.id)?.devtools).toEqual({ panel: 'devtools' })
  })
})

describe('关掉停靠区（DD-U6）', () => {
  it('DD-U6 关：closeDevTools、前端 close、摘下、发 devtools:null、行上没有 devtools；再开是新的前端', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    onWall(a.id)
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    const first = onlyFrontendOf(a.view)
    expect(bw.children).toContain(first)
    bw.webContents.send.mockClear()

    dock.closeDevtoolsDock(a.id)
    expect(a.view.webContents.closeDevTools).toHaveBeenCalledTimes(1)
    expect(first.webContents.close).toHaveBeenCalledTimes(1)
    expect(bw.children).not.toContain(first)
    expect(sent(bw, DOCK)).toEqual([{ tabId: a.id, devtools: null }])
    expect(row(a.id)).not.toHaveProperty('devtools')
    expect(dock.devtoolsDockOf(a.id)).toBeUndefined()

    // 再开（renderer 还没来得及换矩形）：新建一个前端，挂上的是新的
    dock.openDevtoolsDock(a.id, 'devtools')
    const all = frontendsOf(a.view)
    expect(all).toHaveLength(2)
    expect(all[1]).not.toBe(first)
    expect(a.view.webContents.openDevTools).toHaveBeenCalledTimes(2)
    expect(bw.children).toContain(all[1])
    expect(bw.children).not.toContain(first)
  })

  it('DD-U6 停在「Agent」（没建过前端）关：不碰 DevTools，照发 devtools:null', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    dock.openDevtoolsDock(a.id, 'agent')
    bw.webContents.send.mockClear()
    dock.closeDevtoolsDock(a.id)
    expect(a.view.webContents.closeDevTools).not.toHaveBeenCalled()
    expect(sent(bw, DOCK)).toEqual([{ tabId: a.id, devtools: null }])
    expect(row(a.id)).not.toHaveProperty('devtools')
  })

  it('DD-U6 没开着的关：什么也不做', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    dock.closeDevtoolsDock(a.id)
    dock.closeDevtoolsDock('no-such-tab')
    expect(sent(bw, DOCK)).toEqual([])
    expect(a.view.webContents.closeDevTools).not.toHaveBeenCalled()
  })
})

describe('快捷键开关（DD-U7）', () => {
  it('DD-U7 runShortcut(toggleDevtools) 只作用于选中的那页；再按一次关掉；别的页的停靠区不动', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    dock.openDevtoolsDock(b.id, 'agent')
    bw.webContents.send.mockClear()

    views.runShortcut({ type: 'toggleDevtools' })
    expect(row(a.id)?.devtools).toEqual({ panel: 'devtools' })
    expect(frontendsOf(a.view)).toHaveLength(1)
    expect(row(b.id)?.devtools).toEqual({ panel: 'agent' })
    expect(b.view.webContents.setDevToolsWebContents).not.toHaveBeenCalled()

    views.runShortcut({ type: 'toggleDevtools' })
    expect(row(a.id)).not.toHaveProperty('devtools')
    expect(onlyFrontendOf(a.view).webContents.close).toHaveBeenCalledTimes(1)
    expect(row(b.id)?.devtools).toEqual({ panel: 'agent' })
    expect(sent(bw, DOCK)).toEqual([
      { tabId: a.id, devtools: { panel: 'devtools' } },
      { tabId: a.id, devtools: null }
    ])
  })

  it('DD-U7 没有 tab：不抛', () => {
    expect(() => views.runShortcut({ type: 'toggleDevtools' })).not.toThrow()
  })

  it('DD-U7 选中的是内部页面（shuvix://settings）：什么也不做', () => {
    const bw = openByUser()
    tab('https://a.test/')
    const s = views.openInternalPage('settings')
    expect(selected()).toBe(s)
    const sView = fx.views.at(-1)!
    const viewsBefore = fx.views.length
    bw.webContents.send.mockClear()

    views.runShortcut({ type: 'toggleDevtools' })
    expect(fx.views).toHaveLength(viewsBefore)
    expect(sView.webContents.setDevToolsWebContents).not.toHaveBeenCalled()
    expect(sent(bw, DOCK)).toEqual([])
    expect(row(s)).not.toHaveProperty('devtools')
  })

  it('DD-U7 焦点在 DevTools 前端里：F12 照样关掉；⌘/Ctrl+= 不拦（留给 DevTools 自己缩放）', () => {
    openByUser()
    const a = tab('https://a.test/', { activate: true })
    expect(key(a.view, { code: 'F12', key: 'F12' })).toHaveBeenCalledTimes(1)
    expect(row(a.id)?.devtools).toEqual({ panel: 'devtools' })
    const frontend = onlyFrontendOf(a.view)

    const primary = process.platform === 'darwin' ? { meta: true } : { control: true }
    expect(key(frontend, { code: 'Equal', key: '=', ...primary })).not.toHaveBeenCalled()
    expect(row(a.id)?.zoomPercent).toBe(100)
    // 同一个键落在页面上照常放大
    expect(key(a.view, { code: 'Equal', key: '=', ...primary })).toHaveBeenCalledTimes(1)
    expect(row(a.id)?.zoomPercent).toBe(110)

    expect(key(frontend, { code: 'F12', key: 'F12' })).toHaveBeenCalledTimes(1)
    expect(row(a.id)).not.toHaveProperty('devtools')
    expect(frontend.webContents.close).toHaveBeenCalledTimes(1)
  })
})

describe('页面没了 / 换成内部页面（DD-U8 / DD-U9）', () => {
  it('DD-U8 closeTab：前端 close、从窗口上摘下；之后再报它的矩形也不挂', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    onWall(a.id)
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    const frontend = onlyFrontendOf(a.view)
    expect(bw.children).toContain(frontend)

    views.closeTab(a.id)
    expect(frontend.webContents.close).toHaveBeenCalledTimes(1)
    expect(bw.children).not.toContain(frontend)
    expect(views.listTabs()).toEqual([])
    expect(dock.devtoolsDockOf(a.id)).toBeUndefined()

    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    expect(fx.windows.some((w) => w.children.includes(frontend))).toBe(false)
  })

  it('DD-U8 页面自己关掉（destroyed）：前端一起收', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    onWall(a.id)
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    const frontend = onlyFrontendOf(a.view)

    a.view.webContents.destroyed = true
    a.view.webContents.fire('destroyed')
    expect(frontend.webContents.close).toHaveBeenCalledTimes(1)
    expect(bw.children).not.toContain(frontend)
    expect(dock.devtoolsDockOf(a.id)).toBeUndefined()
  })

  it('DD-U9 navigateTab 去 shuvix://settings：关掉这一页的停靠区；去网页地址不关', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    dock.openDevtoolsDock(a.id, 'devtools')
    const frontend = onlyFrontendOf(a.view)

    views.navigateTab(a.id, 'https://b.test/')
    expect(row(a.id)?.devtools).toEqual({ panel: 'devtools' })
    expect(frontend.webContents.close).not.toHaveBeenCalled()
    bw.webContents.send.mockClear()

    views.navigateTab(a.id, 'shuvix://settings')
    expect(row(a.id)).toMatchObject({ internalPage: 'settings' })
    expect(row(a.id)).not.toHaveProperty('devtools')
    expect(a.view.webContents.closeDevTools).toHaveBeenCalledTimes(1)
    expect(frontend.webContents.close).toHaveBeenCalledTimes(1)
    expect(sent(bw, DOCK)).toEqual([{ tabId: a.id, devtools: null }])
  })
})

describe('页面 webContents 上的 DevTools 事件（DD-U10 / DD-U11）', () => {
  it('DD-U10 devtools-closed（DevTools 自己没了）：有前端的停靠区一起关', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    onWall(a.id)
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    const frontend = onlyFrontendOf(a.view)
    bw.webContents.send.mockClear()

    a.view.webContents.fire('devtools-closed')
    expect(row(a.id)).not.toHaveProperty('devtools')
    expect(frontend.webContents.close).toHaveBeenCalledTimes(1)
    expect(bw.children).not.toContain(frontend)
    expect(sent(bw, DOCK)).toEqual([{ tabId: a.id, devtools: null }])
  })

  it('DD-U10 停在「Agent」、前端在后台：只丢掉前端，停靠区留着；切回 DevTools 建一个新的', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    onWall(a.id)
    dock.openDevtoolsDock(a.id, 'devtools')
    const first = onlyFrontendOf(a.view)
    dock.openDevtoolsDock(a.id, 'agent')
    bw.webContents.send.mockClear()

    a.view.webContents.fire('devtools-closed')
    expect(row(a.id)?.devtools).toEqual({ panel: 'agent' })
    expect(first.webContents.close).toHaveBeenCalledTimes(1)
    expect(bw.children).not.toContain(first)
    expect(sent(bw, DOCK)).toEqual([])

    dock.openDevtoolsDock(a.id, 'devtools')
    const frontends = a.view.webContents.setDevToolsWebContents.mock.calls.map(([wc]) => wc)
    expect(frontends).toHaveLength(2)
    expect(frontends[1]).not.toBe(first.webContents)
  })

  it('DD-U10 停在「Agent」、没建过前端：devtools-closed 不动它', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    dock.openDevtoolsDock(a.id, 'agent')
    bw.webContents.send.mockClear()
    a.view.webContents.fire('devtools-closed')
    expect(row(a.id)?.devtools).toEqual({ panel: 'agent' })
    expect(sent(bw, DOCK)).toEqual([])
  })

  it('DD-U11 devtools-open-url：http(s) 开成后台新 tab，选中不变', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    bw.webContents.send.mockClear()

    for (const url of ['https://docs.test/x', 'http://plain.test/']) {
      const before = fx.views.length
      a.view.webContents.fire('devtools-open-url', {}, url)
      expect(fx.views, url).toHaveLength(before + 1)
      expect(fx.views.at(-1)?.webContents.loaded).toEqual([url])
    }
    expect(selected()).toBe(a.id)
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([])
    expect(
      sent(bw, 'browser-view:tab-created').map((p) => (p as { active: boolean }).active)
    ).toEqual([false, false])
  })

  it('DD-U11 devtools-open-url：file: / javascript: / devtools: 什么也不开；开满 12 个不抛', () => {
    openByUser()
    const a = tab('https://a.test/', { activate: true })
    const before = fx.views.length
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'devtools://devtools/bundled/inspector.html',
      'mailto:x@y.test'
    ]) {
      a.view.webContents.fire('devtools-open-url', {}, url)
    }
    expect(fx.views).toHaveLength(before)
    expect(fx.shell.openExternal).not.toHaveBeenCalled()

    for (let i = 1; i < MAX_TABS; i++) tab(`https://t${i}.test/`)
    const full = fx.views.length
    expect(() => a.view.webContents.fire('devtools-open-url', {}, 'https://x.test/')).not.toThrow()
    expect(fx.views).toHaveLength(full)
    expect(views.listTabs()).toHaveLength(MAX_TABS)
  })
})

describe('页面右键菜单（DD-U12 – DD-U14）', () => {
  /** 用户正看着浏览器窗口、这页在墙上 */
  const ready = (): { bw: FakeWindow; a: { id: string; view: FakeView } } => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    onWall(a.id)
    return { bw, a }
  }

  it('DD-U12 弹在浏览器窗口上；最后一项「检查」→ 开在 DevTools 页签并 inspectElement(x, y)', () => {
    const { bw, a } = ready()
    rightClick(a.view, menuParams({ x: 123, y: 45 }))
    expect(fx.menus).toHaveLength(1)
    const [menu] = fx.menus
    expect(menu.popup.mock.calls).toEqual([[{ window: bw }]])
    expect(labels(menu)).toEqual(PLAIN_ITEMS)
    expect(menu.items.at(-1)?.label).toBe('browser.pageMenu.inspect')
    // 弹菜单本身不开停靠区
    expect(row(a.id)).not.toHaveProperty('devtools')
    expect(a.view.webContents.inspectElement).not.toHaveBeenCalled()
    bw.webContents.send.mockClear()

    click(menu.items.at(-1)!)
    expect(row(a.id)?.devtools).toEqual({ panel: 'devtools' })
    expect(sent(bw, DOCK)).toEqual([{ tabId: a.id, devtools: { panel: 'devtools' } }])
    const wc = a.view.webContents
    expect(frontendsOf(a.view)).toHaveLength(1)
    expect(wc.inspectElement.mock.calls).toEqual([[123, 45]])
    expect(wc.openDevTools.mock.invocationCallOrder[0]).toBeLessThan(
      wc.inspectElement.mock.invocationCallOrder[0]
    )
  })

  it('DD-U12 停在「Agent」时点「检查」：切到 DevTools 页签，建前端再 inspectElement', () => {
    const { a } = ready()
    dock.openDevtoolsDock(a.id, 'agent')
    rightClick(a.view)
    click(fx.menus[0].items.at(-1)!)
    expect(row(a.id)?.devtools).toEqual({ panel: 'devtools' })
    expect(frontendsOf(a.view)).toHaveLength(1)
    expect(a.view.webContents.inspectElement.mock.calls).toEqual([[30, 40]])

    // DevTools 已经开着再「检查」：不再建前端
    rightClick(a.view, menuParams({ x: 5, y: 6 }))
    click(fx.menus[1].items.at(-1)!)
    expect(frontendsOf(a.view)).toHaveLength(1)
    expect(a.view.webContents.inspectElement.mock.calls).toEqual([
      [30, 40],
      [5, 6]
    ])
  })

  const NO_MENU: Array<[string, (bw: FakeWindow, tabId: string) => void]> = [
    [
      'agent 正在这页上动作',
      (_bw, tabId) => {
        state.acting.add(tabId)
      }
    ],
    [
      '窗口没焦点',
      (bw) => {
        bw.focused = false
      }
    ],
    [
      '窗口最小化',
      (bw) => {
        bw.minimized = true
      }
    ],
    ['窗口隐藏', (bw) => bw.emit('close', { preventDefault: () => {} })],
    ['这页停在停放窗口', () => views.setLayout([])],
    ['墙级门关着', () => views.setPanelVisible(false)]
  ]

  it.each(NO_MENU)('DD-U13 %s：不弹菜单', (_label, arrange) => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    onWall(a.id)
    arrange(bw, a.id)
    rightClick(a.view)
    expect(fx.menu.buildFromTemplate).not.toHaveBeenCalled()
    expect(fx.menus).toEqual([])
    expect(row(a.id)).not.toHaveProperty('devtools')
  })

  it('DD-U13 窗口从没建过：不弹菜单', () => {
    const a = tab('https://a.test/', { activate: true })
    rightClick(a.view)
    expect(fx.menus).toEqual([])
  })

  it('DD-U13 右键落在没上墙的另一页上：不弹', () => {
    openByUser()
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    onWall(a.id)
    rightClick(b.view)
    expect(fx.menus).toEqual([])
  })

  it('DD-U14 网页链接：新标签页里打开（后台 tab）、复制链接地址；非网页链接没有这两项', () => {
    const { bw, a } = ready()
    rightClick(a.view, menuParams({ linkURL: 'https://link.test/p' }))
    const menu = fx.menus[0]
    expect(labels(menu)).toEqual([
      'browser.pageMenu.openLinkInNewTab',
      'browser.pageMenu.copyLinkAddress',
      '---',
      ...PLAIN_ITEMS
    ])
    expect(item(menu, 'browser.pageMenu.openLinkInNewTab').enabled).toBe(true)
    bw.webContents.send.mockClear()

    const before = fx.views.length
    click(item(menu, 'browser.pageMenu.openLinkInNewTab'))
    expect(fx.views).toHaveLength(before + 1)
    expect(fx.views.at(-1)?.webContents.loaded).toEqual(['https://link.test/p'])
    expect(selected()).toBe(a.id)
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([])

    click(item(menu, 'browser.pageMenu.copyLinkAddress'))
    expect(fx.clipboard.writeText.mock.calls).toEqual([['https://link.test/p']])

    rightClick(a.view, menuParams({ linkURL: 'javascript:alert(1)' }))
    expect(labels(fx.menus[1])).toEqual(PLAIN_ITEMS)
  })

  it('DD-U14 可编辑区按 editFlags 给剪切 / 复制 / 粘贴 / 全选；只有选中文字给复制', () => {
    const { a } = ready()
    rightClick(
      a.view,
      menuParams({
        isEditable: true,
        selectionText: 'abc',
        editFlags: { canCut: true, canCopy: false, canPaste: true, canSelectAll: true }
      })
    )
    const edit = fx.menus[0]
    expect(labels(edit)).toEqual([
      'browser.pageMenu.cut',
      'browser.pageMenu.copy',
      'browser.pageMenu.paste',
      'browser.pageMenu.selectAll',
      '---',
      ...PLAIN_ITEMS
    ])
    expect(edit.items.slice(0, 4).map((i) => i.enabled)).toEqual([true, false, true, true])
    for (const i of edit.items.slice(0, 4)) click(i)
    const wc = a.view.webContents
    for (const fn of [wc.cut, wc.copy, wc.paste, wc.selectAll]) expect(fn).toHaveBeenCalledTimes(1)

    rightClick(a.view, menuParams({ selectionText: 'abc' }))
    expect(labels(fx.menus[1])).toEqual(['browser.pageMenu.copy', '---', ...PLAIN_ITEMS])
  })

  it('DD-U14 后退 / 前进按能否；点了作用于这一页；刷新', () => {
    const { a } = ready()
    rightClick(a.view)
    expect(item(fx.menus[0], 'browser.back').enabled).toBe(false)
    expect(item(fx.menus[0], 'browser.forward').enabled).toBe(false)

    a.view.webContents.canBack = true
    a.view.webContents.canForward = true
    rightClick(a.view)
    const menu = fx.menus[1]
    expect(item(menu, 'browser.back').enabled).toBe(true)
    expect(item(menu, 'browser.forward').enabled).toBe(true)
    click(item(menu, 'browser.back'))
    click(item(menu, 'browser.forward'))
    click(item(menu, 'browser.refresh'))
    const wc = a.view.webContents
    expect(wc.navigationHistory.goBack).toHaveBeenCalledTimes(1)
    expect(wc.navigationHistory.goForward).toHaveBeenCalledTimes(1)
    expect(wc.reload).toHaveBeenCalledTimes(1)
  })
})

describe('退出时全部收掉（DD-U15）', () => {
  it('DD-U15 destroyAllTabs：所有前端 close、摘下，停靠区全部忘掉', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    onWall(a.id)
    dock.openDevtoolsDock(a.id, 'devtools')
    dock.openDevtoolsDock(b.id, 'devtools')
    dock.setDevtoolsLayout({ tabId: a.id, bounds: SLOT })
    const fa = onlyFrontendOf(a.view)
    const fb = onlyFrontendOf(b.view)
    expect(bw.children).toContain(fa)

    views.destroyAllTabs()
    expect(fa.webContents.close).toHaveBeenCalledTimes(1)
    expect(fb.webContents.close).toHaveBeenCalledTimes(1)
    expect(bw.children).not.toContain(fa)
    expect(dock.devtoolsDockOf(a.id)).toBeUndefined()
    expect(dock.devtoolsDockOf(b.id)).toBeUndefined()
  })
})
