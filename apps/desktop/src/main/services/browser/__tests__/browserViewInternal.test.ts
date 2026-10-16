/**
 * browserViewService 的内部页面（`shuvix://settings`，2026-10-16）：一个 webContents 只是 about:blank 占位、
 * 页面本身在浏览器窗口外壳里的 tab。
 *
 *   BS-U3  一个 tab 都没有时 openInternalPage('settings')：恰好一个 tab；tab-created
 *          `{url:'shuvix://settings', active:true}` 之后 tab-activated；webContents 只加载过 about:blank；
 *          listTabs 的行 `{url:'shuvix://settings', internalPage:'settings', active:true}`；isInternalTab 为真；
 *          不建窗口、不把任何窗口弄到眼前（浏览器窗口开着 / 从没建过各一遍）；
 *   BS-U4  单例：再开一次回同一个 id 并选中它（中间用户选了别的页）、tab 数不变；开满 12 个且没有设置页 →
 *          抛 Too many browser tabs；12 个里已经有设置页 → 回它、不抛；
 *   BS-U5  navigateTab(A, 'shuvix://settings')：id 不变、发 did-navigate `{tabId:A, url:'shuvix://settings'}`、
 *          最后一次 loadURL 是 about:blank、行变成内部页面；占位自己的 did-start-navigation / did-navigate
 *          （about:blank）不让它变回来，发出去的地址都是 shuvix://settings；agent 接着的 tab 被
 *          browserCdpManager.detach(A)、卸掉防护、去掉 agentUse；
 *   BS-U6  navigateTab(S, 'https://b.test/') → 不再是内部页面；主框架、非同文档的 did-start-navigation 去别的
 *          地址（后退 / 前进）也让它变回来；子框架、同文档的导航不算；
 *   BS-U7  不存在的 id / 已销毁的 webContents：navigateTab 不抛、什么也不加载；closeTab(S) 之后忘掉它；
 *          closeTab(S, {remember}) 之后 reopenClosedTab() 开回一个设置页（单例：已经开着就回那一个）；
 *          destroyAllTabs 清掉；tabDisplayUrl(S) 是 shuvix://settings。
 *
 * electron 是 ./fakeElectron.ts；agentGuards / browserCdpService 是间谍；browserViewService /
 * browserWindowService / stagingWindow 都是真的。发给浏览器窗口的事件 = 浏览器窗口 webContents.send 的调用。
 * 每条用例 resetModules 重新导入。全文件不变量（afterEach）：没有 view 被 setVisible 过 true 以外的值，
 * 没有 view 同时挂在两个窗口上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeElectron, type FakeView, type FakeWindow } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

const state = vi.hoisted(() => ({
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
  agentActing: () => false
}))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    session: vi.fn(async () => ({ enableDialogHandling: async () => {} })),
    handleExternalDetach: (tabId: string, reason?: string) =>
      state.handleExternalDetach(tabId, reason),
    detach: (tabId: string) => state.detach(tabId),
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: vi.fn(async () => {})
  }
}))

const fx = fakeElectron()

type ViewService = typeof import('../browserViewService')
type WindowService = typeof import('../browserWindowService')

const SETTINGS = 'shuvix://settings'
const MAX_TABS = 12

let views: ViewService
let wins: WindowService

beforeEach(async () => {
  vi.resetModules()
  fx.reset()
  state.uninstallAgentGuards.mockClear()
  state.handleExternalDetach.mockClear()
  state.detach.mockClear()
  views = await import('../browserViewService')
  wins = await import('../browserWindowService')
  wins.initBrowserWindowService({ getThemeBgColor: () => '#000000' })
})

afterEach(() => {
  vi.restoreAllMocks()
  expect(fx.hiddenViews(), 'a tab view was setVisible(false)').toEqual([])
  expect(fx.doubleParented, 'a tab view hung on two windows at once').toEqual([])
})

/** 用户经顶栏按钮把浏览器窗口建出来（可见、有焦点），清掉开窗本身的动作记录与事件 */
function openByUser(): FakeWindow {
  wins.openBrowserWindow()
  const all = fx.browserWindows()
  if (all.length !== 1) throw new Error(`expected one browser window, got ${all.length}`)
  const bw = all[0]
  fx.clearCalls()
  bw.webContents.send.mockClear()
  return bw
}

