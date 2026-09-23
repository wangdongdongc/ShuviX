/**
 * browserViewService 与「别打扰用户」防护（agentGuards）的接线 —— tab 这一侧。
 *
 *   NG-U8  (a) closeTab 在 webContents.close() **之前**摘掉这个 tab 的防护（close 之后 webContents 已销毁，
 *              防护的 debugger 处理函数再也摘不掉）；destroyAllTabs 每个 tab 摘一次；
 *          (b) browserWindowInFront()：从没建过 / 隐藏 / 最小化 / 可见没焦点 / 已销毁都回 null；
 *              只有可见、没最小化、有焦点时回那个窗口；
 *          (c) createTab() 不给地址也真的加载一次 about:blank（从没导航过的 webContents 没有渲染进程，
 *              attach 之后的 CDP 命令会一直等下去）；
 *          (d) tab 里 window.open 一个 http(s)：开它的 tab 在 agent 手里（hasAgentGuards）→ 新 tab 先加载
 *              about:blank、接上 CDP（browserCdpManager.session(新 id)，防护随 attach 装上）、开对话框自动
 *              处理，**然后**才加载弹出页；开它的 tab 不在 agent 手里 → 新 tab 直接加载那个地址，不接 CDP。
 *              用户不在看浏览器窗口（agent 在后台点的）与正看着（routeExternalUrl 的 onWeb）两条路都一样。
 *
 * electron 换成 ./fakeElectron.ts；agentGuards 与 browserCdpService 换成间谍（CDP 会话是个只有
 * enableDialogHandling 的空壳）；browserViewService / browserWindowService / stagingWindow /
 * externalOpen 的裁决都是真的。模块级状态每条用例都要新的：beforeEach 里 resetModules，load() 重新导入。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeElectron, type FakeView, type FakeWindow } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

const state = vi.hoisted(() => {
  const enableDialogHandling = vi.fn(async () => {})
  return {
    guarded: new Set<string>(),
    installAgentGuards: vi.fn(async (_tabId: string, _wc: unknown) => {}),
    uninstallAgentGuards: vi.fn((_tabId: string) => {}),
    hasAgentGuards: vi.fn((_tabId: string) => false),
    enableDialogHandling,
    session: vi.fn(async (_tabId: string) => ({ enableDialogHandling })),
    handleExternalDetach: vi.fn((_tabId: string) => {}),
    detachAll: vi.fn(async () => {})
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
  installAgentGuards: (tabId: string, wc: unknown) => state.installAgentGuards(tabId, wc),
  uninstallAgentGuards: (tabId: string) => state.uninstallAgentGuards(tabId),
  hasAgentGuards: (tabId: string) => state.hasAgentGuards(tabId)
}))
vi.mock('../browserCdpService', () => ({
  browserCdpManager: {
    session: (tabId: string) => state.session(tabId),
    handleExternalDetach: (tabId: string) => state.handleExternalDetach(tabId),
    cdpState: () => ({ attached: false, intercepting: false }),
    detachAll: () => state.detachAll()
  }
}))

const fx = fakeElectron()

type ViewService = typeof import('../browserViewService')
type WindowService = typeof import('../browserWindowService')

const OPENER = 'https://opener.example/page'
const POPUP = 'https://popup.example/print-version'

async function load(): Promise<{ views: ViewService; wins: WindowService }> {
  const views = await import('../browserViewService')
  const wins = await import('../browserWindowService')
  wins.initBrowserWindowService({ getThemeBgColor: () => '#000000' })
  return { views, wins }
}

/** 用户经侧栏按钮把浏览器窗口建出来（可见、有焦点） */
function openByUser(wins: WindowService): FakeWindow {
  wins.openBrowserWindow()
  const all = fx.browserWindows()
  if (all.length !== 1) throw new Error(`expected one browser window, got ${all.length}`)
  return all[0]
}

