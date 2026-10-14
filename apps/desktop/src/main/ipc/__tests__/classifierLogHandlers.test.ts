/**
 * classifierLogHandlers —— 分类器调用日志的 IPC（设置「监控 → 分类器」）只做透传：
 *
 *   IPC-CL1 恰好注册 classifierLog:list / get / scenes / clear 四条通道
 *   IPC-CL2 list：params 按引用交给服务、结果原样交回；params 缺省 → list(undefined)，不抛
 *   IPC-CL3 get：id 交给 getById、结果原样交回（没有这一行 → undefined）
 *   IPC-CL4 scenes 原样交回；clear 调一次服务的 clear、回 { success: true }
 *   IPC-CL5 `window.api.classifierLog.*`（通道表 shared/apiTable）用的是同样四条通道名、各转发同样个数的参数；
 *           handlers.ts 注册了它（静态读源码）
 *
 * electron 是替身（handle 收进 Map），服务整个替掉。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TABLE } from '../../../shared/apiTable'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  list: vi.fn(),
  getById: vi.fn(),
  scenes: vi.fn(),
  clear: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      state.handlers.set(channel, fn)
    }
  }
}))
vi.mock('../../services/classifierLogService', () => ({
  classifierLogService: {
    list: state.list,
    getById: state.getById,
    scenes: state.scenes,
    clear: state.clear
  }
}))

import { registerClassifierLogHandlers } from '../classifierLogHandlers'
import { attachIpcAdapter } from '../ipcAdapter'

const CHANNELS = [
  'classifierLog:list',
  'classifierLog:get',
  'classifierLog:scenes',
  'classifierLog:clear'
]
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
registerClassifierLogHandlers()
attachIpcAdapter()

beforeEach(() => {
  state.list.mockReset()
  state.getById.mockReset()
  state.scenes.mockReset()
  state.clear.mockReset()
})

describe('classifierLog IPC', () => {
  it('IPC-CL1 恰好注册 list / get / scenes / clear 四条', () => {
    expect([...state.handlers.keys()].sort()).toEqual([...CHANNELS].sort())
  })

  it('IPC-CL2 list：params 按引用交给服务，结果原样回；params 缺省 → list(undefined)，不抛', async () => {
    const params = { scene: 'command-risk', sessionId: 's1', status: 'failed', limit: 50 }
    const rows = [{ id: 'a' }, { id: 'b' }]
    state.list.mockReturnValue(rows)
    expect(await handler('classifierLog:list')(params)).toBe(rows)
    expect(state.list).toHaveBeenCalledTimes(1)
    expect(state.list.mock.calls[0][0]).toBe(params)

    state.list.mockReturnValue([])
    expect(await handler('classifierLog:list')(undefined)).toEqual([])
    expect(state.list).toHaveBeenLastCalledWith(undefined)
  })

  it('IPC-CL3 get：id 交给 getById，结果原样回；没有这一行 → undefined', async () => {
    const row = { id: 'log-1', request: '{}' }
    state.getById.mockReturnValue(row)
    expect(await handler('classifierLog:get')('log-1')).toBe(row)
    expect(state.getById).toHaveBeenCalledWith('log-1')

    state.getById.mockReturnValue(undefined)
    expect(await handler('classifierLog:get')('missing')).toBeUndefined()
    expect(state.getById).toHaveBeenLastCalledWith('missing')
  })

  it('IPC-CL4 scenes 原样回；clear 调一次服务的 clear、回 { success: true }', async () => {
    const scenes = ['command-risk']
    state.scenes.mockReturnValue(scenes)
    expect(await handler('classifierLog:scenes')()).toBe(scenes)
    expect(state.scenes).toHaveBeenCalledTimes(1)

    expect(await handler('classifierLog:clear')()).toEqual({ success: true })
    expect(state.clear).toHaveBeenCalledTimes(1)
  })

  it('IPC-CL5 window.api 的 classifierLog.* 调的就是这四条通道；handlers.ts 注册了它们', () => {
    // 通道表里恰好这四个成员：list(params) / get(id) 各转发一个参数，scenes / clear 不带参数
    expect(API_TABLE.classifierLog).toEqual({
      list: { kind: 'invoke', channel: 'classifierLog:list', args: 1 },
      get: { kind: 'invoke', channel: 'classifierLog:get', args: 1 },
      scenes: { kind: 'invoke', channel: 'classifierLog:scenes', args: 0 },
      clear: { kind: 'invoke', channel: 'classifierLog:clear', args: 0 }
    })
    const channels = Object.values(API_TABLE.classifierLog).map((m) => m.channel)
    expect(channels.sort()).toEqual([...CHANNELS].sort())

    const handlers = readFileSync(join(__dirname, '../handlers.ts'), 'utf-8')
    expect(handlers).toMatch(
      /import \{ registerClassifierLogHandlers \} from '\.\/classifierLogHandlers'/
    )
    expect(handlers).toMatch(/^\s*registerClassifierLogHandlers\(\)/m)
  })
})
