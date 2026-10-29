/**
 * browserViewService 的「Chrome 化」一侧（2026-10-16）：选中只属于用户、agent 只留标记、⌘⇧T 重开、
 * 按站点缩放、单页布局、快捷键接线。
 *
 *   CB-U16  createTab：`activate` → 选中（tab-created{active:true} 再 tab-activated）；不给就开在后台
 *           （tab-created{active:false}、不发 tab-activated、选中不变），一个都没选中时照样成为选中的那页；
 *           agent 开的行带 openerSessionId，用户开的没有这个键；
 *   CB-U17  关掉选中的那页落到右邻（无则左邻），关最后一个置空；关没选中的不动选中；页面自己关掉
 *           （destroyed）同样落位；
 *   CB-U18  noteAgentUse：不选中、不发 tab-activated，发 tab-agent{tabId, sessionId, sessionTitle}，listTabs 的行
 *           带 agentSessionId / agentSessionTitle；同一会话 250ms 内节流、换会话立刻发、最后一个会话为准；
 *           不存在的 tab 什么也不做；标题钩子抛错 → ''；
 *   CB-U19  openAgentSession 交给宿主钩子、回它的布尔值；
 *   CB-U20  ⌘⇧T：closeTab(…, {remember}) 记下地址，reopenClosedTab 开在前台、后进先出；空 → null 不建 tab；
 *           agent 的关闭、空白页、页面自己关掉的都不记；最多记 10 个；
 *   CB-U21  开满 12 个时 reopenClosedTab → null、记录留着；关掉一个之后能重开那个地址；
 *   CB-U22  弹出页选不选中：用户正看着浏览器窗口 + 开它的就是选中的那页 + agent 没在那页上动作 → 选中、
 *           不带 openerSessionId；其余（开它的没选中 / agent 正在动作 / 窗口隐藏、没焦点、最小化）开在后台，
 *           agent 动作出来的记在那个会话名下；
 *   CB-U23/24  按站点缩放：键 = 不含端口的主机名（localhost:3000 与 :4000 同站），没有主机名的按整个地址
 *           （去掉 #）；单页（无 zoom 的布局项）立刻生效、同站的每个 tab 都收到 tab-zoom、停放的同站 tab
 *           上墙时才生效；平铺墙的项（带 zoom）不被覆盖，回到无 zoom 的项时恢复用户缩放；
 *   CB-U25  导航事件：did-navigate 带全量并按新站点重设缩放；did-start-navigation（主框架、非同文档）
 *           只带 {tabId, url}；did-navigate-in-page 主框架全量、子框架不发；
 *   CB-U27  单页布局：表里只有选中的那项 → 只有它挂在浏览器窗口上，其余在停放窗口 1280×800；空表全回停放；
 *   CB-U28  快捷键接线：每个 tab 与外壳各一个 before-input-event（外壳装两次还是一个）；F5 → preventDefault
 *           一次、刷新**选中的**那页（按键落在别的 tab 上也一样）；⌘/Ctrl+A、keyUp 不拦；
 *   CB-U29  newTab / focusOmnibox：窗口在前台 → 新的空白页选中、外壳 webContents.focus 一次、发
 *           browser-view:command{focusOmnibox}，什么窗口都没被弄到眼前；窗口隐藏 / 最小化 / 没焦点 /
 *           从没建过 → tab 照建照选中，但不 focus、不发 command；开满 12 个 → newTab 什么也不做；
 *   CB-U30/31  close / reload（含忽略缓存）/ back / forward 只作用于选中的那页，没有 tab 时什么也不做；
 *           next / prev 绕回；selectTab 0 / 2 / -1，越界什么也不做；zoom 作用于选中的那页；
 *   CB-U32  destroyAllTabs 清掉重开记录与用户缩放。
 *
 * electron 是 ./fakeElectron.ts；agentGuards / browserCdpService 是间谍（agentActing / hasAgentGuards 按用例
 * 拨的 tab 集合回答）；browserViewService / browserWindowService / stagingWindow / externalOpen 的裁决
 * 都是真的。发给浏览器窗口的事件 = 浏览器窗口 webContents.send 的调用。每条用例 resetModules 重新导入。
 * 全文件不变量（afterEach）：没有 view 被 setVisible 过 true 以外的值，没有 view 同时挂在两个窗口上。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeElectron, type FakeView, type FakeWindow, type Rect } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

const state = vi.hoisted(() => {
  const enableDialogHandling = vi.fn(async () => {})
  return {
    /** agentActing 回 true 的 tab */
    acting: new Set<string>(),
    /** hasAgentGuards 回 true 的 tab */
    guarded: new Set<string>(),
    uninstallAgentGuards: vi.fn((_tabId: string) => {}),
    enableDialogHandling,
    session: vi.fn(async (_tabId: string) => ({ enableDialogHandling })),
    handleExternalDetach: vi.fn((_tabId: string, _reason?: string) => {})
  }
})

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
  hasAgentGuards: (tabId: string) => state.guarded.has(tabId),
  agentActing: (tabId: string) => state.acting.has(tabId),
  agentOpInFlight: () => false
}))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    session: (tabId: string) => state.session(tabId),
    handleExternalDetach: (tabId: string, reason?: string) =>
      state.handleExternalDetach(tabId, reason),
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: vi.fn(async () => {})
  }
}))

const fx = fakeElectron()

type ViewService = typeof import('../browserViewService')
type WindowService = typeof import('../browserWindowService')

const BOUNDS: Rect = { x: 0, y: 76, width: 900, height: 600 }
const STAGING_BOUNDS: Rect = { x: 0, y: 0, width: 1280, height: 800 }
const MAX_TABS = 12

let views: ViewService
let wins: WindowService

async function load(): Promise<void> {
  views = await import('../browserViewService')
  wins = await import('../browserWindowService')
  wins.initBrowserWindowService({ getThemeBgColor: () => '#000000' })
}

