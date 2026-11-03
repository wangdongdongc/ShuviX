/**
 * browserViewHandlers —— 浏览器搬进独立窗口之后，IPC 这一层多出来的两条规矩。
 *
 *   U6  布局表（set-layout）与墙级可见性门（set-visible）**只认宿主窗口**发来的：主窗口里残留的
 *       旧代码若还在发一张空表，会把浏览器窗口里的 view 全部藏掉。其余窗口发来的一律不理。
 *       另外两条新通道：open-window 打开 / 聚焦窗口；is-window-open 原样回答窗口服务的判断。
 *       create-tab（主窗 / 浏览器窗口里的「新建 tab」）只建一个激活的 tab，**不**打开浏览器窗口 ——
 *       窗口只由 open-window 打开（ST-U6）。
 *   BS-U45 set-popover（站点信息气泡、地址栏下拉那块透明 view）只认宿主窗口：矩形与 null 原样交给 setBrowserPopover；
 *       别的窗口、网络客户端发来的不理、不抛；宿主发来的不是矩形（'x' / 1 / false / {}）→ setBrowserPopover(null)
 *   BS-U46 宿主发的 set-layout / set-devtools-layout 带的 viewport 原样到服务（主进程按它算到窗口边缘的距离）
 *   NH-8 网络客户端（server mode phase B）发来的 set-layout / set-visible：不是宿主窗口 → 不理、不抛
 *   CB-U36 Chrome 化之后的几条通道：close-tab 是用户关的（记下地址给 ⌘⇧T）；reopen-closed-tab 原样回服务的值；
 *       zoom 只认 in / out / reset；open-session 只认窗口客户端发来的字符串；create-tab 不带地址时把光标
 *       放进地址栏（requestOmniboxFocus），带地址时不放
 *   BS-U19 open-settings（主设置窗口里的「打开浏览器设置」，哪个窗口发来都行）：先 openBrowserWindow 再
 *       openInternalPage('settings')；open-internal 只认窗口客户端、只认 INTERNAL_PAGES 里的页名（大小写不同、
 *       undefined、数字都不认），从不开窗口；
 *   BS-U20 proceed-unsafe 只认浏览器窗口外壳（宿主 7）：proceedPastCertError 恰好收到 tabId（多余参数丢掉）、
 *       原样回它的值；别的窗口（9）、网络客户端、非字符串 tabId → false、不调；
 *   BS-U21 navigate 交给 navigateTab（含 shuvix://），非字符串不理；capture 的 maxWidth 只认正数，其余给
 *       undefined；create-tab 带内部页面地址 → openInternalPage（不 createTab、不聚焦地址栏）、回它的 id；
 *       get-url 回 tabDisplayUrl。
 *   BVI-1 历史记录用的 transition：create-tab(url, 'typed' | 'generated') 把它放进 createTab 的选项；'link' /
 *       不认识的串 / 数字 → 选项里没有这个键；navigate 同理（navigateTab 的第三个参数，认不出时是 undefined）
 *   BVI-2 go-back / go-forward / reload 是用户的动作：先 historyNoteUser(tabId) 再导航，而且只在真的会发生时
 *       （canGoBack / canGoForward 假 → 不记、不导航；没有这个 tab → 什么也不做）
 *
 * 网络客户端（远程访问）能让浏览器去哪儿（2026-11-01，shared/browserRemoteUrls.ts —— `file:` 页加上截图就是一次绕过
 * files scope 的本地文件读取）。拒绝 = 处理函数同步抛、`.code === 'remote_url_refused'`；桌面窗口不限：
 *   BR-1  网络客户端 create-tab 带 file: / view-source:file: / data: / javascript: / 裸域名 / 数字 / 只有空白 /
 *         不认识的 shuvix:// → 抛，createTab / openInternalPage / requestOmniboxFocus 都不调
 *   BR-2  网络客户端 create-tab 带 https / about:blank（2b）→ createTab(url, {activate:false}) —— 开在后台，回它的 id，
 *         不聚焦地址栏；shuvix://history（2c）→ openInternalPage('history', {activate:false})；('https://…', 'typed')（2d）
 *         → {activate:false, transition:'typed'}
 *   BR-3  网络客户端 create-tab 不带地址 / undefined / null / '' → 不抛、createTab(…, {activate:false})，从不聚焦地址栏
 *   BR-4  窗口（宿主 7、主窗口 9）create-tab 带 file: / view-source:file: / data: → 照样交给 createTab；窗口 create-tab()
 *         → {activate:true} 且聚焦地址栏一次；窗口 'shuvix://settings' → openInternalPage 恰好一个参数（桌面不变）
 *   HI-1  host-info 回 { headless: isHeadless() }（true / false 两头，窗口与网络客户端一样）
 *   HI-2  经真的网络分发器：host-info → ok:true {headless:false}；判官拒绝 browser scope 的 admin 时照样 ok（它是 read，
 *         判官用 channelCallFactsOf 看访问级别）
 *   BR-5  网络客户端 navigate：file: / view-source: / data: / blob: / 不认识的 shuvix:// → 抛、navigateTab 不调；
 *         https / about:blank / shuvix://settings → navigateTab(T, url, transition)；非字符串 → 不抛、不调
 *   BR-6  窗口 navigate 去 file: → navigateTab 照调
 *   BR-7  网络客户端 go-back：核对 active-1 那一条，放行 → 先 historyNoteUser(T) 再 goToIndex(那一条)，不调
 *         goBack；那一条是 file: → 抛，不记、不导航
 *   BR-8  网络客户端 go-forward：核对 active+1 那一条（再往后的 file: 不管）；那一条是 file: → 抛
 *   BR-9  canGoBack / canGoForward 真但那一条取不到（null / undefined）→ 抛、不导航；不能退 / 进、没有这个 tab →
 *         不抛、什么也不做
 *   BR-10 窗口 go-back / go-forward 去 file: → goBack() / goForward()，从不读那一条
 *   BR-11 网络客户端 reopen-closed-tab：要重开的是 file: → 抛、reopenClosedTab 不调（记录留着，之后窗口照样能重开）；
 *         https / shuvix://settings → 调、回它的值；没有记录 → 调、回 null
 *   BR-12 窗口 reopen-closed-tab，要重开的是 file: → 照调、回它的值
 *   BR-13 网络客户端 capture：tab 正显示 https / about:blank / shuvix://settings → captureTab(T, 1600) 回它的值；
 *         maxWidth '800' → undefined；正显示 file: / view-source:file: / data: → 抛、captureTab 不调
 *   BR-14 网络客户端 capture：显示地址是空串（没有这个 tab）→ ''、不抛、不抓；tabId 不是字符串 → ''、
 *         tabDisplayUrl 与 captureTab 都不调
 *   BR-15 经真的网络分发器（createNetworkDispatcher）：create-tab file: → `ok:false`、code remote_url_refused、
 *         消息里没有路径；create-tab https → `ok:true`、'tab-new'；capture 一个正显示 file: 的 tab → 同一个 code
 *
 * electron 是替身（on / handle 收进 Map）；services/browser 整个换成间谍 —— 宿主判断固定为
 * 「webContents id 7 是宿主」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  on: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  setLayout: vi.fn<(entries: unknown) => void>(),
  setPanelVisible: vi.fn<(visible: boolean) => void>(),
  setBrowserPopover: vi.fn<(placement: unknown) => void>(),
  setDevtoolsLayout: vi.fn<(slot: unknown) => void>(),
  openBrowserWindow: vi.fn<() => void>(),
  createTab: vi.fn<(url?: string, opts?: { activate?: boolean }) => string>(() => 'tab-new'),
  isBrowserWindowOpen: vi.fn<() => boolean>(() => false),
  closeTab: vi.fn<(tabId: string, opts?: { remember?: boolean }) => void>(),
  reopenClosedTab: vi.fn<() => string | null>(() => null),
  peekClosedTabUrl: vi.fn<() => string | undefined>(() => undefined),
  zoomTab: vi.fn<(tabId: string, direction: string) => void>(),
  openAgentSession: vi.fn<(sessionId: string) => boolean>(() => false),
  requestOmniboxFocus: vi.fn<() => void>(),
  openInternalPage: vi.fn<(...args: unknown[]) => string>(() => 'tab-settings'),
  /** isHeadless() 的回答 */
  headless: false,
  navigateTab: vi.fn<(tabId: string, url: string, transition?: string) => void>(),
  historyNoteUser: vi.fn<(tabId: string) => void>(),
  /** getTabView 回的假 view（null = 没有这个 tab） */
  tabView: null as unknown,
  proceedPastCertError: vi.fn<(...args: unknown[]) => boolean>(() => true),
  tabDisplayUrl: vi.fn<(tabId: string) => string>(() => 'shuvix://settings'),
  captureTab: vi.fn<(tabId: string, maxWidth?: number) => Promise<string>>(async () => 'data:x')
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: Handler) => void state.on.set(channel, handler),
    handle: (channel: string, handler: Handler) => void state.handle.set(channel, handler)
  }
}))
// mock 路径按**测试文件**解析：被测模块 import 的 '../services/browser' 在这里是 '../../services/browser'
vi.mock('../../services/browser', () => ({
  createTab: (url?: string, opts?: { activate?: boolean }) => state.createTab(url, opts),
  closeTab: (tabId: string, opts?: { remember?: boolean }) => state.closeTab(tabId, opts),
  activateTab: vi.fn(),
  listTabs: vi.fn(() => []),
  getTabView: () => state.tabView,
  captureTab: (tabId: string, maxWidth?: number) => state.captureTab(tabId, maxWidth),
  setLayout: (entries: unknown) => state.setLayout(entries),
  setPanelVisible: (visible: boolean) => state.setPanelVisible(visible),
  setBrowserPopover: (placement: unknown) => state.setBrowserPopover(placement),
  setDevtoolsLayout: (slot: unknown) => state.setDevtoolsLayout(slot),
  isHostWebContents: (id: number) => id === 7,
  openBrowserWindow: () => state.openBrowserWindow(),
  isBrowserWindowOpen: () => state.isBrowserWindowOpen(),
  requestOmniboxFocus: () => state.requestOmniboxFocus(),
  reopenClosedTab: () => state.reopenClosedTab(),
  peekClosedTabUrl: () => state.peekClosedTabUrl(),
  zoomTab: (tabId: string, direction: string) => state.zoomTab(tabId, direction),
  openAgentSession: (sessionId: string) => state.openAgentSession(sessionId),
  // 原样转交全部实参：网络客户端那条路多给一个 {activate:false}，桌面那条路恰好一个参数
  openInternalPage: (...args: unknown[]) => state.openInternalPage(...args),
  navigateTab: (tabId: string, url: string, transition?: string) =>
    state.navigateTab(tabId, url, transition),
  historyNoteUser: (tabId: string) => state.historyNoteUser(tabId),
  // 原样转交全部实参：「多余参数丢掉」要在 handler 那一侧看得见
  proceedPastCertError: (...args: unknown[]) => state.proceedPastCertError(...args),
  tabDisplayUrl: (tabId: string) => state.tabDisplayUrl(tabId)
}))