/** 建一个普通 tab，回它的 id 与 view */
function tab(url?: string, opts?: { activate?: boolean }): { id: string; view: FakeView } {
  const id = views.createTab(url, opts)
  return { id, view: fx.views[fx.views.length - 1] }
}

/** 某个 tab id 的 view（tab 服务自己的表里取） */
function viewOf(id: string): FakeView {
  const view = views.getTabView(id) as unknown as FakeView | null
  if (!view) throw new Error(`no view for ${id}`)
  return view
}

/** 浏览器窗口收到的事件（可按 channel 过滤） */
function sent(bw: FakeWindow, channel?: string): unknown[] {
  return bw.webContents.send.mock.calls
    .filter(([c]) => channel === undefined || c === channel)
    .map(([c, p]) => (channel === undefined ? [c, p] : p))
}

const row = (id: string): ReturnType<ViewService['listTabs']>[number] | undefined =>
  views.listTabs().find((t) => t.id === id)
const selected = (): string | undefined => views.listTabs().find((t) => t.active)?.id

/** 一次导航开始（Electron 39：处理函数只收一个 details 对象） */
function startNav(
  view: FakeView,
  url: string,
  over: { isMainFrame?: boolean; isSameDocument?: boolean } = {}
): void {
  view.webContents.fire('did-start-navigation', {
    url,
    isMainFrame: over.isMainFrame ?? true,
    isSameDocument: over.isSameDocument ?? false
  })
}

/** 导航提交（did-navigate：event, url） */
function committed(view: FakeView, url: string): void {
  view.webContents.url = url
  view.webContents.fire('did-navigate', {}, url)
}

describe('打开内部页面（BS-U3）', () => {
  it('BS-U3 没有 tab：一个设置页 tab，tab-created 之后 tab-activated，只加载 about:blank，行是内部页面；不建窗口、不弄到眼前', () => {
    const bw = openByUser()
    const id = views.openInternalPage('settings')

    expect(views.listTabs()).toHaveLength(1)
    expect(sent(bw, 'browser-view:tab-created')).toEqual([
      { tabId: id, url: SETTINGS, active: true }
    ])
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([{ tabId: id }])
    const order = bw.webContents.send.mock.calls.map(([c]) => c)
    expect(order.indexOf('browser-view:tab-created')).toBeLessThan(
      order.indexOf('browser-view:tab-activated')
    )
    expect(viewOf(id).webContents.loaded).toEqual(['about:blank'])
    expect(row(id)).toMatchObject({ url: SETTINGS, internalPage: 'settings', active: true })
    expect(views.isInternalTab(id)).toBe(true)

    // 浏览器窗口还是那一个，谁都没被弄到眼前；tab 在停放窗口里出生
    expect(fx.browserWindows()).toEqual([bw])
    expect(fx.allSurfacing()).toEqual([])
    expect(fx.staging()?.visible).toBe(false)
  })

  it('BS-U3 浏览器窗口从没建过：照样开出来，不建浏览器窗口（只有停放窗口）、谁都没被弄到眼前', () => {
    const id = views.openInternalPage('settings')
    expect(row(id)).toMatchObject({ url: SETTINGS, internalPage: 'settings', active: true })
    expect(fx.browserWindows()).toEqual([])
    expect(fx.windows).toEqual([fx.staging()])
    expect(fx.allSurfacing()).toEqual([])
    expect(wins.isBrowserWindowOpen()).toBe(false)
  })

  it('BS-U3 普通 tab 不是内部页面；不存在的 id 也不是', () => {
    const a = tab('https://a.test/', { activate: true })
    expect(views.isInternalTab(a.id)).toBe(false)
    expect(row(a.id)).not.toHaveProperty('internalPage')
    expect(views.isInternalTab('no-such-tab')).toBe(false)
  })
})