/** 用户经顶栏按钮把浏览器窗口建出来（可见、有焦点），清掉开窗本身的动作记录与事件 */
function openByUser(): FakeWindow {
  wins.openBrowserWindow()
  const all = fx.browserWindows()
  if (all.length !== 1) throw new Error(`expected one browser window, got ${all.length}`)
  const bw = all[0]
  fx.clearCalls()
  bw.webContents.send.mockClear()
  bw.webContents.focus.mockClear()
  return bw
}

/** 建一个 tab，回它的 id 与 view */
function tab(
  url?: string,
  opts?: { activate?: boolean; openerSessionId?: string }
): { id: string; view: FakeView } {
  const id = views.createTab(url, opts)
  return { id, view: fx.views[fx.views.length - 1] }
}

/** 浏览器窗口收到的事件（可按 channel 过滤） */
function sent(bw: FakeWindow, channel?: string): unknown[] {
  return bw.webContents.send.mock.calls
    .filter(([c]) => channel === undefined || c === channel)
    .map(([c, p]) => (channel === undefined ? [c, p] : p))
}

function channels(bw: FakeWindow): string[] {
  return bw.webContents.send.mock.calls.map(([c]) => c)
}

const selected = (): string | undefined => views.listTabs().find((t) => t.active)?.id
const row = (id: string): ReturnType<ViewService['listTabs']>[number] | undefined =>
  views.listTabs().find((t) => t.id === id)

/** 以这个 view 的名义 window.open(url) */
function popup(view: FakeView, url: string): unknown {
  const handler = view.webContents.openHandler
  if (!handler) throw new Error('createTab 没有登记 setWindowOpenHandler')
  return handler({ url })
}

/** 一次 before-input-event：回 preventDefault 间谍 */
function key(
  handler: (...args: unknown[]) => unknown,
  input: Record<string, unknown>
): ReturnType<typeof vi.fn> {
  const event = { preventDefault: vi.fn() }
  handler(event, {
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

/** 某个 tab view 的 before-input-event 处理函数（恰好一个，否则抛） */
function tabKeyHandler(view: FakeView): (...args: unknown[]) => unknown {
  const list = view.webContents.handlers.get('before-input-event') ?? []
  if (list.length !== 1)
    throw new Error(`expected one before-input-event handler, got ${list.length}`)
  return list[0]
}

/** 外壳（浏览器窗口 webContents）上登记的 before-input-event 处理函数 */
function shellKeyHandlers(bw: FakeWindow): Array<(...args: unknown[]) => unknown> {
  return bw.webContents.on.mock.calls
    .filter(([event]) => event === 'before-input-event')
    .map(([, fn]) => fn as (...args: unknown[]) => unknown)
}

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

beforeEach(async () => {
  vi.resetModules()
  fx.reset()
  state.acting.clear()
  state.guarded.clear()
  state.uninstallAgentGuards.mockClear()
  state.session.mockClear()
  state.enableDialogHandling.mockClear()
  state.handleExternalDetach.mockClear()
  await load()
})

afterEach(() => {
  vi.restoreAllMocks()
  expect(fx.hiddenViews(), 'a tab view was setVisible(false)').toEqual([])
  expect(fx.doubleParented, 'a tab view hung on two windows at once').toEqual([])
})

// ─────────────────────────────────────────────────────────────────────────

describe('createTab 选不选中（CB-U16）', () => {
  it('CB-U16 activate → 选中；事件 tab-created{active:true} 之后 tab-activated', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    expect(selected()).toBe(a.id)
    expect(sent(bw, 'browser-view:tab-created')).toEqual([
      { tabId: a.id, url: 'https://a.test/', active: true }
    ])
    const order = channels(bw)
    expect(order.indexOf('browser-view:tab-created')).toBeLessThan(
      order.indexOf('browser-view:tab-activated')
    )
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([{ tabId: a.id }])

    const b = tab('https://b.test/', { activate: true })
    expect(selected()).toBe(b.id)
  })

  it('CB-U16 已有选中的页：createTab(url, {openerSessionId}) 开在后台，选中不变、不发 tab-activated；行上带 openerSessionId', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    bw.webContents.send.mockClear()

    const b = tab('https://b.test/', { openerSessionId: 's1' })
    expect(sent(bw, 'browser-view:tab-created')).toEqual([
      { tabId: b.id, url: 'https://b.test/', active: false }
    ])
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([])
    expect(selected()).toBe(a.id)
    expect(row(b.id)?.openerSessionId).toBe('s1')
    expect(views.openerSessionOf(b.id)).toBe('s1')
    // 用户开的行上没有这个键
    expect(row(a.id)).not.toHaveProperty('openerSessionId')
    expect(views.openerSessionOf(a.id)).toBeUndefined()
  })

  it('CB-U16 一个 tab 都没有：后台开的 tab 照样成为选中的那页', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { openerSessionId: 's1' })
    expect(selected()).toBe(a.id)
    expect(sent(bw, 'browser-view:tab-created')).toEqual([
      { tabId: a.id, url: 'https://a.test/', active: true }
    ])
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([{ tabId: a.id }])
    expect(row(a.id)?.openerSessionId).toBe('s1')
  })

  it('CB-U16 不给地址：tab-created 报 about:blank，并真的加载 about:blank', () => {
    const bw = openByUser()
    const a = tab(undefined, { activate: true })
    expect(sent(bw, 'browser-view:tab-created')).toEqual([
      { tabId: a.id, url: 'about:blank', active: true }
    ])
    expect(a.view.webContents.loaded).toEqual(['about:blank'])
  })
})