vi.mock('../../utils/headless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/headless')>()),
  isHeadless: () => state.headless
}))

import { registerBrowserViewHandlers } from '../browserViewHandlers'
import { attachIpcAdapter } from '../ipcAdapter'
import { listDefinitions } from '../registry'
import { netCtx } from '../../frontend/network/__tests__/support/fakeNetworkConnection'
import { createNetworkDispatcher } from '../../frontend/network/dispatch'
import { channelCallFactsOf } from '../../../shared/channelAccess'

registerBrowserViewHandlers()
// 注册表经 IPC 适配器挂到（替身）ipcMain 上：handlers 里收的是适配器包过的处理函数
attachIpcAdapter()

const HOST = 7
const OTHER = 9

/** 像渲染端 send 那样投递一条 ipcMain.on 消息（sender 的 webContents id 由参数给） */
const send = (channel: string, senderId: number, ...args: unknown[]): unknown => {
  const handler = state.on.get(channel)
  if (!handler) throw new Error(`no ipcMain.on handler for ${channel}`)
  return handler({ sender: { id: senderId } }, ...args)
}

/** 像渲染端 invoke 那样调一个已注册的 handle */
const invoke = (channel: string, senderId: number, ...args: unknown[]): unknown => {
  const handler = state.handle.get(channel)
  if (!handler) throw new Error(`no ipcMain.handle handler for ${channel}`)
  return handler({ sender: { id: senderId } }, ...args)
}

const ENTRIES = [
  { tabId: 'tab-a', bounds: { x: 4, y: 40, width: 580, height: 372 }, zoom: 0.53 },
  { tabId: 'tab-b', bounds: { x: 592, y: 40, width: 580, height: 372 }, zoom: 0.53 }
]

beforeEach(() => {
  state.setLayout.mockClear()
  state.setPanelVisible.mockClear()
  state.setBrowserPopover.mockClear()
  state.setDevtoolsLayout.mockClear()
  state.openBrowserWindow.mockClear()
  state.createTab.mockClear()
  state.isBrowserWindowOpen.mockReset()
  state.closeTab.mockClear()
  state.reopenClosedTab.mockReset()
  state.reopenClosedTab.mockReturnValue(null)
  state.zoomTab.mockClear()
  state.openAgentSession.mockReset()
  state.openAgentSession.mockReturnValue(false)
  state.requestOmniboxFocus.mockClear()
  state.openInternalPage.mockClear()
  state.navigateTab.mockClear()
  state.historyNoteUser.mockClear()
  state.tabView = null
  state.proceedPastCertError.mockReset()
  state.proceedPastCertError.mockReturnValue(true)
  // 各用例会 mockReturnValue：每条都回到缺省值，免得漏到下一条
  state.tabDisplayUrl.mockReset()
  state.tabDisplayUrl.mockReturnValue('shuvix://settings')
  state.peekClosedTabUrl.mockReset()
  state.peekClosedTabUrl.mockReturnValue(undefined)
  state.captureTab.mockClear()
  state.headless = false
})