describe('单例（BS-U4）', () => {
  it('BS-U4 再开一次：回同一个 id、把它选中，tab 数不变', () => {
    const bw = openByUser()
    const s = views.openInternalPage('settings')
    const a = tab('https://a.test/', { activate: true })
    expect(selected()).toBe(a.id)
    bw.webContents.send.mockClear()
    const countBefore = views.listTabs().length

    expect(views.openInternalPage('settings')).toBe(s)
    expect(views.listTabs()).toHaveLength(countBefore)
    expect(selected()).toBe(s)
    expect(sent(bw, 'browser-view:tab-created')).toEqual([])
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([{ tabId: s }])
    expect(fx.views).toHaveLength(2)
  })

  it('BS-U4 开满 12 个、没有设置页：抛 Too many browser tabs，什么也没建', () => {
    for (let i = 0; i < MAX_TABS; i++) tab(`https://t${i}.test/`)
    expect(() => views.openInternalPage('settings')).toThrow(/Too many browser tabs/)
    expect(views.listTabs()).toHaveLength(MAX_TABS)
    expect(views.listTabs().some((t) => t.internalPage)).toBe(false)
  })

  it('BS-U4 12 个里已经有设置页：回它、不抛', () => {
    const s = views.openInternalPage('settings')
    for (let i = 1; i < MAX_TABS; i++) tab(`https://t${i}.test/`, { activate: true })
    expect(views.listTabs()).toHaveLength(MAX_TABS)
    expect(selected()).not.toBe(s)

    expect(views.openInternalPage('settings')).toBe(s)
    expect(selected()).toBe(s)
    expect(views.listTabs()).toHaveLength(MAX_TABS)
  })
})

