/**
 * browserViewService 的 tab 状态通知（2026-11-01）：web 客户端的浏览器管理页（另一台设备、无头运行时根本没有浏览器
 * 窗口）只靠 app 事件 `browser.tabsChanged` 知道标签页变了。会改变 listTabs 结果的推送（加载开始 / 结束、导航、
 * 加载失败与渲染进程崩溃、标题、选中、agent 使用）合并成一条尾随的事件（TAB_STATE_NOTIFY_MS = 250ms 后，count =
 * 此刻的 tab 数）；建 / 关照旧立刻发。
 *
 *   TS-1  一个 tab、没有浏览器窗口：did-start-loading → 当下不发，250ms 后发一条 count 1
 *   TS-2  一个窗口期里加载开始 + 标题 + did-navigate + 加载结束 → 恰好一条；再过一秒没有别的
 *   TS-3  隔开的两个窗口期 → 两条
 *   TS-4  某 tab 状态变了、计时还没到时又建了第三个 tab → 建的那条立刻发（count 3），尾随的那条也是 count 3
 *   TS-5  加载开始 / 结束、did-navigate、did-navigate-in-page（主框架）、did-fail-load（主框架）、
 *         render-process-gone、标题、选中另一个 tab、noteAgentUse —— 单独一个就各引出一条尾随的事件（没有窗口）
 *   TS-6  图标更新、zoomTab、节流内重复的 noteAgentUse（同一会话）→ 不发
 *   TS-7  createTab / closeTab 照旧立刻发、count 是新的 tab 数；之后还有尾随的那条
 *   TS-8  有浏览器窗口时：标题变了照样发 browser-view:tab-title-updated 给窗口，250ms 后再发一条 app 事件
 *   TS-9  直接调 noteTabStateChanged() 三次 → 一条
 *
 * electron 是 ./fakeElectron.ts；agentGuards / browserCdpService 是间谍；browserViewService / browserWindowService
 * 与 appEventBus 是真的（只数 browser.tabsChanged）。假计时器：每条用例 resetModules 重新导入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeElectron, type FakeView, type FakeWindow } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

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
  uninstallAgentGuards: vi.fn(),
  hasAgentGuards: () => false,
  agentActing: () => false,
  agentOpInFlight: () => false
}))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    session: vi.fn(async () => ({ enableDialogHandling: vi.fn(async () => {}) })),
    handleExternalDetach: vi.fn(),
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: vi.fn(async () => {})
  }
}))

const fx = fakeElectron()

type ViewService = typeof import('../browserViewService')
type WindowService = typeof import('../browserWindowService')

let views: ViewService
let wins: WindowService
/** 收到的 browser.tabsChanged 的 count，按顺序 */
let events: number[]

async function load(): Promise<void> {
  views = await import('../browserViewService')
  wins = await import('../browserWindowService')
  wins.initBrowserWindowService({ getThemeBgColor: () => '#000000' })
  const { appEventBus } = await import('../../../utils/appEventBus')
  events = []
  appEventBus.subscribe((event) => {
    if (event.type === 'browser.tabsChanged') events.push(event.count)
  })
}

/** 建一个 tab，回它的 id 与 view */
function tab(url?: string, opts?: { activate?: boolean }): { id: string; view: FakeView } {
  const id = views.createTab(url, opts)
  return { id, view: fx.views[fx.views.length - 1] }
}