/** 以这个 view 的名义 window.open(url) */
function popup(view: FakeView, url: string): unknown {
  const handler = view.webContents.openHandler
  if (!handler) throw new Error('createTab 没有登记 setWindowOpenHandler')
  return handler({ url })
}

const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

/** 一个间谍第 n 次调用的全局调用序号（跨间谍比先后） */
const order = (fn: { mock: { invocationCallOrder: number[] } }, n = 0): number => {
  const at = fn.mock.invocationCallOrder[n]
  if (at === undefined) throw new Error(`spy was not called ${n + 1} time(s)`)
  return at
}

beforeEach(() => {
  vi.resetModules()
  fx.reset()
  state.guarded.clear()
  for (const fn of [
    state.installAgentGuards,
    state.uninstallAgentGuards,
    state.hasAgentGuards,
    state.enableDialogHandling,
    state.session,
    state.handleExternalDetach,
    state.detachAll
  ]) {
    fn.mockClear()
  }
  state.hasAgentGuards.mockImplementation((tabId: string) => state.guarded.has(tabId))
})

describe('tab 关掉时摘防护（NG-U8a）', () => {
  it('NG-U8 closeTab：先 uninstallAgentGuards(该 tab)，再 webContents.close()', async () => {
    const { views } = await load()
    const a = views.createTab('https://a.example/')
    const b = views.createTab('https://b.example/')
    const viewA = fx.views[0]

    views.closeTab(a)
    expect(state.uninstallAgentGuards.mock.calls).toEqual([[a]])
    expect(viewA.webContents.close).toHaveBeenCalledTimes(1)
    expect(order(state.uninstallAgentGuards)).toBeLessThan(order(viewA.webContents.close))
    expect(fx.views[1].webContents.close).not.toHaveBeenCalled()

    // 关一个不存在的：什么都不摘
    views.closeTab('no-such-tab')
    expect(state.uninstallAgentGuards).toHaveBeenCalledTimes(1)
    views.closeTab(b)
    expect(state.uninstallAgentGuards.mock.calls).toEqual([[a], [b]])
  })

  it('NG-U8 destroyAllTabs：每个 tab 摘一次，都在各自的 close() 之前', async () => {
    const { views } = await load()
    const ids = [
      views.createTab('https://a.example/'),
      views.createTab('https://b.example/'),
      views.createTab()
    ]
    views.destroyAllTabs()
    expect(state.uninstallAgentGuards.mock.calls.map(([id]) => id).sort()).toEqual([...ids].sort())
    for (const [i, id] of ids.entries()) {
      const call = state.uninstallAgentGuards.mock.calls.findIndex(([t]) => t === id)
      expect(order(state.uninstallAgentGuards, call)).toBeLessThan(
        order(fx.views[i].webContents.close)
      )
    }
  })
})

describe('browserWindowInFront：用户此刻是否正看着浏览器窗口（NG-U8b）', () => {
  it('NG-U8 从没建过：null', async () => {
    const { views } = await load()
    expect(views.browserWindowInFront()).toBeNull()
  })

  it('NG-U8 可见、没最小化、有焦点：回那个窗口', async () => {
    const { views, wins } = await load()
    const bw = openByUser(wins)
    expect(views.browserWindowInFront()).toBe(bw)
  })

  it.each([
    ['hidden (closed by the user)', (bw: FakeWindow) => bw.emit('close', { preventDefault() {} })],
    [
      'minimized (still reporting visible)',
      (bw: FakeWindow) => {
        bw.minimized = true
      }
    ],
    [
      'visible but unfocused',
      (bw: FakeWindow) => {
        bw.focused = false
      }
    ],
    [
      'destroyed (flags still say visible + focused)',
      (bw: FakeWindow) => {
        bw.destroyed = true
      }
    ]
  ])('NG-U8 %s：null', async (_label, putAway) => {
    const { views, wins } = await load()
    const bw = openByUser(wins)
    putAway(bw)
    expect(views.browserWindowInFront()).toBeNull()
  })
})