describe('普通 tab 变成内部页面（BS-U5）', () => {
  it('BS-U5 navigateTab(A, shuvix://settings)：id 不变、did-navigate 带 shuvix://settings、最后加载 about:blank、行变成内部页面', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    bw.webContents.send.mockClear()
    a.view.webContents.loadURL.mockClear()

    views.navigateTab(a.id, SETTINGS)

    expect(views.listTabs().map((t) => t.id)).toEqual([a.id])
    expect(sent(bw, 'browser-view:did-navigate')).toEqual([{ tabId: a.id, url: SETTINGS }])
    expect(a.view.webContents.loadURL.mock.calls.at(-1)).toEqual(['about:blank'])
    expect(views.isInternalTab(a.id)).toBe(true)
    expect(row(a.id)).toMatchObject({ url: SETTINGS, internalPage: 'settings', active: true })
    expect(views.tabDisplayUrl(a.id)).toBe(SETTINGS)
    expect(sent(bw, 'browser-view:tab-created')).toEqual([])
  })

  it('BS-U5 大小写 / 结尾斜杠的写法一样认（SHUVIX://Settings/）', () => {
    const a = tab('https://a.test/', { activate: true })
    views.navigateTab(a.id, 'SHUVIX://Settings/')
    expect(views.isInternalTab(a.id)).toBe(true)
    expect(row(a.id)?.url).toBe(SETTINGS)
  })

  it('BS-U5 占位自己的 did-start-navigation / did-navigate（about:blank）：仍是内部页面，发出去的地址都是 shuvix://settings', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    views.navigateTab(a.id, SETTINGS)
    bw.webContents.send.mockClear()

    startNav(a.view, 'about:blank')
    committed(a.view, 'about:blank')
    a.view.webContents.fire('did-navigate-in-page', {}, 'about:blank', true)

    expect(views.isInternalTab(a.id)).toBe(true)
    expect(row(a.id)).toMatchObject({ url: SETTINGS, internalPage: 'settings' })
    const urls = (
      sent(bw, 'browser-view:did-navigate') as Array<{ tabId: string; url: string }>
    ).map((p) => [p.tabId, p.url])
    expect(urls.length).toBeGreaterThanOrEqual(2)
    for (const [tabId, url] of urls) {
      expect(tabId).toBe(a.id)
      expect(url).toBe(SETTINGS)
    }
  })

  it('BS-U5 agent 接着的 tab：browserCdpManager.detach(A)、卸掉防护、去掉「正被谁使用」', () => {
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    views.noteAgentUse(a.id, 's1')
    views.noteAgentUse(b.id, 's1')
    expect(row(a.id)?.agentSessionId).toBe('s1')
    state.uninstallAgentGuards.mockClear()

    views.navigateTab(a.id, SETTINGS)

    expect(state.detach.mock.calls).toEqual([[a.id]])
    expect(state.uninstallAgentGuards.mock.calls).toEqual([[a.id]])
    expect(row(a.id)).not.toHaveProperty('agentSessionId')
    expect(row(a.id)).not.toHaveProperty('agentSessionTitle')
    // 别的 tab 不受影响
    expect(row(b.id)?.agentSessionId).toBe('s1')
  })

  it('BS-U5 detach 失败（rejected）也不留下未处理的拒绝', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      state.detach.mockRejectedValueOnce(new Error('not attached'))
      const a = tab('https://a.test/', { activate: true })
      expect(() => views.navigateTab(a.id, SETTINGS)).not.toThrow()
      await new Promise((r) => setImmediate(r))
      expect(unhandled).not.toHaveBeenCalled()
      expect(views.isInternalTab(a.id)).toBe(true)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('内部页面变回普通页面（BS-U6）', () => {
  it('BS-U6 navigateTab(S, https://b.test/)：不再是内部页面，加载那个地址', () => {
    const s = views.openInternalPage('settings')
    const view = viewOf(s)
    view.webContents.loadURL.mockClear()

    views.navigateTab(s, 'https://b.test/')

    expect(views.isInternalTab(s)).toBe(false)
    expect(view.webContents.loadURL.mock.calls).toEqual([['https://b.test/']])
    expect(row(s)).not.toHaveProperty('internalPage')
    expect(row(s)?.url).toBe('https://b.test/')
    expect(views.tabDisplayUrl(s)).toBe('https://b.test/')
    // 不 detach（它本来就不是 agent 能碰的）
    expect(state.detach).not.toHaveBeenCalled()
  })

  it('BS-U6 主框架、非同文档的 did-start-navigation 去别的地址（后退 / 前进）：变回普通页面', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    views.navigateTab(a.id, SETTINGS)
    bw.webContents.send.mockClear()

    startNav(a.view, 'https://a.test/')

    expect(views.isInternalTab(a.id)).toBe(false)
    expect(sent(bw, 'browser-view:did-navigate')).toEqual([{ tabId: a.id, url: 'https://a.test/' }])
    committed(a.view, 'https://a.test/')
    expect(row(a.id)).not.toHaveProperty('internalPage')
    expect(row(a.id)?.url).toBe('https://a.test/')
  })

  it.each([
    ['子框架', { isMainFrame: false }],
    ['同文档', { isSameDocument: true }]
  ] as const)('BS-U6 %s的导航不算：仍是内部页面', (_label, over) => {
    const a = tab('https://a.test/', { activate: true })
    views.navigateTab(a.id, SETTINGS)

    startNav(a.view, 'https://elsewhere.test/', over)

    expect(views.isInternalTab(a.id)).toBe(true)
    expect(row(a.id)).toMatchObject({ url: SETTINGS, internalPage: 'settings' })
  })
})