/** 把已经排着的尾随事件放掉，清空记录（之后的用例只看自己引出的） */
function settle(): void {
  vi.advanceTimersByTime(views.TAB_STATE_NOTIFY_MS * 4)
  events.length = 0
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  fx.reset()
  await load()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('tab 状态的合并通知（TS-1 … TS-9）', () => {
  it('TAB_STATE_NOTIFY_MS 是 250', () => {
    expect(views.TAB_STATE_NOTIFY_MS).toBe(250)
  })

  it('TS-1 一个 tab、没有浏览器窗口：did-start-loading 当下不发，250ms 后一条 count 1', () => {
    const a = tab('https://a.test/')
    settle()
    expect(fx.browserWindows()).toEqual([])

    a.view.webContents.fire('did-start-loading')
    expect(events).toEqual([])
    vi.advanceTimersByTime(249)
    expect(events).toEqual([])
    vi.advanceTimersByTime(1)
    expect(events).toEqual([1])
  })

  it('TS-2 一个窗口期里加载开始 + 标题 + did-navigate + 加载结束 → 恰好一条；再过一秒没有别的', () => {
    const a = tab('https://a.test/')
    settle()

    const wc = a.view.webContents
    wc.fire('did-start-loading')
    vi.advanceTimersByTime(50)
    wc.fire('page-title-updated', {}, 'A page')
    wc.fire('did-navigate', {}, 'https://a.test/next')
    vi.advanceTimersByTime(100)
    wc.fire('did-stop-loading')
    vi.advanceTimersByTime(100)
    expect(events).toEqual([1])
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([1])
  })

  it('TS-3 隔开的两个窗口期 → 两条', () => {
    const a = tab('https://a.test/')
    settle()

    a.view.webContents.fire('did-start-loading')
    vi.advanceTimersByTime(250)
    expect(events).toEqual([1])
    a.view.webContents.fire('did-stop-loading')
    vi.advanceTimersByTime(250)
    expect(events).toEqual([1, 1])
  })

  it('TS-4 状态变了、计时还没到时建第三个 tab：建的那条立刻 count 3，尾随的那条也是 count 3', () => {
    const a = tab('https://a.test/')
    tab('https://b.test/')
    settle()

    a.view.webContents.fire('page-title-updated', {}, 'A')
    vi.advanceTimersByTime(100)
    tab('https://c.test/')
    expect(events).toEqual([3])
    vi.advanceTimersByTime(250)
    expect(events).toEqual([3, 3])
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([3, 3])
  })

  type Trigger = (ctx: { a: FakeView; aId: string; bId: string }) => void
  it.each<[string, Trigger]>([
    ['did-start-loading', ({ a }) => void a.webContents.fire('did-start-loading')],
    ['did-stop-loading', ({ a }) => void a.webContents.fire('did-stop-loading')],
    ['did-navigate', ({ a }) => void a.webContents.fire('did-navigate', {}, 'https://a.test/x')],
    [
      'did-navigate-in-page（主框架）',
      ({ a }) => void a.webContents.fire('did-navigate-in-page', {}, 'https://a.test/#two', true)
    ],
    [
      'did-fail-load（主框架）',
      ({ a }) =>
        void a.webContents.fire(
          'did-fail-load',
          {},
          -105,
          'ERR_NAME_NOT_RESOLVED',
          'https://nope.test/',
          true
        )
    ],
    [
      'render-process-gone',
      ({ a }) => void a.webContents.fire('render-process-gone', {}, { reason: 'crashed' })
    ],
    ['page-title-updated', ({ a }) => void a.webContents.fire('page-title-updated', {}, 'Title')],
    ['activateTab(另一个 tab)', ({ bId }) => views.activateTab(bId)],
    ['noteAgentUse', ({ aId }) => views.noteAgentUse(aId, 'session-1')]
  ])('TS-5 %s → 一条尾随的事件（没有浏览器窗口）', (_l, trigger) => {
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    settle()
    expect(fx.browserWindows()).toEqual([])

    trigger({ a: a.view, aId: a.id, bId: b.id })
    expect(events).toEqual([])
    vi.advanceTimersByTime(250)
    expect(events).toEqual([2])
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([2])
  })

  it('TS-6 图标更新、zoomTab、节流内重复的 noteAgentUse（同一会话）→ 不发', () => {
    const a = tab('https://a.test/', { activate: true })
    const usedAt = Date.now()
    views.noteAgentUse(a.id, 'session-1')
    settle()

    a.view.webContents.fire('page-favicon-updated', {}, ['https://a.test/favicon.ico'])
    views.zoomTab(a.id, 'in')
    views.zoomTab(a.id, 'reset')
    // 同一会话、节流（250ms）之内：不再发 tab-agent，也就不通知。时钟拨回第一次使用之后 100ms（不触发计时器）
    vi.setSystemTime(usedAt + 100)
    views.noteAgentUse(a.id, 'session-1')
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([])
  })

  it('TS-7 createTab / closeTab 照旧立刻发、count 是新的 tab 数；之后还有尾随的那条', () => {
    const a = tab('https://a.test/', { activate: true })
    // 建的那条立刻发；第一个 tab 会被选中（tab-activated）→ 尾随一条
    expect(events).toEqual([1])
    vi.advanceTimersByTime(250)
    expect(events).toEqual([1, 1])

    events.length = 0
    const b = tab('https://b.test/', { activate: true })
    expect(events).toEqual([2])
    vi.advanceTimersByTime(250)
    expect(events).toEqual([2, 2])

    events.length = 0
    // 关掉选中的那页：选中落到别的页（tab-activated）→ 立刻一条 count 1，尾随一条
    views.closeTab(b.id)
    expect(events).toEqual([1])
    vi.advanceTimersByTime(250)
    expect(events).toEqual([1, 1])
    expect(views.listTabs().map((t) => t.id)).toEqual([a.id])
  })

  it('TS-8 有浏览器窗口：标题变了照样发 tab-title-updated 给窗口，250ms 后再一条 app 事件', () => {
    wins.openBrowserWindow()
    const all = fx.browserWindows()
    expect(all).toHaveLength(1)
    const bw: FakeWindow = all[0]
    const a = tab('https://a.test/', { activate: true })
    settle()
    bw.webContents.send.mockClear()

    a.view.webContents.fire('page-title-updated', {}, 'Hello')
    expect(bw.webContents.send).toHaveBeenCalledWith('browser-view:tab-title-updated', {
      tabId: a.id,
      title: 'Hello'
    })
    expect(events).toEqual([])
    vi.advanceTimersByTime(250)
    expect(events).toEqual([1])
  })

  it('TS-9 直接调 noteTabStateChanged() 三次 → 一条', () => {
    tab('https://a.test/')
    tab('https://b.test/')
    settle()

    views.noteTabStateChanged()
    views.noteTabStateChanged()
    vi.advanceTimersByTime(100)
    views.noteTabStateChanged()
    expect(events).toEqual([])
    vi.advanceTimersByTime(250)
    expect(events).toEqual([2])
    vi.advanceTimersByTime(1000)
    expect(events).toEqual([2])
  })
})