describe('关掉选中的那页之后选中谁（CB-U17）', () => {
  it('CB-U17 [A,B,C] 选中 B：关 B → C；关 C → A；关 A → 空', () => {
    const bw = openByUser()
    const a = tab('https://a.test/')
    const b = tab('https://b.test/')
    const c = tab('https://c.test/')
    views.activateTab(b.id)
    bw.webContents.send.mockClear()

    views.closeTab(b.id)
    expect(selected()).toBe(c.id)
    expect(sent(bw, 'browser-view:tab-closed')).toEqual([{ tabId: b.id, activeTabId: c.id }])

    views.closeTab(c.id)
    expect(selected()).toBe(a.id)
    expect(sent(bw, 'browser-view:tab-closed').at(-1)).toEqual({ tabId: c.id, activeTabId: a.id })

    views.closeTab(a.id)
    expect(views.listTabs()).toEqual([])
    expect(views.getActiveView()).toBeNull()
    expect(sent(bw, 'browser-view:tab-closed').at(-1)).toEqual({ tabId: a.id, activeTabId: null })
  })

  it('CB-U17 关没选中的 tab：选中不动、不发 tab-activated', () => {
    const bw = openByUser()
    const a = tab('https://a.test/')
    const b = tab('https://b.test/')
    const c = tab('https://c.test/')
    views.activateTab(b.id)
    bw.webContents.send.mockClear()

    views.closeTab(a.id)
    views.closeTab(c.id)
    expect(selected()).toBe(b.id)
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([])
    expect(sent(bw, 'browser-view:tab-closed')).toEqual([
      { tabId: a.id, activeTabId: b.id },
      { tabId: c.id, activeTabId: b.id }
    ])
  })

  it('CB-U17 选中的页面自己关掉（destroyed）：同样落到右邻 / 左邻', () => {
    const bw = openByUser()
    const a = tab('https://a.test/')
    const b = tab('https://b.test/')
    const c = tab('https://c.test/')
    views.activateTab(b.id)
    bw.webContents.send.mockClear()

    b.view.webContents.destroyed = true
    b.view.webContents.fire('destroyed')
    expect(selected()).toBe(c.id)
    expect(sent(bw, 'browser-view:tab-closed')).toEqual([{ tabId: b.id, activeTabId: c.id }])

    c.view.webContents.destroyed = true
    c.view.webContents.fire('destroyed')
    expect(selected()).toBe(a.id)
  })
})

describe('agent 在用哪页（CB-U18 / CB-U19）', () => {
  it('CB-U18 noteAgentUse：不选中、不发 tab-activated；发 tab-agent（带会话标题），listTabs 的行带上会话', () => {
    const bw = openByUser()
    views.setBrowserSessionHooks({
      sessionTitle: (id) => (id === 's1' ? 'Alpha' : 'Beta'),
      openSession: () => true
    })
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    bw.webContents.send.mockClear()

    views.noteAgentUse(b.id, 's1')
    expect(selected()).toBe(a.id)
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([])
    expect(sent(bw, 'browser-view:tab-agent')).toEqual([
      { tabId: b.id, sessionId: 's1', sessionTitle: 'Alpha' }
    ])
    expect(row(b.id)).toMatchObject({ agentSessionId: 's1', agentSessionTitle: 'Alpha' })
    expect(row(a.id)).not.toHaveProperty('agentSessionId')
    expect(row(a.id)).not.toHaveProperty('agentSessionTitle')
  })

  it('CB-U18 节流：同一会话 250ms 内不重发、到点再发；换会话立刻发，最后一个会话为准', () => {
    const bw = openByUser()
    views.setBrowserSessionHooks({
      sessionTitle: (id) => (id === 's1' ? 'Alpha' : 'Beta'),
      openSession: () => true
    })
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const b = tab('https://b.test/', { activate: true })
    bw.webContents.send.mockClear()
    const agentEvents = (): unknown[] => sent(bw, 'browser-view:tab-agent')

    views.noteAgentUse(b.id, 's1')
    expect(agentEvents()).toHaveLength(1)
    now += 100
    views.noteAgentUse(b.id, 's1')
    now += 149
    views.noteAgentUse(b.id, 's1')
    expect(agentEvents()).toHaveLength(1)
    now += 1 // 距上一次发 250ms
    views.noteAgentUse(b.id, 's1')
    expect(agentEvents()).toHaveLength(2)

    // 换会话：不等节流
    now += 10
    views.noteAgentUse(b.id, 's2')
    expect(agentEvents()).toHaveLength(3)
    expect(agentEvents().at(-1)).toEqual({ tabId: b.id, sessionId: 's2', sessionTitle: 'Beta' })
    expect(row(b.id)).toMatchObject({ agentSessionId: 's2', agentSessionTitle: 'Beta' })

    // 再换回去：也立刻发
    now += 10
    views.noteAgentUse(b.id, 's1')
    expect(agentEvents()).toHaveLength(4)
    expect(row(b.id)).toMatchObject({ agentSessionId: 's1', agentSessionTitle: 'Alpha' })
  })

  it('CB-U18 不存在的 tab：什么也不做', () => {
    const bw = openByUser()
    tab('https://a.test/', { activate: true })
    bw.webContents.send.mockClear()
    views.noteAgentUse('no-such-tab', 's1')
    expect(sent(bw)).toEqual([])
    expect(views.listTabs().some((t) => t.agentSessionId)).toBe(false)
  })

  it('CB-U18 标题钩子抛错 → 标题是空串（事件与行都是）', () => {
    const bw = openByUser()
    views.setBrowserSessionHooks({
      sessionTitle: () => {
        throw new Error('db gone')
      },
      openSession: () => false
    })
    const a = tab('https://a.test/', { activate: true })
    bw.webContents.send.mockClear()
    expect(() => views.noteAgentUse(a.id, 's1')).not.toThrow()
    expect(sent(bw, 'browser-view:tab-agent')).toEqual([
      { tabId: a.id, sessionId: 's1', sessionTitle: '' }
    ])
    expect(row(a.id)).toMatchObject({ agentSessionId: 's1', agentSessionTitle: '' })
  })

  it('CB-U18 没注入钩子：标题是空串', () => {
    const a = tab('https://a.test/', { activate: true })
    views.noteAgentUse(a.id, 's1')
    expect(row(a.id)).toMatchObject({ agentSessionId: 's1', agentSessionTitle: '' })
  })

  it('CB-U19 openAgentSession 交给宿主钩子并回它的布尔值；没注入时回 false', () => {
    expect(views.openAgentSession('s1')).toBe(false)
    const openSession = vi.fn((id: string) => id === 's1')
    views.setBrowserSessionHooks({ sessionTitle: () => '', openSession })
    expect(views.openAgentSession('s1')).toBe(true)
    expect(views.openAgentSession('gone')).toBe(false)
    expect(openSession.mock.calls).toEqual([['s1'], ['gone']])
  })
})