describe('browserViewHandlers：布局只认宿主窗口', () => {
  it('U6 set-layout：别的窗口（9）发来的空表不理；宿主窗口（7）发来的原样交给 setLayout', () => {
    send('browser-view:set-layout', OTHER, [])
    send('browser-view:set-layout', OTHER, ENTRIES)
    expect(state.setLayout).not.toHaveBeenCalled()

    send('browser-view:set-layout', HOST, ENTRIES)
    expect(state.setLayout).toHaveBeenCalledTimes(1)
    expect(state.setLayout).toHaveBeenCalledWith(ENTRIES)

    // 宿主发的空表也是一张合法的表（墙空了）
    send('browser-view:set-layout', HOST, [])
    expect(state.setLayout).toHaveBeenCalledTimes(2)
    expect(state.setLayout).toHaveBeenLastCalledWith([])
  })

  it('U6 set-visible：别的窗口（9）发来的 false 不理；宿主窗口（7）的 false / true 都照办', () => {
    send('browser-view:set-visible', OTHER, false)
    send('browser-view:set-visible', OTHER, true)
    expect(state.setPanelVisible).not.toHaveBeenCalled()

    send('browser-view:set-visible', HOST, false)
    expect(state.setPanelVisible).toHaveBeenCalledTimes(1)
    expect(state.setPanelVisible).toHaveBeenLastCalledWith(false)
    send('browser-view:set-visible', HOST, true)
    expect(state.setPanelVisible).toHaveBeenCalledTimes(2)
    expect(state.setPanelVisible).toHaveBeenLastCalledWith(true)
  })
})

describe('弹层的透明 view 与贴边的布局（BS-U45 / BS-U46）', () => {
  const PLACEMENT = { bounds: { x: 80, y: 42, width: 360, height: 244 }, focus: 'take' }
  const fromNet = (channel: string, ...args: unknown[]): unknown => {
    const definition = listDefinitions().find((d) => d.channel === channel)
    if (!definition) throw new Error(`no definition for ${channel}`)
    return definition.fn(netCtx(1), ...args)
  }

  it('BS-U45 宿主窗口：矩形原样交给 setBrowserPopover；null 就是关', () => {
    send('browser-view:set-popover', HOST, PLACEMENT)
    expect(state.setBrowserPopover.mock.calls).toEqual([[PLACEMENT]])
    expect(state.setBrowserPopover.mock.calls[0][0]).toBe(PLACEMENT)
    send('browser-view:set-popover', HOST, null)
    expect(state.setBrowserPopover).toHaveBeenCalledTimes(2)
    expect(state.setBrowserPopover).toHaveBeenLastCalledWith(null)
  })

  it('BS-U45 别的窗口（9）与网络客户端：不理、不抛', () => {
    expect(() => send('browser-view:set-popover', OTHER, PLACEMENT)).not.toThrow()
    expect(() => send('browser-view:set-popover', OTHER, null)).not.toThrow()
    expect(() => fromNet('browser-view:set-popover', PLACEMENT)).not.toThrow()
    expect(state.setBrowserPopover).not.toHaveBeenCalled()
  })

  it.each([['x'], [1], [false], [{}]])(
    'BS-U45 宿主窗口发来的不是矩形（%j）：setBrowserPopover(null)',
    (junk) => {
      expect(() => send('browser-view:set-popover', HOST, junk)).not.toThrow()
      expect(state.setBrowserPopover.mock.calls).toEqual([[null]])
    }
  )

  it('BS-U46 set-layout / set-devtools-layout 带的 viewport 原样到服务', () => {
    const viewport = { width: 1024, height: 768 }
    const entries = [
      { tabId: 'tab-a', bounds: { x: 0, y: 76, width: 1024, height: 692 }, viewport }
    ]
    send('browser-view:set-layout', HOST, entries)
    expect(state.setLayout.mock.calls).toEqual([[entries]])

    const slot = { tabId: 'tab-a', bounds: { x: 0, y: 500, width: 1024, height: 268 }, viewport }
    send('browser-view:set-devtools-layout', HOST, slot)
    expect(state.setDevtoolsLayout.mock.calls).toEqual([[slot]])
  })
})

describe('browserViewHandlers：窗口通道', () => {
  it('U6 is-window-open 原样回答 isBrowserWindowOpen（true 与 false 两头都看）', async () => {
    state.isBrowserWindowOpen.mockReturnValue(true)
    expect(await invoke('browser-view:is-window-open', OTHER)).toBe(true)
    state.isBrowserWindowOpen.mockReturnValue(false)
    expect(await invoke('browser-view:is-window-open', OTHER)).toBe(false)
    expect(state.isBrowserWindowOpen).toHaveBeenCalledTimes(2)
    expect(state.openBrowserWindow).not.toHaveBeenCalled()
  })

  it('U6 open-window 调 openBrowserWindow（从主窗口发来也照办 —— 那正是顶栏按钮）', async () => {
    await invoke('browser-view:open-window', OTHER)
    expect(state.openBrowserWindow).toHaveBeenCalledTimes(1)
    expect(state.setLayout).not.toHaveBeenCalled()
    expect(state.setPanelVisible).not.toHaveBeenCalled()
  })
})

describe('browserViewHandlers：create-tab 不开窗口', () => {
  it('ST-U6 create-tab 调 createTab(url, { activate: true }) 并回它的 tab id；从不调 openBrowserWindow（带 url 与不带 url 都一样）', async () => {
    expect(await invoke('browser-view:create-tab', OTHER, 'https://a.example/')).toBe('tab-new')
    expect(state.createTab).toHaveBeenCalledTimes(1)
    expect(state.createTab).toHaveBeenLastCalledWith('https://a.example/', { activate: true })

    await invoke('browser-view:create-tab', HOST)
    expect(state.createTab).toHaveBeenCalledTimes(2)
    expect(state.createTab).toHaveBeenLastCalledWith(undefined, { activate: true })

    expect(state.openBrowserWindow).not.toHaveBeenCalled()
  })
})

describe('NH-8 网络客户端发来的布局 / 可见性', () => {
  const fromNet = (channel: string, ...args: unknown[]): unknown => {
    const definition = listDefinitions().find((d) => d.channel === channel)
    if (!definition) throw new Error(`no definition for ${channel}`)
    return definition.fn(netCtx(1), ...args)
  }

  it('NH-8 set-layout / set-visible 从网络来 → 不理、不抛', () => {
    expect(() => fromNet('browser-view:set-layout', ENTRIES)).not.toThrow()
    expect(() => fromNet('browser-view:set-visible', false)).not.toThrow()
    expect(state.setLayout).not.toHaveBeenCalled()
    expect(state.setPanelVisible).not.toHaveBeenCalled()
  })
})

