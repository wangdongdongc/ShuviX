/**
 * widgetHandlers —— Widget 面板用到的两条 IPC：独立窗口状态、打开方式的记忆。
 * 处理函数只做参数整形 + 透传，判定在服务里。
 *
 *   IW-3 widgetWindow:status：丢掉非字符串；回 {open: openIds(), preferWindow: preferWindowIds(list)}；不是数组 → preferWindowIds([])
 *   IW-4 widgetWindow:setPreferWindow：缺 id / id 不是字符串 → {success:false}；value 只认 true（'true' 存成 false）
 *   IW-5 window.api 的 widgetWindow.status / widgetWindow.setPreferWindow 走的就是这两条通道、各转发一个参数
 *   IW-6 主屏那两条没了：API_TABLE.widget 里没有 getIcon / setHomeOrder，也没注册 widget:getIcon / widget:setHomeOrder
 *
 * electron 是替身（handle 收进 Map），widget 服务与窗口服务整个替掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TABLE } from '../../../shared/apiTable'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  openIds: vi.fn(),
  preferWindowIds: vi.fn(),
  setPreferWindow: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      state.handlers.set(channel, fn)
    }
  },
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') },
  shell: { showItemInFolder: vi.fn() }
}))
vi.mock('../../services/widget', () => ({
  widgetService: {},
  widgetServer: {},
  exportWidget: vi.fn(),
  resolveExportZipPath: vi.fn(),
  WidgetExportError: class WidgetExportError extends Error {}
}))
vi.mock('../../services/widgetWindowService', () => ({
  openIds: state.openIds,
  preferWindowIds: state.preferWindowIds,
  setPreferWindow: state.setPreferWindow,
  open: vi.fn(),
  close: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  getAlwaysOnTop: vi.fn()
}))

import { registerWidgetHandlers } from '../widgetHandlers'
import { attachIpcAdapter } from '../ipcAdapter'

const IPC_EVENT = { sender: { id: 1 } }
/** 已注册的处理函数（发送方 = webContents 1；事件参数由这里补上） */
const handler =
  (channel: string): ((...args: unknown[]) => unknown) =>
  (...args) => {
    const fn = state.handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn(IPC_EVENT, ...args)
  }

registerWidgetHandlers()
attachIpcAdapter()

beforeEach(() => {
  state.openIds.mockReset().mockReturnValue([])
  state.preferWindowIds.mockReset().mockReturnValue([])
  state.setPreferWindow.mockReset()
})

describe('widgetWindow:status（IW-3）', () => {
  it('IW-3 丢掉非字符串，回 open 与 preferWindow', async () => {
    state.openIds.mockReturnValue(['x-y'])
    state.preferWindowIds.mockReturnValue(['a-b'])
    expect(await handler('widgetWindow:status')(['a-b', 3, null, 'c-d'])).toEqual({
      open: ['x-y'],
      preferWindow: ['a-b']
    })
    expect(state.preferWindowIds).toHaveBeenCalledWith(['a-b', 'c-d'])
  })

  it('IW-3 不是数组 → preferWindowIds([])', async () => {
    state.openIds.mockReturnValue(['x-y'])
    const result = await handler('widgetWindow:status')(undefined)
    expect(state.preferWindowIds).toHaveBeenCalledWith([])
    expect(result).toEqual({ open: ['x-y'], preferWindow: [] })

    await handler('widgetWindow:status')('a-b')
    expect(state.preferWindowIds).toHaveBeenLastCalledWith([])
  })
})

describe('widgetWindow:setPreferWindow（IW-4）', () => {
  it('IW-4 缺 id / id 不是字符串 → {success:false}，不写', async () => {
    for (const bad of [undefined, null, {}, { id: 7, value: true }, { value: true }]) {
      expect(await handler('widgetWindow:setPreferWindow')(bad)).toEqual({ success: false })
    }
    expect(state.setPreferWindow).not.toHaveBeenCalled()
  })

  it('IW-4 value 只认 true', async () => {
    expect(await handler('widgetWindow:setPreferWindow')({ id: 'a-b', value: true })).toEqual({
      success: true
    })
    expect(state.setPreferWindow).toHaveBeenLastCalledWith('a-b', true)

    await handler('widgetWindow:setPreferWindow')({ id: 'a-b', value: 'true' })
    expect(state.setPreferWindow).toHaveBeenLastCalledWith('a-b', false)

    await handler('widgetWindow:setPreferWindow')({ id: 'a-b' })
    expect(state.setPreferWindow).toHaveBeenLastCalledWith('a-b', false)
  })
})

describe('通道表（IW-5）', () => {
  it('IW-5 两个成员走的就是这两条通道、各转发一个参数', () => {
    expect(API_TABLE.widgetWindow.status).toEqual({
      kind: 'invoke',
      channel: 'widgetWindow:status',
      args: 1
    })
    expect(API_TABLE.widgetWindow.setPreferWindow).toEqual({
      kind: 'invoke',
      channel: 'widgetWindow:setPreferWindow',
      args: 1
    })
    for (const channel of ['widgetWindow:status', 'widgetWindow:setPreferWindow']) {
      expect(state.handlers.has(channel), channel).toBe(true)
    }
  })
})

describe('主屏的两条通道已去掉（IW-6）', () => {
  it('IW-6 API_TABLE.widget 没有 getIcon / setHomeOrder，处理函数也没注册', () => {
    expect(Object.keys(API_TABLE.widget)).not.toContain('getIcon')
    expect(Object.keys(API_TABLE.widget)).not.toContain('setHomeOrder')
    // 注册是真的发生了（别的 widget 通道都在），不是整张表空着
    expect(state.handlers.has('widget:delete')).toBe(true)
    for (const channel of ['widget:getIcon', 'widget:setHomeOrder']) {
      expect(state.handlers.has(channel), channel).toBe(false)
    }
  })
})
