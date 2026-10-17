/**
 * widgetHandlers —— Widget 主屏用到的四条 IPC：图标原文、主屏顺序、独立窗口状态、打开方式的记忆。
 * 处理函数只做参数整形 + 透传，判定在服务里。
 *
 *   IW-1 widget:getIcon：字符串 → {svg: readIcon(id)}；不是字符串 → {svg:null}，不调 readIcon
 *   IW-2 widget:setHomeOrder：不是数组 → {success:false}、不调服务；数组里只留字符串交给服务 → {success:true}
 *   IW-3 widgetWindow:status：丢掉非字符串；回 {open: openIds(), preferWindow: preferWindowIds(list)}；不是数组 → preferWindowIds([])
 *   IW-4 widgetWindow:setPreferWindow：缺 id / id 不是字符串 → {success:false}；value 只认 true（'true' 存成 false）
 *   IW-5 window.api 的 widget.getIcon / widget.setHomeOrder / widgetWindow.status / widgetWindow.setPreferWindow
 *        走的就是这四条通道、各转发一个参数
 *
 * electron 是替身（handle 收进 Map），widget 服务与窗口服务整个替掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TABLE } from '../../../shared/apiTable'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  readIcon: vi.fn(),
  setHomeOrder: vi.fn(),
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
  widgetService: { readIcon: state.readIcon, setHomeOrder: state.setHomeOrder },
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
  state.readIcon.mockReset()
  state.setHomeOrder.mockReset()
  state.openIds.mockReset().mockReturnValue([])
  state.preferWindowIds.mockReset().mockReturnValue([])
  state.setPreferWindow.mockReset()
})

describe('widget:getIcon（IW-1）', () => {
  it('IW-1 字符串 id → {svg: readIcon(id)}', async () => {
    state.readIcon.mockReturnValue('<svg/>')
    expect(await handler('widget:getIcon')('a-b')).toEqual({ svg: '<svg/>' })
    expect(state.readIcon).toHaveBeenCalledWith('a-b')

    state.readIcon.mockReturnValue(null)
    expect(await handler('widget:getIcon')('c-d')).toEqual({ svg: null })
  })

  it('IW-1 不是字符串 → {svg:null}，不调 readIcon', async () => {
    for (const bad of [undefined, null, 42, { id: 'a-b' }, ['a-b']]) {
      expect(await handler('widget:getIcon')(bad)).toEqual({ svg: null })
    }
    expect(state.readIcon).not.toHaveBeenCalled()
  })
})

describe('widget:setHomeOrder（IW-2）', () => {
  it('IW-2 不是数组 → {success:false}，不调服务', async () => {
    for (const bad of [undefined, null, 'a-b', { 0: 'a-b' }]) {
      expect(await handler('widget:setHomeOrder')(bad)).toEqual({ success: false })
    }
    expect(state.setHomeOrder).not.toHaveBeenCalled()
  })

  it('IW-2 只留字符串交给服务 → {success:true}', async () => {
    expect(await handler('widget:setHomeOrder')(['a-b', 1, null, 'c-d'])).toEqual({
      success: true
    })
    expect(state.setHomeOrder).toHaveBeenCalledTimes(1)
    expect(state.setHomeOrder).toHaveBeenCalledWith(['a-b', 'c-d'])
  })
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
  it('IW-5 四个成员走的就是这四条通道、各转发一个参数', () => {
    expect(API_TABLE.widget.getIcon).toEqual({
      kind: 'invoke',
      channel: 'widget:getIcon',
      args: 1
    })
    expect(API_TABLE.widget.setHomeOrder).toEqual({
      kind: 'invoke',
      channel: 'widget:setHomeOrder',
      args: 1
    })
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
    for (const channel of [
      'widget:getIcon',
      'widget:setHomeOrder',
      'widgetWindow:status',
      'widgetWindow:setPreferWindow'
    ]) {
      expect(state.handlers.has(channel), channel).toBe(true)
    }
  })
})