describe('Chrome 化的通道（CB-U36）', () => {
  const fromNet = (channel: string, ...args: unknown[]): unknown => {
    const definition = listDefinitions().find((d) => d.channel === channel)
    if (!definition) throw new Error(`no definition for ${channel}`)
    return definition.fn(netCtx(1), ...args)
  }

  it('CB-U36 close-tab → closeTab(id, { remember: true })（用户关的，⌘⇧T 能重开）', async () => {
    await invoke('browser-view:close-tab', HOST, 'T')
    expect(state.closeTab.mock.calls).toEqual([['T', { remember: true }]])
  })

  it('CB-U36 reopen-closed-tab 原样回服务的值（新 tab id 或 null）', async () => {
    expect(await invoke('browser-view:reopen-closed-tab', HOST)).toBeNull()
    state.reopenClosedTab.mockReturnValue('tab-reopened')
    expect(await invoke('browser-view:reopen-closed-tab', HOST)).toBe('tab-reopened')
    expect(state.reopenClosedTab).toHaveBeenCalledTimes(2)
  })

  it('CB-U36 zoom：in / out / reset 交给 zoomTab；别的方向不调', async () => {
    await invoke('browser-view:zoom', HOST, 'T', 'in')
    await invoke('browser-view:zoom', HOST, 'T', 'out')
    await invoke('browser-view:zoom', HOST, 'T', 'reset')
    expect(state.zoomTab.mock.calls).toEqual([
      ['T', 'in'],
      ['T', 'out'],
      ['T', 'reset']
    ])
    state.zoomTab.mockClear()
    await invoke('browser-view:zoom', HOST, 'T', 'sideways')
    await invoke('browser-view:zoom', HOST, 'T', undefined)
    await invoke('browser-view:zoom', HOST, 'T', 'IN')
    expect(state.zoomTab).not.toHaveBeenCalled()
  })

  it('CB-U36 open-session：窗口客户端发来的字符串 → openAgentSession；网络客户端、非字符串 → 不调', async () => {
    await invoke('browser-view:open-session', HOST, 's1')
    expect(state.openAgentSession.mock.calls).toEqual([['s1']])
    state.openAgentSession.mockClear()

    await invoke('browser-view:open-session', HOST, 42)
    await invoke('browser-view:open-session', HOST, undefined)
    await invoke('browser-view:open-session', HOST, { id: 's1' })
    await fromNet('browser-view:open-session', 's1')
    expect(state.openAgentSession).not.toHaveBeenCalled()
  })

  it('CB-U36 create-tab：不带地址 → requestOmniboxFocus 一次；带地址 → 不调', async () => {
    await invoke('browser-view:create-tab', HOST)
    expect(state.requestOmniboxFocus).toHaveBeenCalledTimes(1)
    state.requestOmniboxFocus.mockClear()
    await invoke('browser-view:create-tab', HOST, 'https://a.example/')
    expect(state.requestOmniboxFocus).not.toHaveBeenCalled()
  })
})

describe('内部页面与证书警告的通道（BS-U19 / BS-U20 / BS-U21）', () => {
  const fromNet = (channel: string, ...args: unknown[]): unknown => {
    const definition = listDefinitions().find((d) => d.channel === channel)
    if (!definition) throw new Error(`no definition for ${channel}`)
    return definition.fn(netCtx(1), ...args)
  }

  it.each([
    ['宿主窗口 7', HOST],
    ['主窗口 9', OTHER]
  ])(
    "BS-U19 open-settings（%s）：先 openBrowserWindow、再 openInternalPage('settings')",
    async (_l, sender) => {
      await invoke('browser-view:open-settings', sender)
      expect(state.openBrowserWindow).toHaveBeenCalledTimes(1)
      expect(state.openInternalPage.mock.calls).toEqual([['settings']])
      expect(state.openBrowserWindow.mock.invocationCallOrder[0]).toBeLessThan(
        state.openInternalPage.mock.invocationCallOrder[0]
      )
      expect(state.createTab).not.toHaveBeenCalled()
    }
  )

  it("BS-U19 open-internal('settings') 从窗口来：openInternalPage 一次，从不开窗口", async () => {
    await invoke('browser-view:open-internal', HOST, 'settings')
    expect(state.openInternalPage.mock.calls).toEqual([['settings']])
    await invoke('browser-view:open-internal', OTHER, 'settings')
    expect(state.openInternalPage).toHaveBeenCalledTimes(2)
    expect(state.openBrowserWindow).not.toHaveBeenCalled()
    expect(state.createTab).not.toHaveBeenCalled()
  })

  it('BS-U19 open-internal：网络客户端发来的不理', async () => {
    await fromNet('browser-view:open-internal', 'settings')
    expect(state.openInternalPage).not.toHaveBeenCalled()
    expect(state.openBrowserWindow).not.toHaveBeenCalled()
  })

  it.each([['unknown'], ['Settings'], [undefined], [42], [{ page: 'settings' }]])(
    'BS-U19 open-internal(%j)：不认识的页名不调',
    async (page) => {
      await invoke('browser-view:open-internal', HOST, page)
      expect(state.openInternalPage).not.toHaveBeenCalled()
      expect(state.openBrowserWindow).not.toHaveBeenCalled()
    }
  )

  it('BS-U20 proceed-unsafe 从宿主窗口 7：proceedPastCertError 恰好收到 [tabId]（多余参数丢掉），回它的值', async () => {
    expect(await invoke('browser-view:proceed-unsafe', HOST, 'T', 'extra', 42)).toBe(true)
    expect(state.proceedPastCertError.mock.calls).toEqual([['T']])
    state.proceedPastCertError.mockReturnValue(false)
    expect(await invoke('browser-view:proceed-unsafe', HOST, 'U')).toBe(false)
    expect(state.proceedPastCertError.mock.calls).toEqual([['T'], ['U']])
  })

  it('BS-U20 proceed-unsafe 从别的窗口（9）或网络客户端：回 false、不调', async () => {
    expect(await invoke('browser-view:proceed-unsafe', OTHER, 'T')).toBe(false)
    expect(await fromNet('browser-view:proceed-unsafe', 'T')).toBe(false)
    expect(state.proceedPastCertError).not.toHaveBeenCalled()
  })

  it.each([[42], [undefined], [null], [{ tabId: 'T' }], [['T']]])(
    'BS-U20 proceed-unsafe(%j) 从宿主窗口：tabId 不是字符串 → false、不调',
    async (tabId) => {
      expect(await invoke('browser-view:proceed-unsafe', HOST, tabId)).toBe(false)
      expect(state.proceedPastCertError).not.toHaveBeenCalled()
    }
  )

  it('BS-U21 navigate(T, url) → navigateTab(T, url)，shuvix:// 也一样；非字符串不理', async () => {
    await invoke('browser-view:navigate', HOST, 'T', 'https://a.example/')
    await invoke('browser-view:navigate', OTHER, 'T', 'shuvix://settings')
    expect(state.navigateTab.mock.calls).toEqual([
      ['T', 'https://a.example/', undefined],
      ['T', 'shuvix://settings', undefined]
    ])
    state.navigateTab.mockClear()
    await invoke('browser-view:navigate', HOST, 42, 'https://a.example/')
    await invoke('browser-view:navigate', HOST, 'T', 42)
    await invoke('browser-view:navigate', HOST, 'T')
    await invoke('browser-view:navigate', HOST, undefined, undefined)
    expect(state.navigateTab).not.toHaveBeenCalled()
  })

  it('BS-U21 capture(T, 1600) → captureTab(T, 1600)，回它的值', async () => {
    expect(await invoke('browser-view:capture', HOST, 'T', 1600)).toBe('data:x')
    expect(state.captureTab.mock.calls).toEqual([['T', 1600]])
  })

  it.each([
    ['不给', []],
    ['0', [0]],
    ['-1', [-1]],
    ["'800'", ['800']],
    ['NaN', [Number.NaN]]
  ] as const)('BS-U21 capture(T, %s) → captureTab(T, undefined)', async (_l, extra) => {
    await invoke('browser-view:capture', HOST, 'T', ...extra)
    expect(state.captureTab.mock.calls).toEqual([['T', undefined]])
  })

  it("BS-U21 create-tab('shuvix://settings') → openInternalPage('settings')、回它的 id；不 createTab、不聚焦地址栏", async () => {
    expect(await invoke('browser-view:create-tab', HOST, 'shuvix://settings')).toBe('tab-settings')
    expect(state.openInternalPage.mock.calls).toEqual([['settings']])
    expect(state.createTab).not.toHaveBeenCalled()
    expect(state.requestOmniboxFocus).not.toHaveBeenCalled()
  })

  it('BS-U21 create-tab 不认识的 shuvix:// 当普通地址交给 createTab', async () => {
    await invoke('browser-view:create-tab', HOST, 'shuvix://unknown')
    expect(state.openInternalPage).not.toHaveBeenCalled()
    expect(state.createTab.mock.calls).toEqual([['shuvix://unknown', { activate: true }]])
  })

  it('BS-U21 get-url → tabDisplayUrl(T) 的值', async () => {
    expect(await invoke('browser-view:get-url', HOST, 'T')).toBe('shuvix://settings')
    expect(state.tabDisplayUrl.mock.calls).toEqual([['T']])
  })
})

