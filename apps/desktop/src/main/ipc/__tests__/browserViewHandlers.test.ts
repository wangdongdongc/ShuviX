/**
 * browserViewHandlers —— 浏览器搬进独立窗口之后，IPC 这一层多出来的两条规矩。
 *
 *   U6  布局表（set-layout）与墙级可见性门（set-visible）**只认宿主窗口**发来的：主窗口里残留的
 *       旧代码若还在发一张空表，会把浏览器窗口里的 view 全部藏掉。其余窗口发来的一律不理。
 *       另外两条新通道：open-window 打开 / 聚焦窗口；is-window-open 原样回答窗口服务的判断。
 *       create-tab（主窗 / 浏览器窗口里的「新建 tab」）只建一个激活的 tab，**不**打开浏览器窗口 ——
 *       窗口只由 open-window 打开（ST-U6）。
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
  openBrowserWindow: vi.fn<() => void>(),
  createTab: vi.fn<(url?: string, opts?: { activate?: boolean }) => string>(() => 'tab-new'),
  isBrowserWindowOpen: vi.fn<() => boolean>(() => false),
  closeTab: vi.fn<(tabId: string, opts?: { remember?: boolean }) => void>(),
  reopenClosedTab: vi.fn<() => string | null>(() => null),
  zoomTab: vi.fn<(tabId: string, direction: string) => void>(),
  openAgentSession: vi.fn<(sessionId: string) => boolean>(() => false),
  requestOmniboxFocus: vi.fn<() => void>(),
  openInternalPage: vi.fn<(page: string) => string>(() => 'tab-settings'),
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
  isHostWebContents: (id: number) => id === 7,
  openBrowserWindow: () => state.openBrowserWindow(),
  isBrowserWindowOpen: () => state.isBrowserWindowOpen(),
  requestOmniboxFocus: () => state.requestOmniboxFocus(),
  reopenClosedTab: () => state.reopenClosedTab(),
  zoomTab: (tabId: string, direction: string) => state.zoomTab(tabId, direction),
  openAgentSession: (sessionId: string) => state.openAgentSession(sessionId),
  openInternalPage: (page: string) => state.openInternalPage(page),
  navigateTab: (tabId: string, url: string, transition?: string) =>
    state.navigateTab(tabId, url, transition),
  historyNoteUser: (tabId: string) => state.historyNoteUser(tabId),
  // 原样转交全部实参：「多余参数丢掉」要在 handler 那一侧看得见
  proceedPastCertError: (...args: unknown[]) => state.proceedPastCertError(...args),
  tabDisplayUrl: (tabId: string) => state.tabDisplayUrl(tabId)
}))

import { registerBrowserViewHandlers } from '../browserViewHandlers'
import { attachIpcAdapter } from '../ipcAdapter'
import { listDefinitions } from '../registry'
import { netCtx } from '../../frontend/network/__tests__/support/fakeNetworkConnection'

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
  state.tabDisplayUrl.mockClear()
  state.captureTab.mockClear()
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