describe('边角与收尾（BS-U7）', () => {
  it('BS-U7 不存在的 id：navigateTab 不抛、什么也不加载', () => {
    const a = tab('https://a.test/', { activate: true })
    a.view.webContents.loadURL.mockClear()
    expect(() => views.navigateTab('no-such-tab', SETTINGS)).not.toThrow()
    expect(() => views.navigateTab('no-such-tab', 'https://b.test/')).not.toThrow()
    expect(a.view.webContents.loadURL).not.toHaveBeenCalled()
    expect(views.isInternalTab('no-such-tab')).toBe(false)
    expect(state.detach).not.toHaveBeenCalled()
  })

  it('BS-U7 webContents 已销毁：navigateTab 不抛、什么也不加载、不变成内部页面', () => {
    const a = tab('https://a.test/', { activate: true })
    a.view.webContents.loadURL.mockClear()
    a.view.webContents.destroyed = true
    expect(() => views.navigateTab(a.id, SETTINGS)).not.toThrow()
    expect(a.view.webContents.loadURL).not.toHaveBeenCalled()
    expect(views.isInternalTab(a.id)).toBe(false)
    expect(state.detach).not.toHaveBeenCalled()
  })

  it('BS-U7 tabDisplayUrl：设置页是 shuvix://settings；普通页照原样；不存在的是空串', () => {
    const s = views.openInternalPage('settings')
    const a = tab('https://a.test/x')
    expect(views.tabDisplayUrl(s)).toBe(SETTINGS)
    expect(views.tabDisplayUrl(a.id)).toBe('https://a.test/x')
    expect(views.tabDisplayUrl('no-such-tab')).toBe('')
  })

  it('BS-U7 closeTab(S)：忘掉它；再开一次是一个新的设置页', () => {
    const s = views.openInternalPage('settings')
    views.closeTab(s)
    expect(views.isInternalTab(s)).toBe(false)
    expect(views.listTabs()).toEqual([])

    const again = views.openInternalPage('settings')
    expect(again).not.toBe(s)
    expect(views.isInternalTab(again)).toBe(true)
  })

  it('BS-U7 closeTab(S, {remember}) 之后 reopenClosedTab()：开回一个设置页、选中它', () => {
    const bw = openByUser()
    tab('https://a.test/', { activate: true })
    const s = views.openInternalPage('settings')
    views.closeTab(s, { remember: true })
    bw.webContents.send.mockClear()

    const reopened = views.reopenClosedTab()
    expect(reopened).not.toBeNull()
    expect(reopened).not.toBe(s)
    expect(views.isInternalTab(reopened!)).toBe(true)
    expect(row(reopened!)).toMatchObject({ url: SETTINGS, internalPage: 'settings', active: true })
    expect(sent(bw, 'browser-view:tab-created')).toEqual([
      { tabId: reopened, url: SETTINGS, active: true }
    ])
    expect(viewOf(reopened!).webContents.loaded).toEqual(['about:blank'])
    // 记录用掉了
    expect(views.reopenClosedTab()).toBeNull()
  })

  it('BS-U7 重开时设置页已经开着：回那一个、选中它，不多建', () => {
    const s1 = views.openInternalPage('settings')
    views.closeTab(s1, { remember: true })
    const s2 = views.openInternalPage('settings')
    const a = tab('https://a.test/', { activate: true })
    expect(selected()).toBe(a.id)
    const count = views.listTabs().length

    expect(views.reopenClosedTab()).toBe(s2)
    expect(selected()).toBe(s2)
    expect(views.listTabs()).toHaveLength(count)
    expect(views.listTabs().filter((t) => t.internalPage)).toHaveLength(1)
  })

  it('BS-U7 destroyAllTabs：清掉内部页面记录；之后再开是一个新的', () => {
    const s = views.openInternalPage('settings')
    views.destroyAllTabs()
    expect(views.isInternalTab(s)).toBe(false)
    expect(views.listTabs()).toEqual([])

    const again = views.openInternalPage('settings')
    expect(again).not.toBe(s)
    expect(views.listTabs().map((t) => t.id)).toEqual([again])
  })
})