describe('⌘⇧T 重开（CB-U20 / CB-U21）', () => {
  it('CB-U20 用户关掉的页重开：新 tab、选中、加载原地址；后进先出', () => {
    const a = tab('https://a.test/x', { activate: true })
    const b = tab('https://b.test/y')
    views.closeTab(a.id, { remember: true })
    views.closeTab(b.id, { remember: true })
    expect(views.listTabs()).toEqual([])

    const first = views.reopenClosedTab()
    expect(first).not.toBeNull()
    expect(fx.views.at(-1)?.webContents.loaded).toEqual(['https://b.test/y'])
    expect(selected()).toBe(first)

    const second = views.reopenClosedTab()
    expect(second).not.toBeNull()
    expect(fx.views.at(-1)?.webContents.loaded).toEqual(['https://a.test/x'])
    expect(selected()).toBe(second)

    const viewsBefore = fx.views.length
    expect(views.reopenClosedTab()).toBeNull()
    expect(fx.views).toHaveLength(viewsBefore)
  })

  it('CB-U20 有别的页选中时，重开的也开在前台', () => {
    const bw = openByUser()
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    views.closeTab(b.id, { remember: true })
    expect(selected()).toBe(a.id)
    bw.webContents.send.mockClear()

    const id = views.reopenClosedTab()
    expect(selected()).toBe(id)
    expect(sent(bw, 'browser-view:tab-created')).toEqual([
      { tabId: id, url: 'https://b.test/', active: true }
    ])
  })

  it('CB-U20 不记：agent 的关闭（不带 remember）、空白页、页面自己关掉的', () => {
    const viaAgent = tab('https://agent.test/')
    views.closeTab(viaAgent.id)
    const blank = tab()
    views.closeTab(blank.id, { remember: true })
    const blank2 = tab('about:blank')
    views.closeTab(blank2.id, { remember: true })
    const selfClosed = tab('https://self.test/')
    selfClosed.view.webContents.destroyed = true
    selfClosed.view.webContents.fire('destroyed')
    expect(views.listTabs()).toEqual([])

    const viewsBefore = fx.views.length
    expect(views.reopenClosedTab()).toBeNull()
    expect(fx.views).toHaveLength(viewsBefore)
  })

  it('CB-U20 最多记 10 个：关 11 个之后能重开最近的 10 个（倒序），第 11 次 → null', () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://site${i}.test/`)
    const ids = urls.map((u) => tab(u).id)
    for (const id of ids) views.closeTab(id, { remember: true })

    const reopened: string[] = []
    for (let i = 0; i < 10; i++) {
      const id = views.reopenClosedTab()
      expect(id, `reopen #${i + 1}`).not.toBeNull()
      reopened.push(fx.views.at(-1)!.webContents.loaded[0])
    }
    expect(reopened).toEqual(urls.slice(1).reverse())
    const viewsBefore = fx.views.length
    expect(views.reopenClosedTab()).toBeNull()
    expect(fx.views).toHaveLength(viewsBefore)
  })

  it('CB-U21 开满 12 个：reopenClosedTab → null、不抛、记录留着；关掉一个之后重开的是那条记录', () => {
    const x = tab('https://kept.test/page')
    views.closeTab(x.id, { remember: true })
    const ids = Array.from({ length: MAX_TABS }, (_, i) => tab(`https://full${i}.test/`).id)
    expect(views.listTabs()).toHaveLength(MAX_TABS)

    const viewsBefore = fx.views.length
    expect(views.reopenClosedTab()).toBeNull()
    expect(fx.views).toHaveLength(viewsBefore)
    expect(views.listTabs()).toHaveLength(MAX_TABS)

    // agent 那条路关掉一个（不记），腾出位置
    views.closeTab(ids[0])
    const id = views.reopenClosedTab()
    expect(id).not.toBeNull()
    expect(fx.views.at(-1)?.webContents.loaded).toEqual(['https://kept.test/page'])
    expect(selected()).toBe(id)
  })
})