describe('历史记录用的 transition（BVI-1）', () => {
  it.each(['typed', 'generated'] as const)(
    "BVI-1 create-tab(url, '%s') → createTab(url, { activate: true, transition })",
    async (transition) => {
      await invoke('browser-view:create-tab', HOST, 'https://a.example/', transition)
      expect(state.createTab.mock.calls).toEqual([
        ['https://a.example/', { activate: true, transition }]
      ])
    }
  )

  it.each([['link'], ['bogus'], [1], [undefined], [{ transition: 'typed' }]])(
    'BVI-1 create-tab(url, %j) → 选项里没有 transition',
    async (transition) => {
      await invoke('browser-view:create-tab', HOST, 'https://a.example/', transition)
      expect(state.createTab.mock.calls).toEqual([['https://a.example/', { activate: true }]])
      expect(state.createTab.mock.calls[0][1]).not.toHaveProperty('transition')
    }
  )

  it("BVI-1 navigate(T, url, 'typed' | 'generated') → navigateTab 的第三个参数", async () => {
    await invoke('browser-view:navigate', HOST, 'T', 'https://a.example/', 'typed')
    await invoke(
      'browser-view:navigate',
      HOST,
      'T',
      'https://www.google.com/search?q=x',
      'generated'
    )
    expect(state.navigateTab.mock.calls).toEqual([
      ['T', 'https://a.example/', 'typed'],
      ['T', 'https://www.google.com/search?q=x', 'generated']
    ])
  })

  it.each([['link'], ['bogus'], [1], [null]])(
    'BVI-1 navigate(T, url, %j) → 第三个参数 undefined',
    async (transition) => {
      await invoke('browser-view:navigate', HOST, 'T', 'https://a.example/', transition)
      expect(state.navigateTab.mock.calls).toEqual([['T', 'https://a.example/', undefined]])
    }
  )
})

describe('后退 / 前进 / 刷新记在用户头上（BVI-2）', () => {
  type Spy = ReturnType<typeof vi.fn>
  /** 一个可拨的假 view：能否后退 / 前进；三个导航动作是间谍（调用顺序与 historyNoteUser 比） */
  function fakeView(
    canBack: boolean,
    canForward: boolean
  ): { goBack: Spy; goForward: Spy; reload: Spy } {
    const spies = { goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn() }
    state.tabView = {
      webContents: {
        navigationHistory: {
          canGoBack: () => canBack,
          canGoForward: () => canForward,
          goBack: spies.goBack,
          goForward: spies.goForward
        },
        reload: spies.reload
      }
    }
    return spies
  }
  /** historyNoteUser 在这个导航动作之前被调 */
  const notedBefore = (nav: Spy): void => {
    expect(state.historyNoteUser.mock.invocationCallOrder[0]).toBeLessThan(
      nav.mock.invocationCallOrder[0]
    )
  }

  it('BVI-2 go-back（能退）：先 historyNoteUser(T)，再 goBack', async () => {
    const view = fakeView(true, false)
    await invoke('browser-view:go-back', HOST, 'T')
    expect(state.historyNoteUser.mock.calls).toEqual([['T']])
    expect(view.goBack).toHaveBeenCalledTimes(1)
    notedBefore(view.goBack)
  })

  it('BVI-2 go-forward（能进）：先 historyNoteUser(T)，再 goForward', async () => {
    const view = fakeView(false, true)
    await invoke('browser-view:go-forward', HOST, 'T')
    expect(state.historyNoteUser.mock.calls).toEqual([['T']])
    expect(view.goForward).toHaveBeenCalledTimes(1)
    notedBefore(view.goForward)
  })

  it('BVI-2 reload：先 historyNoteUser(T)，再 reload', async () => {
    const view = fakeView(false, false)
    await invoke('browser-view:reload', HOST, 'T')
    expect(state.historyNoteUser.mock.calls).toEqual([['T']])
    expect(view.reload).toHaveBeenCalledTimes(1)
    notedBefore(view.reload)
  })

  it('BVI-2 不能退 / 不能进：不记、不导航', async () => {
    const view = fakeView(false, false)
    await invoke('browser-view:go-back', HOST, 'T')
    await invoke('browser-view:go-forward', HOST, 'T')
    expect(state.historyNoteUser).not.toHaveBeenCalled()
    expect(view.goBack).not.toHaveBeenCalled()
    expect(view.goForward).not.toHaveBeenCalled()
  })

  it('BVI-2 没有这个 tab：三个都什么也不做', async () => {
    state.tabView = null
    await invoke('browser-view:go-back', HOST, 'T')
    await invoke('browser-view:go-forward', HOST, 'T')
    await invoke('browser-view:reload', HOST, 'T')
    expect(state.historyNoteUser).not.toHaveBeenCalled()
  })
})