describe('createTab 与弹出页（NG-U8c / NG-U8d）', () => {
  it('NG-U8 createTab() 不给地址：真的加载一次 about:blank', async () => {
    const { views } = await load()
    views.createTab()
    expect(fx.views[0].webContents.loaded).toEqual(['about:blank'])
  })

  it('NG-U8 agent 手里的 tab（用户没在看）window.open 一个 http(s)：新 tab 先 about:blank → 接 CDP → 开对话框处理 → 再加载弹出页', async () => {
    const { views } = await load()
    const opener = views.createTab(OPENER, { activate: true })
    state.guarded.add(opener)
    expect(popup(fx.views[0], POPUP)).toStrictEqual({ action: 'deny' })
    await flush()
    await flush()

    expect(state.hasAgentGuards).toHaveBeenCalledWith(opener)
    expect(fx.views).toHaveLength(2)
    const pop = fx.views[1]
    const popId = views.listTabs()[1].id
    expect(pop.webContents.loaded).toEqual(['about:blank', POPUP])
    expect(state.session.mock.calls).toEqual([[popId]])
    expect(state.enableDialogHandling).toHaveBeenCalledTimes(1)
    expect(order(pop.webContents.loadURL, 0)).toBeLessThan(order(state.session))
    expect(order(state.session)).toBeLessThan(order(state.enableDialogHandling))
    expect(order(state.enableDialogHandling)).toBeLessThan(order(pop.webContents.loadURL, 1))
    // 新 tab 是激活的那个（agent 的默认目标）
    expect(views.listTabs().find((t) => t.active)?.id).toBe(popId)
    expect(fx.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(fx.shell.openExternal).not.toHaveBeenCalled()
  })

  it('NG-U8 接 CDP 失败：弹出页不加载（不会在没有防护的 tab 里自动打印），不抛', async () => {
    const { views } = await load()
    const opener = views.createTab(OPENER)
    state.guarded.add(opener)
    state.session.mockRejectedValueOnce(new Error('attach failed'))
    expect(() => popup(fx.views[0], POPUP)).not.toThrow()
    await flush()
    await flush()
    expect(fx.views[1].webContents.loaded).toEqual(['about:blank'])
  })

  it('NG-U8 不在 agent 手里的 tab window.open 一个 http(s)：新 tab 直接加载那个地址，不接 CDP', async () => {
    const { views } = await load()
    const opener = views.createTab(OPENER)
    expect(popup(fx.views[0], POPUP)).toStrictEqual({ action: 'deny' })
    await flush()
    expect(state.hasAgentGuards).toHaveBeenCalledWith(opener)
    expect(fx.views[1].webContents.loaded).toEqual([POPUP])
    expect(state.session).not.toHaveBeenCalled()
    expect(state.enableDialogHandling).not.toHaveBeenCalled()
  })

  it('NG-U8 用户正看着浏览器窗口时（routeExternalUrl 的 onWeb 那条路）：agent 手里的 tab 同样先接 CDP 再加载', async () => {
    const { views, wins } = await load()
    openByUser(wins)
    const opener = views.createTab(OPENER)
    state.guarded.add(opener)
    popup(fx.views[0], POPUP)
    await flush()
    await flush()
    const pop = fx.views[1]
    expect(pop.webContents.loaded).toEqual(['about:blank', POPUP])
    expect(order(state.session)).toBeLessThan(order(pop.webContents.loadURL, 1))
    expect(order(state.enableDialogHandling)).toBeLessThan(order(pop.webContents.loadURL, 1))
  })

  it('NG-U8 用户正看着浏览器窗口、tab 不在 agent 手里：直接加载，不接 CDP', async () => {
    const { views, wins } = await load()
    openByUser(wins)
    views.createTab(OPENER)
    popup(fx.views[0], POPUP)
    await flush()
    expect(fx.views[1].webContents.loaded).toEqual([POPUP])
    expect(state.session).not.toHaveBeenCalled()
  })
})
