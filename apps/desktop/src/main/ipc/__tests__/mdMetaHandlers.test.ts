/**
 * mdMetaHandlers —— md 扩展元数据的 IPC（`mdMeta:get` / `setFill` / `unsetFill` / `setEnabled`）只做透传：
 *
 *   IPC-1 恰好注册这四条通道；
 *   IPC-2 get 把 `params.sessionId` 交给 noteView、结果原样交回；params 缺省也不抛（交 undefined，判定归服务）；
 *   IPC-3 setFill / unsetFill 把 params **按引用**交给服务、结果原样交回（校验全在服务里）；
 *   IPC-3b setEnabled（内置 hook / 安全策略的停用开关）同样按引用透传；params 缺省也不抛；
 *   IPC-4 `window.api.mdMeta.*`（通道表 shared/apiTable）用的是同样四条通道名、各转发一个参数。
 *
 * electron 是替身（handle 收进 Map），服务整个替掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TABLE } from '../../../shared/apiTable'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  noteView: vi.fn(),
  setNoteFill: vi.fn(),
  unsetNoteFill: vi.fn(),
  setEnabled: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      state.handlers.set(channel, fn)
    }
  }
}))
vi.mock('../../services/mdMetaService', () => ({
  noteView: state.noteView,
  setNoteFill: state.setNoteFill,
  unsetNoteFill: state.unsetNoteFill,
  setEnabled: state.setEnabled
}))

import { registerMdMetaHandlers } from '../mdMetaHandlers'
import { attachIpcAdapter } from '../ipcAdapter'

const CHANNELS = ['mdMeta:get', 'mdMeta:setFill', 'mdMeta:unsetFill', 'mdMeta:setEnabled']
/** 已注册的处理函数（发送方 = webContents 1；事件参数由这里补上） */
const handler =
  (channel: string): ((...args: unknown[]) => unknown) =>
  (...args) => {
    const fn = state.handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn(IPC_EVENT, ...args)
  }
const IPC_EVENT = { sender: { id: 1 } }

// 注册一次（同一通道再定义会抛错），经 IPC 适配器挂到替身 ipcMain 上
registerMdMetaHandlers()
attachIpcAdapter()

beforeEach(() => {
  state.noteView.mockReset()
  state.setNoteFill.mockReset()
  state.unsetNoteFill.mockReset()
  state.setEnabled.mockReset()
})

describe('mdMeta IPC', () => {
  it('IPC-1 恰好注册 mdMeta:get / setFill / unsetFill / setEnabled 四条', () => {
    expect([...state.handlers.keys()].sort()).toEqual([...CHANNELS].sort())
  })

  it('IPC-2 get：sessionId 交给 noteView，结果原样回；params 缺省 → noteView(undefined)，不抛', async () => {
    const view = { kind: 'agent', objectId: null }
    state.noteView.mockReturnValue(view)
    expect(await handler('mdMeta:get')({ sessionId: 's' })).toBe(view)
    expect(state.noteView).toHaveBeenCalledWith('s')

    state.noteView.mockReturnValue(null)
    expect(await handler('mdMeta:get')(undefined)).toBeNull()
    expect(state.noteView).toHaveBeenLastCalledWith(undefined)
  })

  it('IPC-3 setFill / unsetFill：params 按引用交给服务，结果原样回', async () => {
    const setParams = { sessionId: 's', objectId: 'o', key: 'shuvix-thinking', value: 'high' }
    const setResult = { success: false, reason: 'no-object-id' }
    state.setNoteFill.mockReturnValue(setResult)
    expect(await handler('mdMeta:setFill')(setParams)).toBe(setResult)
    expect(state.setNoteFill).toHaveBeenCalledTimes(1)
    expect(state.setNoteFill.mock.calls[0][0]).toBe(setParams)

    const unsetParams = { sessionId: 's', objectId: 'o', key: 'shuvix-model' }
    const unsetResult = { success: true }
    state.unsetNoteFill.mockReturnValue(unsetResult)
    expect(await handler('mdMeta:unsetFill')(unsetParams)).toBe(unsetResult)
    expect(state.unsetNoteFill.mock.calls[0][0]).toBe(unsetParams)
  })

  it('IPC-3b setEnabled：params 按引用交给服务，结果原样回；params 缺省 → setEnabled(undefined)，不抛', async () => {
    const params = { objectId: 'hook:builtin:auto-title', enabled: false }
    const result = { success: true }
    state.setEnabled.mockReturnValue(result)
    expect(await handler('mdMeta:setEnabled')(params)).toBe(result)
    expect(state.setEnabled).toHaveBeenCalledTimes(1)
    expect(state.setEnabled.mock.calls[0][0]).toBe(params)

    const refused = { success: false, reason: 'key-not-allowed' }
    state.setEnabled.mockReturnValue(refused)
    expect(await handler('mdMeta:setEnabled')(undefined)).toBe(refused)
    expect(state.setEnabled).toHaveBeenLastCalledWith(undefined)
  })

  it('IPC-4 window.api 的 mdMeta.* 调的就是这四条通道', () => {
    expect(API_TABLE.mdMeta).toEqual({
      get: { kind: 'invoke', channel: 'mdMeta:get', args: 1 },
      setFill: { kind: 'invoke', channel: 'mdMeta:setFill', args: 1 },
      unsetFill: { kind: 'invoke', channel: 'mdMeta:unsetFill', args: 1 },
      setEnabled: { kind: 'invoke', channel: 'mdMeta:setEnabled', args: 1 }
    })
    const channels = Object.values(API_TABLE.mdMeta).map((m) => m.channel)
    expect(channels.sort()).toEqual([...CHANNELS].sort())
  })
})