describe('网络客户端能让浏览器去哪儿（BR-1 … BR-15）', () => {
  type Spy = ReturnType<typeof vi.fn>
  const REFUSED = 'remote_url_refused'

  const fromNet = (channel: string, ...args: unknown[]): unknown => {
    const definition = listDefinitions().find((d) => d.channel === channel)
    if (!definition) throw new Error(`no definition for ${channel}`)
    return definition.fn(netCtx(1), ...args)
  }

  /** 网络客户端的这次调用**同步**抛了拒绝：回那个错误（没抛 / 抛的不是它 → 用例红） */
  const refusedFromNet = (channel: string, ...args: unknown[]): Error & { code?: string } => {
    let caught: unknown
    try {
      fromNet(channel, ...args)
    } catch (error) {
      caught = error
    }
    expect(caught, `${channel}(${JSON.stringify(args)}) should be refused`).toBeInstanceOf(Error)
    const error = caught as Error & { code?: string }
    expect(error.code).toBe(REFUSED)
    return error
  }

  /**
   * 一个带完整导航历史的假 view：`entries` 是各条的地址，`active` 是当前那一条。网络客户端那条路读
   * getActiveIndex / getEntryAtIndex 再 goToIndex；窗口那条路只调 goBack / goForward
   */
  function historyView(
    entries: string[],
    active: number,
    over: { entryAt?: (index: number) => unknown } = {}
  ): { goBack: Spy; goForward: Spy; goToIndex: Spy; getEntryAtIndex: Spy; getActiveIndex: Spy } {
    const spies = {
      goBack: vi.fn(),
      goForward: vi.fn(),
      goToIndex: vi.fn(),
      getEntryAtIndex: vi.fn(
        over.entryAt ??
          ((index: number) =>
            index >= 0 && index < entries.length ? { url: entries[index], title: '' } : null)
      ),
      getActiveIndex: vi.fn(() => active)
    }
    state.tabView = {
      webContents: {
        navigationHistory: {
          canGoBack: () => active > 0,
          canGoForward: () => active < entries.length - 1,
          ...spies
        }
      }
    }
    return spies
  }

  const FILE = 'file:///Users/me/secret.txt'
  const HTTPS = 'https://a.example/'

  describe('create-tab', () => {
    it.each<[string, unknown]>([
      ['file:', FILE],
      ['view-source:file:', 'view-source:file:///x'],
      ['data:', 'data:text/html,x'],
      ['javascript:', 'javascript:1'],
      ['裸域名', 'a.example'],
      ['数字', 42],
      ['只有空白', '   '],
      ['不认识的 shuvix://', 'shuvix://unknown']
    ])('BR-1 网络客户端 create-tab(%s) → 抛 remote_url_refused，什么也不建', (_l, url) => {
      refusedFromNet('browser-view:create-tab', url)
      expect(state.createTab).not.toHaveBeenCalled()
      expect(state.openInternalPage).not.toHaveBeenCalled()
      expect(state.requestOmniboxFocus).not.toHaveBeenCalled()
    })

    it('BR-1 拒绝的消息只说协议，不复述地址', () => {
      const error = refusedFromNet('browser-view:create-tab', FILE)
      expect(error.message).toContain('file:')
      expect(error.message).not.toContain('/Users/me')
      expect(error.message).not.toContain('secret')
    })

    it('BR-2 网络客户端 create-tab(https) → createTab(url, {activate:false})（开在后台），回它的 id；不聚焦地址栏', () => {
      expect(fromNet('browser-view:create-tab', HTTPS)).toBe('tab-new')
      expect(state.createTab.mock.calls).toEqual([[HTTPS, { activate: false }]])
      expect(state.requestOmniboxFocus).not.toHaveBeenCalled()
    })

    it('BR-2b 网络客户端 create-tab(about:blank) → createTab(…, {activate:false})；不聚焦地址栏', () => {
      expect(fromNet('browser-view:create-tab', 'about:blank')).toBe('tab-new')
      expect(state.createTab.mock.calls).toEqual([['about:blank', { activate: false }]])
      expect(state.requestOmniboxFocus).not.toHaveBeenCalled()
    })

    it("BR-2c 网络客户端 create-tab(shuvix://history) → openInternalPage('history', {activate:false})，不 createTab", () => {
      expect(fromNet('browser-view:create-tab', 'shuvix://history')).toBe('tab-settings')
      expect(state.openInternalPage.mock.calls).toEqual([['history', { activate: false }]])
      expect(state.createTab).not.toHaveBeenCalled()
      expect(state.requestOmniboxFocus).not.toHaveBeenCalled()
    })

    it("BR-2d 网络客户端 create-tab(https, 'typed') → {activate:false, transition:'typed'}", () => {
      fromNet('browser-view:create-tab', HTTPS, 'typed')
      expect(state.createTab.mock.calls).toEqual([
        [HTTPS, { activate: false, transition: 'typed' }]
      ])
    })

    it('BR-3 网络客户端 create-tab 不带地址 / undefined / null / 空串 → 不抛、建空白页（各 {activate:false}）、从不聚焦地址栏', () => {
      const calls: unknown[][] = [[], [undefined], [null], ['']]
      for (const args of calls) {
        expect(
          () => fromNet('browser-view:create-tab', ...args),
          JSON.stringify(args)
        ).not.toThrow()
      }
      expect(state.createTab).toHaveBeenCalledTimes(4)
      expect(state.createTab.mock.calls).toEqual([
        [undefined, { activate: false }],
        [undefined, { activate: false }],
        [null, { activate: false }],
        ['', { activate: false }]
      ])
      expect(state.requestOmniboxFocus).not.toHaveBeenCalled()
    })

    it('BR-4 窗口 create-tab() → createTab(undefined, {activate:true})，聚焦地址栏一次（桌面不变）', async () => {
      await invoke('browser-view:create-tab', HOST)
      expect(state.createTab.mock.calls).toEqual([[undefined, { activate: true }]])
      expect(state.requestOmniboxFocus).toHaveBeenCalledTimes(1)
    })

    it("BR-4 窗口 create-tab('shuvix://settings') → openInternalPage 恰好收到一个参数（'settings'）", async () => {
      await invoke('browser-view:create-tab', OTHER, 'shuvix://settings')
      expect(state.openInternalPage).toHaveBeenCalledTimes(1)
      expect(state.openInternalPage.mock.calls[0]).toEqual(['settings'])
      expect(state.openInternalPage.mock.calls[0]).toHaveLength(1)
      expect(state.createTab).not.toHaveBeenCalled()
    })

    it.each([
      ['宿主窗口 7', HOST],
      ['主窗口 9', OTHER]
    ])(
      'BR-4 %s create-tab 带 file: / view-source:file: / data: → 照样 createTab',
      async (_l, sender) => {
        const urls = [FILE, 'view-source:file:///x', 'data:text/html,x']
        for (const url of urls) {
          expect(await invoke('browser-view:create-tab', sender, url)).toBe('tab-new')
        }
        expect(state.createTab.mock.calls).toEqual(urls.map((url) => [url, { activate: true }]))
      }
    )
  })

  describe('navigate', () => {
    it.each([
      ['file:', 'file:///x'],
      ['view-source:', 'view-source:https://a.example/'],
      ['data:', 'data:text/html,x'],
      ['blob:', 'blob:https://a.example/uuid'],
      ['不认识的 shuvix://', 'shuvix://unknown']
    ])('BR-5 网络客户端 navigate(T, %s) → 抛，navigateTab 不调', (_l, url) => {
      refusedFromNet('browser-view:navigate', 'T', url)
      expect(state.navigateTab).not.toHaveBeenCalled()
    })

    it('BR-5 网络客户端 navigate 去 https / about:blank / shuvix://settings → navigateTab(T, url, transition)', () => {
      fromNet('browser-view:navigate', 'T', HTTPS, 'typed')
      fromNet('browser-view:navigate', 'T', 'about:blank')
      fromNet('browser-view:navigate', 'T', 'shuvix://settings', 'generated')
      expect(state.navigateTab.mock.calls).toEqual([
        ['T', HTTPS, 'typed'],
        ['T', 'about:blank', undefined],
        ['T', 'shuvix://settings', 'generated']
      ])
    })

    it('BR-5 网络客户端 navigate 参数不是字符串 → 不抛、不调', () => {
      expect(() => fromNet('browser-view:navigate', 42, 'file:///x')).not.toThrow()
      expect(() => fromNet('browser-view:navigate', 'T', 42)).not.toThrow()
      expect(state.navigateTab).not.toHaveBeenCalled()
    })

    it('BR-6 窗口 navigate 去 file: → navigateTab 照调', async () => {
      await invoke('browser-view:navigate', HOST, 'T', 'file:///x')
      expect(state.navigateTab.mock.calls).toEqual([['T', 'file:///x', undefined]])
    })
  })

  describe('后退 / 前进', () => {
    /** historyNoteUser 在这个导航动作之前被调 */
    const notedBefore = (nav: Spy): void => {
      expect(state.historyNoteUser.mock.invocationCallOrder[0]).toBeLessThan(
        nav.mock.invocationCallOrder[0]
      )
    }

    it('BR-7 网络客户端 go-back，前一条是网页（再往前是 file:）→ 先 historyNoteUser(T)、再 goToIndex(1)；不调 goBack', () => {
      const view = historyView([FILE, HTTPS, 'https://b.example/'], 2)
      expect(() => fromNet('browser-view:go-back', 'T')).not.toThrow()
      expect(view.getEntryAtIndex.mock.calls).toEqual([[1]])
      expect(state.historyNoteUser.mock.calls).toEqual([['T']])
      expect(view.goToIndex.mock.calls).toEqual([[1]])
      notedBefore(view.goToIndex)
      expect(view.goBack).not.toHaveBeenCalled()
      expect(view.goForward).not.toHaveBeenCalled()
    })

    it('BR-7 网络客户端 go-back，前一条是 file: → 抛，不记、不导航', () => {
      const view = historyView([HTTPS, FILE, 'https://b.example/'], 2)
      refusedFromNet('browser-view:go-back', 'T')
      expect(state.historyNoteUser).not.toHaveBeenCalled()
      expect(view.goToIndex).not.toHaveBeenCalled()
      expect(view.goBack).not.toHaveBeenCalled()
    })

    it('BR-8 网络客户端 go-forward，后一条是网页 → goToIndex(1)；不调 goForward', () => {
      const view = historyView([HTTPS, 'https://b.example/'], 0)
      fromNet('browser-view:go-forward', 'T')
      expect(view.getEntryAtIndex.mock.calls).toEqual([[1]])
      expect(state.historyNoteUser.mock.calls).toEqual([['T']])
      expect(view.goToIndex.mock.calls).toEqual([[1]])
      notedBefore(view.goToIndex)
      expect(view.goForward).not.toHaveBeenCalled()
    })

    it('BR-8 网络客户端 go-forward，后一条是 file: → 抛，不记、不导航', () => {
      const view = historyView([HTTPS, FILE], 0)
      refusedFromNet('browser-view:go-forward', 'T')
      expect(state.historyNoteUser).not.toHaveBeenCalled()
      expect(view.goToIndex).not.toHaveBeenCalled()
      expect(view.goForward).not.toHaveBeenCalled()
    })

    it('BR-8 网络客户端 go-forward 只看紧挨着的那一条：再往后的 file: 不管 → goToIndex(2)', () => {
      const view = historyView([HTTPS, 'https://b.example/', 'https://c.example/', FILE], 1)
      fromNet('browser-view:go-forward', 'T')
      expect(view.goToIndex.mock.calls).toEqual([[2]])
      expect(state.historyNoteUser.mock.calls).toEqual([['T']])
    })

    it.each<[string, unknown]>([
      ['null', null],
      ['undefined', undefined]
    ])('BR-9 能退 / 能进，但那一条取不到（%s）→ 抛，不记、不导航', (_l, entry) => {
      const view = historyView([HTTPS, HTTPS, HTTPS], 1, { entryAt: () => entry })
      refusedFromNet('browser-view:go-back', 'T')
      refusedFromNet('browser-view:go-forward', 'T')
      expect(state.historyNoteUser).not.toHaveBeenCalled()
      expect(view.goToIndex).not.toHaveBeenCalled()
      expect(view.goBack).not.toHaveBeenCalled()
      expect(view.goForward).not.toHaveBeenCalled()
    })

    it('BR-9 不能退 / 不能进 → 不抛、不读、不记、不导航', () => {
      const view = historyView([HTTPS], 0)
      expect(() => fromNet('browser-view:go-back', 'T')).not.toThrow()
      expect(() => fromNet('browser-view:go-forward', 'T')).not.toThrow()
      expect(view.getEntryAtIndex).not.toHaveBeenCalled()
      expect(state.historyNoteUser).not.toHaveBeenCalled()
      expect(view.goToIndex).not.toHaveBeenCalled()
    })

    it('BR-9 没有这个 tab → 不抛、什么也不做', () => {
      state.tabView = null
      expect(() => fromNet('browser-view:go-back', 'T')).not.toThrow()
      expect(() => fromNet('browser-view:go-forward', 'T')).not.toThrow()
      expect(state.historyNoteUser).not.toHaveBeenCalled()
    })

    it('BR-10 窗口 go-back 去 file: → historyNoteUser 再 goBack()；从不读那一条', async () => {
      const view = historyView([FILE, HTTPS], 1)
      await invoke('browser-view:go-back', HOST, 'T')
      expect(view.goBack).toHaveBeenCalledTimes(1)
      notedBefore(view.goBack)
      expect(view.goToIndex).not.toHaveBeenCalled()
      expect(view.getEntryAtIndex).not.toHaveBeenCalled()
      expect(view.getActiveIndex).not.toHaveBeenCalled()
    })

    it('BR-10 窗口 go-forward 去 file: → goForward()；从不读那一条', async () => {
      const view = historyView([HTTPS, FILE], 0)
      await invoke('browser-view:go-forward', OTHER, 'T')
      expect(view.goForward).toHaveBeenCalledTimes(1)
      expect(view.goToIndex).not.toHaveBeenCalled()
      expect(view.getEntryAtIndex).not.toHaveBeenCalled()
      expect(view.getActiveIndex).not.toHaveBeenCalled()
    })
  })

  describe('reopen-closed-tab', () => {
    it('BR-11 网络客户端，要重开的是 file: → 抛、reopenClosedTab 不调；记录留着，窗口照样能重开', async () => {
      state.peekClosedTabUrl.mockReturnValue('file:///x')
      state.reopenClosedTab.mockReturnValue('tab-reopened')
      refusedFromNet('browser-view:reopen-closed-tab')
      expect(state.reopenClosedTab).not.toHaveBeenCalled()

      expect(await invoke('browser-view:reopen-closed-tab', HOST)).toBe('tab-reopened')
      expect(state.reopenClosedTab).toHaveBeenCalledTimes(1)
    })

    it.each(['https://b.test/', 'shuvix://settings'])(
      'BR-11 网络客户端，要重开的是 %s → reopenClosedTab、回它的值',
      (next) => {
        state.peekClosedTabUrl.mockReturnValue(next)
        state.reopenClosedTab.mockReturnValue('tab-reopened')
        expect(fromNet('browser-view:reopen-closed-tab')).toBe('tab-reopened')
        expect(state.reopenClosedTab).toHaveBeenCalledTimes(1)
      }
    )

    it('BR-11 网络客户端，没有可重开的 → reopenClosedTab、回 null', () => {
      state.peekClosedTabUrl.mockReturnValue(undefined)
      expect(fromNet('browser-view:reopen-closed-tab')).toBeNull()
      expect(state.reopenClosedTab).toHaveBeenCalledTimes(1)
    })

    it('BR-12 窗口，要重开的是 file: → reopenClosedTab 照调、回它的值', async () => {
      state.peekClosedTabUrl.mockReturnValue('file:///x')
      state.reopenClosedTab.mockReturnValue('tab-file')
      expect(await invoke('browser-view:reopen-closed-tab', OTHER)).toBe('tab-file')
      expect(state.reopenClosedTab).toHaveBeenCalledTimes(1)
    })
  })

  describe('capture', () => {
    it.each(['https://a.example/', 'about:blank', 'shuvix://settings'])(
      'BR-13 网络客户端 capture，tab 正显示 %s → captureTab(T, 1600)，回它的值',
      async (shown) => {
        state.tabDisplayUrl.mockReturnValue(shown)
        expect(await fromNet('browser-view:capture', 'T', 1600)).toBe('data:x')
        expect(state.tabDisplayUrl.mock.calls).toEqual([['T']])
        expect(state.captureTab.mock.calls).toEqual([['T', 1600]])
      }
    )

    it("BR-13 网络客户端 capture(T, '800') → captureTab(T, undefined)", async () => {
      state.tabDisplayUrl.mockReturnValue(HTTPS)
      await fromNet('browser-view:capture', 'T', '800')
      expect(state.captureTab.mock.calls).toEqual([['T', undefined]])
    })

    it.each(['file:///x', 'view-source:file:///x', 'data:text/html,<b>x</b>'])(
      'BR-13 网络客户端 capture，tab 正显示 %s → 抛，captureTab 不调',
      (shown) => {
        state.tabDisplayUrl.mockReturnValue(shown)
        refusedFromNet('browser-view:capture', 'T', 1600)
        expect(state.captureTab).not.toHaveBeenCalled()
      }
    )

    it("BR-14 网络客户端 capture，显示地址是空串（没有这个 tab）→ ''、不抛、不抓", () => {
      state.tabDisplayUrl.mockReturnValue('')
      expect(fromNet('browser-view:capture', 'gone', 800)).toBe('')
      expect(state.captureTab).not.toHaveBeenCalled()
    })

    it.each<[string, unknown]>([
      ['42', 42],
      ['undefined', undefined]
    ])("BR-14 网络客户端 capture(%s) → ''，tabDisplayUrl / captureTab 都不调", (_l, tabId) => {
      expect(fromNet('browser-view:capture', tabId, 800)).toBe('')
      expect(state.tabDisplayUrl).not.toHaveBeenCalled()
      expect(state.captureTab).not.toHaveBeenCalled()
    })
  })

  describe('经真的网络分发器（BR-15）', () => {
    const dispatcher = createNetworkDispatcher({
      definitionOf: (channel) => listDefinitions().find((d) => d.channel === channel)
    })
    const call = (
      id: number,
      channel: string,
      args: unknown[]
    ): ReturnType<typeof dispatcher.invoke> =>
      dispatcher.invoke(netCtx(1), { t: 'invoke', id, channel, args })

    it('BR-15 create-tab file: → ok:false、code remote_url_refused，消息里没有路径；什么也不建', async () => {
      const result = await call(1, 'browser-view:create-tab', [FILE])
      expect(result).toMatchObject({ t: 'result', id: 1, ok: false, error: { code: REFUSED } })
      const error = (result as { error: { message: string } }).error
      expect(typeof error.message).toBe('string')
      expect(error.message).not.toContain('/Users/me')
      expect(error.message).not.toContain('secret')
      expect(state.createTab).not.toHaveBeenCalled()
    })

    it("BR-15 create-tab https → ok:true、value 'tab-new'", async () => {
      expect(await call(2, 'browser-view:create-tab', [HTTPS])).toStrictEqual({
        t: 'result',
        id: 2,
        ok: true,
        value: 'tab-new'
      })
    })

    it('BR-15 capture 一个正显示 file: 的 tab → ok:false、同一个 code，不抓', async () => {
      state.tabDisplayUrl.mockReturnValue('file:///Users/me/secret.txt')
      const result = await call(3, 'browser-view:capture', ['T', 800])
      expect(result).toMatchObject({ t: 'result', id: 3, ok: false, error: { code: REFUSED } })
      expect((result as { error: { message: string } }).error.message).not.toContain('secret')
      expect(state.captureTab).not.toHaveBeenCalled()
    })
  })
})

