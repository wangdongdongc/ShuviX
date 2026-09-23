/**
 * browserViewHandlers —— 浏览器搬进独立窗口之后，IPC 这一层多出来的两条规矩。
 *
 *   U6  布局表（set-layout）与墙级可见性门（set-visible）**只认宿主窗口**发来的：主窗口里残留的
 *       旧代码若还在发一张空表，会把浏览器窗口里的 view 全部藏掉。其余窗口发来的一律不理。
 *       另外两条新通道：open-window 打开 / 聚焦窗口；is-window-open 原样回答窗口服务的判断。
 *       create-tab（主窗 / 浏览器窗口里的「新建 tab」）只建一个激活的 tab，**不**打开浏览器窗口 ——
 *       窗口只由 open-window 打开（ST-U6）。
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
  isBrowserWindowOpen: vi.fn<() => boolean>(() => false)
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
  closeTab: vi.fn(),
  activateTab: vi.fn(),
  listTabs: vi.fn(() => []),
  getTabView: vi.fn(() => null),
  captureTab: vi.fn(async () => ''),
  setLayout: (entries: unknown) => state.setLayout(entries),
  setPanelVisible: (visible: boolean) => state.setPanelVisible(visible),
  isHostWebContents: (id: number) => id === 7,
  openBrowserWindow: () => state.openBrowserWindow(),
  isBrowserWindowOpen: () => state.isBrowserWindowOpen()
}))

import { registerBrowserViewHandlers } from '../browserViewHandlers'

registerBrowserViewHandlers()

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

  it('U6 open-window 调 openBrowserWindow（从主窗口发来也照办 —— 那正是侧栏按钮）', async () => {
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