describe('弹出页选不选中（CB-U22）', () => {
  const POPUP = 'https://p.test/'

  /** 弹出页那个新 tab（最后建的 view）与它的行 */
  const popped = (): { id: string | undefined; view: FakeView } => {
    const view = fx.views.at(-1)!
    const r = views.listTabs().at(-1)
    return { id: r?.id, view }
  }

  it('CB-U22 用户正看着窗口、开它的就是选中的那页、agent 没在动作 → 弹出页选中，不带 openerSessionId；handler 一律 deny', () => {
    openByUser()
    const opener = tab('https://o.test/', { activate: true })
    expect(popup(opener.view, POPUP)).toEqual({ action: 'deny' })
    const p = popped()
    expect(p.view).not.toBe(opener.view)
    expect(p.view.webContents.loaded).toEqual([POPUP])
    expect(selected()).toBe(p.id)
    expect(row(p.id!)).not.toHaveProperty('openerSessionId')
  })

  it('CB-U22 开它的不是选中的那页 → 后台', () => {
    openByUser()
    const opener = tab('https://o.test/')
    const current = tab('https://current.test/', { activate: true })
    expect(popup(opener.view, POPUP)).toEqual({ action: 'deny' })
    const p = popped()
    expect(p.view.webContents.loaded).toEqual([POPUP])
    expect(selected()).toBe(current.id)
    expect(row(p.id!)?.active).toBe(false)
  })

  it('CB-U22 agent 正在开它的那页上动作（agentActing）→ 后台，记在那个会话名下', () => {
    openByUser()
    const opener = tab('https://o.test/', { activate: true })
    views.noteAgentUse(opener.id, 's1')
    state.acting.add(opener.id)
    expect(popup(opener.view, POPUP)).toEqual({ action: 'deny' })
    const p = popped()
    expect(p.view.webContents.loaded).toEqual([POPUP])
    expect(selected()).toBe(opener.id)
    expect(row(p.id!)?.openerSessionId).toBe('s1')
  })

  it('CB-U22 agent 动作中、开它的那页装着防护：新 tab 先 about:blank、接上 CDP、再加载弹出页；照样后台、记在会话名下', async () => {
    openByUser()
    const opener = tab('https://o.test/', { activate: true })
    views.noteAgentUse(opener.id, 's1')
    state.acting.add(opener.id)
    state.guarded.add(opener.id)
    expect(popup(opener.view, POPUP)).toEqual({ action: 'deny' })
    await flush()
    const p = popped()
    expect(p.view.webContents.loaded).toEqual(['about:blank', POPUP])
    expect(state.session).toHaveBeenCalledWith(p.id)
    expect(selected()).toBe(opener.id)
    expect(row(p.id!)?.openerSessionId).toBe('s1')
  })

  it('CB-U22 agent 没在动作但窗口不在前台 → 后台、不带 openerSessionId', () => {
    const bw = openByUser()
    const opener = tab('https://o.test/', { activate: true })
    views.noteAgentUse(opener.id, 's1')
    bw.focused = false
    popup(opener.view, POPUP)
    const p = popped()
    expect(selected()).toBe(opener.id)
    expect(row(p.id!)).not.toHaveProperty('openerSessionId')
  })

  it.each([
    ['hidden', (bw: FakeWindow) => bw.emit('close', { preventDefault: () => {} })],
    [
      'unfocused',
      (bw: FakeWindow) => {
        bw.focused = false
      }
    ],
    [
      'minimised',
      (bw: FakeWindow) => {
        bw.minimized = true
        bw.focused = false
      }
    ]
  ] as const)('CB-U22 窗口 %s：开它的就是选中的那页也开在后台', (_label, arrange) => {
    const bw = openByUser()
    const opener = tab('https://o.test/', { activate: true })
    arrange(bw)
    expect(popup(opener.view, POPUP)).toEqual({ action: 'deny' })
    const p = popped()
    expect(p.view.webContents.loaded).toEqual([POPUP])
    expect(selected()).toBe(opener.id)
    expect(row(p.id!)?.active).toBe(false)
    expect(fx.allSurfacing()).toEqual([])
  })

  it('CB-U22 窗口从没建过：后台', () => {
    const opener = tab('https://o.test/', { activate: true })
    popup(opener.view, POPUP)
    const p = popped()
    expect(p.view.webContents.loaded).toEqual([POPUP])
    expect(selected()).toBe(opener.id)
    expect(fx.browserWindows()).toEqual([])
  })
})

describe('按站点缩放（CB-U23 / CB-U24）', () => {
  /** 把窗口打开、墙级门打开，回浏览器窗口 */
  const ready = (): FakeWindow => {
    const bw = openByUser()
    views.setPanelVisible(true)
    return bw
  }

  it('CB-U23 单页（无 zoom 的布局项）：zoomTab(in) 立刻 1.1；同站（不含端口）的每个 tab 收到 tab-zoom 110，别的站 100；停放的同站 tab 上墙时才拿到；reset 回 100', () => {
    const bw = ready()
    const a = tab('http://localhost:3000/a', { activate: true })
    const b = tab('http://localhost:4000/b')
    const c = tab('https://other.test/')
    views.setLayout([{ tabId: a.id, bounds: BOUNDS }])
    fx.clearCalls()
    bw.webContents.send.mockClear()

    views.zoomTab(a.id, 'in')
    expect(a.view.webContents.setZoomFactor.mock.calls).toEqual([[1.1]])
    // 停放着的同站 tab 不动它的页面缩放（不在布局表里）
    expect(b.view.webContents.setZoomFactor).not.toHaveBeenCalled()
    expect(c.view.webContents.setZoomFactor).not.toHaveBeenCalled()
    expect(sent(bw, 'browser-view:tab-zoom')).toEqual([
      { tabId: a.id, zoomPercent: 110 },
      { tabId: b.id, zoomPercent: 110 }
    ])
    expect(views.listTabs().map((t) => t.zoomPercent)).toEqual([110, 110, 100])

    // 用户切到 B（单页视图只给选中那页排位）：B 这才按站点缩放显示
    views.setLayout([{ tabId: b.id, bounds: BOUNDS }])
    expect(b.view.webContents.setZoomFactor.mock.calls).toEqual([[1.1]])

    // 再放大一档、再重置
    views.zoomTab(b.id, 'in')
    expect(views.listTabs().map((t) => t.zoomPercent)).toEqual([125, 125, 100])
    bw.webContents.send.mockClear()
    views.zoomTab(b.id, 'reset')
    expect(b.view.webContents.setZoomFactor.mock.calls.at(-1)).toEqual([1])
    expect(sent(bw, 'browser-view:tab-zoom')).toEqual([
      { tabId: a.id, zoomPercent: 100 },
      { tabId: b.id, zoomPercent: 100 }
    ])
    expect(views.listTabs().map((t) => t.zoomPercent)).toEqual([100, 100, 100])
  })

  it('CB-U23 out 一档：90', () => {
    ready()
    const a = tab('https://a.test/', { activate: true })
    views.setLayout([{ tabId: a.id, bounds: BOUNDS }])
    views.zoomTab(a.id, 'out')
    expect(a.view.webContents.zoom).toBeCloseTo(0.9)
    expect(row(a.id)?.zoomPercent).toBe(90)
  })

  it('CB-U23 没有主机名的页按整个地址（去掉 #）记：两个本地文件各是各的，同一个文件带不带 # 是同一个', () => {
    const bw = ready()
    const one = tab('file:///tmp/one.html', { activate: true })
    const oneFrag = tab('file:///tmp/one.html#part')
    const two = tab('file:///tmp/two.html')
    views.setLayout([{ tabId: one.id, bounds: BOUNDS }])
    bw.webContents.send.mockClear()

    views.zoomTab(one.id, 'in')
    expect(sent(bw, 'browser-view:tab-zoom')).toEqual([
      { tabId: one.id, zoomPercent: 110 },
      { tabId: oneFrag.id, zoomPercent: 110 }
    ])
    expect(row(two.id)?.zoomPercent).toBe(100)
  })

  it('CB-U23 不存在的 tab：什么也不做', () => {
    const bw = ready()
    tab('https://a.test/', { activate: true })
    bw.webContents.send.mockClear()
    views.zoomTab('nope', 'in')
    expect(sent(bw)).toEqual([])
    expect(views.listTabs()[0].zoomPercent).toBe(100)
  })

  it('CB-U24 平铺墙的布局项（带 zoom）不被用户缩放覆盖，但照发 tab-zoom；换回无 zoom 的项时按用户缩放显示', () => {
    const bw = ready()
    const a = tab('https://a.test/', { activate: true })
    views.setLayout([{ tabId: a.id, bounds: BOUNDS, zoom: 0.5 }])
    expect(a.view.webContents.zoom).toBe(0.5)
    fx.clearCalls()
    bw.webContents.send.mockClear()

    views.zoomTab(a.id, 'in')
    expect(a.view.webContents.setZoomFactor).not.toHaveBeenCalled()
    expect(a.view.webContents.zoom).toBe(0.5)
    expect(sent(bw, 'browser-view:tab-zoom')).toEqual([{ tabId: a.id, zoomPercent: 110 }])
    expect(row(a.id)?.zoomPercent).toBe(110)

    views.setLayout([{ tabId: a.id, bounds: BOUNDS }])
    expect(a.view.webContents.setZoomFactor.mock.calls).toEqual([[1.1]])
  })
})