describe('浏览器宿主的样子（HI-1 / HI-2）', () => {
  const fromNet = (channel: string, ...args: unknown[]): unknown => {
    const definition = listDefinitions().find((d) => d.channel === channel)
    if (!definition) throw new Error(`no definition for ${channel}`)
    return definition.fn(netCtx(1), ...args)
  }

  it.each([true, false])(
    'HI-1 isHeadless() = %s → 窗口与网络客户端都回 { headless: %s }',
    async (h) => {
      state.headless = h
      expect(await invoke('browser-view:host-info', HOST)).toEqual({ headless: h })
      expect(await invoke('browser-view:host-info', OTHER)).toEqual({ headless: h })
      expect(await Promise.resolve(fromNet('browser-view:host-info'))).toEqual({ headless: h })
    }
  )

  it('HI-2 经真的网络分发器：ok:true、{headless:false}', async () => {
    const dispatcher = createNetworkDispatcher({
      definitionOf: (channel) => listDefinitions().find((d) => d.channel === channel)
    })
    expect(
      await dispatcher.invoke(netCtx(1), {
        t: 'invoke',
        id: 1,
        channel: 'browser-view:host-info',
        args: []
      })
    ).toStrictEqual({ t: 'result', id: 1, ok: true, value: { headless: false } })
  })

  it('HI-2 判官拒绝 browser scope 的 admin：host-info（read）照样 ok；list-tabs（admin）被拒 —— 判官确实在判', async () => {
    const judged: Array<{ channel: string; scope: string; access: string }> = []
    const dispatcher = createNetworkDispatcher({
      definitionOf: (channel) => listDefinitions().find((d) => d.channel === channel),
      judge: (_ctx, call) => {
        const facts = channelCallFactsOf(call.channel, call.args)
        judged.push({ channel: call.channel, ...facts })
        return facts.scope === 'browser' && facts.access === 'admin'
          ? {
              allowed: false,
              decision: { effect: 'deny', matched: ['no-admin'], winning: 'no-admin' },
              downgraded: false,
              message: 'no admin from this device'
            }
          : undefined
      }
    })
    expect(
      await dispatcher.invoke(netCtx(1), {
        t: 'invoke',
        id: 2,
        channel: 'browser-view:host-info',
        args: []
      })
    ).toStrictEqual({ t: 'result', id: 2, ok: true, value: { headless: false } })
    expect(
      await dispatcher.invoke(netCtx(1), {
        t: 'invoke',
        id: 3,
        channel: 'browser-view:list-tabs',
        args: []
      })
    ).toMatchObject({ t: 'result', id: 3, ok: false, error: { code: 'denied' } })
    expect(judged).toEqual([
      { channel: 'browser-view:host-info', scope: 'browser', access: 'read' },
      { channel: 'browser-view:list-tabs', scope: 'browser', access: 'admin' }
    ])
  })
})