describe('导航事件（CB-U25）', () => {
  it('CB-U25 did-navigate：全量（地址、能否后退 / 前进、站点缩放），并按新站点重设页面缩放', () => {
    const bw = openByUser()
    views.setPanelVisible(true)
    const z = tab('https://a.test/', { activate: true })
    const t = tab('https://b.test/')
    views.setLayout([{ tabId: z.id, bounds: BOUNDS }])
    views.zoomTab(z.id, 'in')
    views.zoomTab(z.id, 'in') // a.test → 125
    views.setLayout([{ tabId: t.id, bounds: BOUNDS }])
    expect(t.view.webContents.zoom).toBe(1)
    bw.webContents.send.mockClear()
    fx.clearCalls()

    // t 导航到 a.test
    t.view.webContents.url = 'https://a.test/p'
    t.view.webContents.canBack = true
    t.view.webContents.fire('did-navigate', {}, 'https://a.test/p')
    expect(t.view.webContents.setZoomFactor.mock.calls).toEqual([[1.25]])
    expect(sent(bw, 'browser-view:did-navigate')).toEqual([
      {
        tabId: t.id,
        url: 'https://a.test/p',
        canGoBack: true,
        canGoForward: false,
        zoomPercent: 125
      }
    ])
  })

  it('CB-U25 did-start-navigation：主框架、非同文档 → 只带 {tabId, url}；子框架 / 同文档不发', () => {
    const bw = openByUser()
    const t = tab('https://a.test/', { activate: true })
    bw.webContents.send.mockClear()

    t.view.webContents.fire('did-start-navigation', {
      url: 'https://b.test/',
      isMainFrame: true,
      isSameDocument: false
    })
    t.view.webContents.fire('did-start-navigation', {
      url: 'https://frame.test/',
      isMainFrame: false,
      isSameDocument: false
    })
    t.view.webContents.fire('did-start-navigation', {
      url: 'https://a.test/#hash',
      isMainFrame: true,
      isSameDocument: true
    })
    expect(sent(bw, 'browser-view:did-navigate')).toStrictEqual([
      { tabId: t.id, url: 'https://b.test/' }
    ])
  })

  it('CB-U25 did-navigate-in-page：主框架 → 全量；子框架不发', () => {
    const bw = openByUser()
    const t = tab('https://a.test/', { activate: true })
    t.view.webContents.canForward = true
    bw.webContents.send.mockClear()

    t.view.webContents.fire('did-navigate-in-page', {}, 'https://a.test/#two', true)
    t.view.webContents.fire('did-navigate-in-page', {}, 'https://frame.test/#x', false)
    expect(sent(bw, 'browser-view:did-navigate')).toEqual([
      {
        tabId: t.id,
        url: 'https://a.test/#two',
        canGoBack: false,
        canGoForward: true,
        zoomPercent: 100
      }
    ])
  })
})

describe('单页布局（CB-U27）', () => {
  it('CB-U27 表里只有 B：只有 B 挂在浏览器窗口上，其余在停放窗口铺 1280×800；空表全回停放；从不 setVisible(false)', () => {
    const bw = openByUser()
    views.setPanelVisible(true)
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    const c = tab('https://c.test/')
    views.activateTab(b.id)

    views.setLayout([{ tabId: b.id, bounds: BOUNDS }])
    const staging = fx.staging()!
    expect(bw.children).toEqual([b.view])
    expect(staging.children).toContain(a.view)
    expect(staging.children).toContain(c.view)
    expect(staging.children).not.toContain(b.view)
    expect(b.view.setBounds.mock.calls.at(-1)).toEqual([BOUNDS])
    expect(a.view.setBounds.mock.calls.at(-1)).toEqual([STAGING_BOUNDS])
    expect(c.view.setBounds.mock.calls.at(-1)).toEqual([STAGING_BOUNDS])

    views.setLayout([])
    expect(bw.children).toEqual([])
    for (const v of [a.view, b.view, c.view]) {
      expect(staging.children).toContain(v)
      expect(v.setBounds.mock.calls.at(-1)).toEqual([STAGING_BOUNDS])
    }
    expect(fx.hiddenViews()).toEqual([])
  })
})

describe('快捷键接线（CB-U28）', () => {
  it('CB-U28 每个 tab 的 webContents 与外壳各恰好一个 before-input-event；外壳再装一次还是一个', () => {
    const bw = openByUser()
    const a = tab('https://a.test/')
    const b = tab('https://b.test/')
    expect(a.view.webContents.handlers.get('before-input-event')).toHaveLength(1)
    expect(b.view.webContents.handlers.get('before-input-event')).toHaveLength(1)
    expect(shellKeyHandlers(bw)).toHaveLength(1)
    views.installShortcuts(bw.webContents as never)
    views.installShortcuts(bw.webContents as never)
    expect(shellKeyHandlers(bw)).toHaveLength(1)
  })

  it('CB-U28 F5 落在没选中的 tab 上：preventDefault 一次，刷新的是选中的那页', () => {
    openByUser()
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    const prevented = key(tabKeyHandler(b.view), { code: 'F5', key: 'F5' })
    expect(prevented).toHaveBeenCalledTimes(1)
    expect(a.view.webContents.reload).toHaveBeenCalledTimes(1)
    expect(b.view.webContents.reload).not.toHaveBeenCalled()
  })

  it('CB-U28 F5 落在外壳上：同样刷新选中的那页', () => {
    const bw = openByUser()
    tab('https://a.test/')
    const b = tab('https://b.test/', { activate: true })
    const [shell] = shellKeyHandlers(bw)
    expect(key(shell, { code: 'F5', key: 'F5' })).toHaveBeenCalledTimes(1)
    expect(b.view.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('CB-U28 ⌘A / Ctrl+A、keyUp 的 F5：不拦、不动作', () => {
    openByUser()
    const a = tab('https://a.test/', { activate: true })
    const h = tabKeyHandler(a.view)
    expect(key(h, { code: 'KeyA', key: 'a', meta: true })).not.toHaveBeenCalled()
    expect(key(h, { code: 'KeyA', key: 'a', control: true })).not.toHaveBeenCalled()
    expect(key(h, { type: 'keyUp', code: 'F5', key: 'F5' })).not.toHaveBeenCalled()
    expect(a.view.webContents.reload).not.toHaveBeenCalled()
  })
})

describe('新标签页 / 聚焦地址栏（CB-U29）', () => {
  const COMMAND = 'browser-view:command'

  it.each([['newTab'], ['focusOmnibox']] as const)(
    'CB-U29 %s：窗口在前台 → 外壳 webContents.focus 一次、发 focusOmnibox；什么窗口都没被弄到眼前',
    (type) => {
      const bw = openByUser()
      const a = tab('https://a.test/', { activate: true })
      fx.clearCalls()
      bw.webContents.send.mockClear()
      const viewsBefore = fx.views.length

      views.runShortcut({ type })
      if (type === 'newTab') {
        expect(fx.views).toHaveLength(viewsBefore + 1)
        const created = views.listTabs().at(-1)!
        expect(created.id).not.toBe(a.id)
        expect(selected()).toBe(created.id)
        expect(fx.views.at(-1)?.webContents.loaded).toEqual(['about:blank'])
      } else {
        expect(fx.views).toHaveLength(viewsBefore)
        expect(selected()).toBe(a.id)
      }
      expect(bw.webContents.focus).toHaveBeenCalledTimes(1)
      expect(sent(bw, COMMAND)).toEqual([{ command: 'focusOmnibox' }])
      expect(fx.allSurfacing()).toEqual([])
    }
  )

  it.each([
    ['hidden', (bw: FakeWindow) => bw.emit('close', { preventDefault: () => {} })],
    [
      'minimised',
      (bw: FakeWindow) => {
        bw.minimized = true
        bw.focused = false
      }
    ],
    [
      'unfocused',
      (bw: FakeWindow) => {
        bw.focused = false
      }
    ]
  ] as const)(
    'CB-U29 窗口 %s：newTab 照建照选中，但不 focus、不发 focusOmnibox；focusOmnibox 什么也不做',
    (_label, arrange) => {
      const bw = openByUser()
      tab('https://a.test/', { activate: true })
      arrange(bw)
      fx.clearCalls()
      bw.webContents.send.mockClear()

      views.runShortcut({ type: 'newTab' })
      const created = views.listTabs().at(-1)!
      expect(selected()).toBe(created.id)
      views.runShortcut({ type: 'focusOmnibox' })
      expect(bw.webContents.focus).not.toHaveBeenCalled()
      expect(sent(bw, COMMAND)).toEqual([])
      expect(fx.allSurfacing()).toEqual([])
    }
  )

  it('CB-U29 窗口从没建过：newTab 照建照选中，不建窗口、不 focus', () => {
    views.runShortcut({ type: 'newTab' })
    expect(views.listTabs()).toHaveLength(1)
    expect(views.listTabs()[0].active).toBe(true)
    views.runShortcut({ type: 'focusOmnibox' })
    expect(fx.browserWindows()).toEqual([])
    expect(fx.allSurfacing()).toEqual([])
  })

  it('CB-U29 开满 12 个：newTab 什么也不做（不抛、不建）', () => {
    const bw = openByUser()
    for (let i = 0; i < MAX_TABS; i++) tab(`https://t${i}.test/`)
    const before = views.listTabs()
    bw.webContents.send.mockClear()
    expect(() => views.runShortcut({ type: 'newTab' })).not.toThrow()
    expect(views.listTabs()).toEqual(before)
    expect(bw.webContents.focus).not.toHaveBeenCalled()
    expect(sent(bw, COMMAND)).toEqual([])
  })
})

describe('快捷键动作作用于选中的那页（CB-U30 / CB-U31）', () => {
  it('CB-U30 没有 tab：close / reload / back / forward / next / prev / selectTab / zoom 都什么也不做', () => {
    for (const action of [
      { type: 'closeTab' },
      { type: 'reload', ignoreCache: false },
      { type: 'reload', ignoreCache: true },
      { type: 'back' },
      { type: 'forward' },
      { type: 'nextTab' },
      { type: 'previousTab' },
      { type: 'selectTab', index: 0 },
      { type: 'selectTab', index: -1 },
      { type: 'zoom', direction: 'in' },
      { type: 'reopenClosedTab' }
    ] as const) {
      expect(() => views.runShortcut(action), action.type).not.toThrow()
    }
    expect(views.listTabs()).toEqual([])
  })

  it('CB-U30 closeTab 关选中的那页（记下地址，能重开）', () => {
    tab('https://a.test/')
    const b = tab('https://b.test/', { activate: true })
    views.runShortcut({ type: 'closeTab' })
    expect(views.listTabs().map((t) => t.id)).not.toContain(b.id)
    views.reopenClosedTab()
    expect(fx.views.at(-1)?.webContents.loaded).toEqual(['https://b.test/'])
  })

  it('CB-U30 reload / reload(ignoreCache) 只刷新选中的那页', () => {
    const a = tab('https://a.test/')
    const b = tab('https://b.test/', { activate: true })
    views.runShortcut({ type: 'reload', ignoreCache: false })
    views.runShortcut({ type: 'reload', ignoreCache: true })
    expect(b.view.webContents.reload).toHaveBeenCalledTimes(1)
    expect(b.view.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1)
    expect(a.view.webContents.reload).not.toHaveBeenCalled()
    expect(a.view.webContents.reloadIgnoringCache).not.toHaveBeenCalled()
  })

  it('CB-U30 back / forward：选中的那页能退才退、能进才进；别的 tab 不动', () => {
    const a = tab('https://a.test/')
    const b = tab('https://b.test/', { activate: true })
    a.view.webContents.canBack = true
    a.view.webContents.canForward = true
    const nav = b.view.webContents.navigationHistory

    views.runShortcut({ type: 'back' })
    views.runShortcut({ type: 'forward' })
    expect(nav.goBack).not.toHaveBeenCalled()
    expect(nav.goForward).not.toHaveBeenCalled()

    b.view.webContents.canBack = true
    b.view.webContents.canForward = true
    views.runShortcut({ type: 'back' })
    views.runShortcut({ type: 'forward' })
    expect(nav.goBack).toHaveBeenCalledTimes(1)
    expect(nav.goForward).toHaveBeenCalledTimes(1)
    expect(a.view.webContents.navigationHistory.goBack).not.toHaveBeenCalled()
    expect(a.view.webContents.navigationHistory.goForward).not.toHaveBeenCalled()
  })

  it('CB-U31 next / prev 绕回', () => {
    const a = tab('https://a.test/', { activate: true })
    const b = tab('https://b.test/')
    const c = tab('https://c.test/')
    views.runShortcut({ type: 'nextTab' })
    expect(selected()).toBe(b.id)
    views.runShortcut({ type: 'nextTab' })
    expect(selected()).toBe(c.id)
    views.runShortcut({ type: 'nextTab' })
    expect(selected()).toBe(a.id)
    views.runShortcut({ type: 'previousTab' })
    expect(selected()).toBe(c.id)
    views.runShortcut({ type: 'previousTab' })
    expect(selected()).toBe(b.id)
  })

  it('CB-U31 selectTab 0 / 2 / -1（最后一个）；越界什么也不做', () => {
    const bw = openByUser()
    const a = tab('https://a.test/')
    const b = tab('https://b.test/', { activate: true })
    const c = tab('https://c.test/')
    const d = tab('https://d.test/')
    expect(selected()).toBe(b.id)
    views.runShortcut({ type: 'selectTab', index: 0 })
    expect(selected()).toBe(a.id)
    views.runShortcut({ type: 'selectTab', index: 2 })
    expect(selected()).toBe(c.id)
    views.runShortcut({ type: 'selectTab', index: -1 })
    expect(selected()).toBe(d.id)

    bw.webContents.send.mockClear()
    views.runShortcut({ type: 'selectTab', index: 7 })
    expect(selected()).toBe(d.id)
    expect(sent(bw, 'browser-view:tab-activated')).toEqual([])
  })

  it('CB-U31 zoom 作用于选中那页的站点', () => {
    const a = tab('https://a.test/')
    const b = tab('https://b.test/', { activate: true })
    views.runShortcut({ type: 'zoom', direction: 'in' })
    expect(row(b.id)?.zoomPercent).toBe(110)
    expect(row(a.id)?.zoomPercent).toBe(100)
    views.runShortcut({ type: 'zoom', direction: 'out' })
    views.runShortcut({ type: 'zoom', direction: 'out' })
    expect(row(b.id)?.zoomPercent).toBe(90)
    views.runShortcut({ type: 'zoom', direction: 'reset' })
    expect(row(b.id)?.zoomPercent).toBe(100)
  })
})

describe('退出时全部收掉（CB-U32）', () => {
  it('CB-U32 destroyAllTabs 清掉重开记录与用户缩放', () => {
    const a = tab('https://z.test/', { activate: true })
    views.zoomTab(a.id, 'in')
    const same = tab('https://z.test/other')
    expect(row(same.id)?.zoomPercent).toBe(110)
    views.closeTab(a.id, { remember: true })

    views.destroyAllTabs()
    expect(views.listTabs()).toEqual([])
    expect(views.reopenClosedTab()).toBeNull()

    const again = tab('https://z.test/x')
    expect(row(again.id)?.zoomPercent).toBe(100)
  })
})
