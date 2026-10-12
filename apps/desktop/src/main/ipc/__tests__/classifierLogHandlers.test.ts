/**
 * classifierLogHandlers —— 分类器调用日志的 IPC（设置「监控 → 分类器」）只做透传：
 *
 *   IPC-CL1 恰好注册 classifierLog:list / get / scenes / clear 四条通道
 *   IPC-CL2 list：params 按引用交给服务、结果原样交回；params 缺省 → list(undefined)，不抛
 *   IPC-CL3 get：id 交给 getById、结果原样交回（没有这一行 → undefined）
 *   IPC-CL4 scenes 原样交回；clear 调一次服务的 clear、回 { success: true }
 *   IPC-CL5 preload 暴露的 `classifierLog.*` 用的是同样四条通道名；handlers.ts 注册了它（静态读源码）
 *
 * electron 是替身（handle 收进 Map），服务整个替掉。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const CHANNELS = [
  'classifierLog:list',
  'classifierLog:get',
  'classifierLog:scenes',
  'classifierLog:clear'
]
const handler = (channel: string): Handler => {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn
}

beforeEach(() => {
  state.handlers.clear()
  state.list.mockReset()
  state.getById.mockReset()
  state.scenes.mockReset()
  state.clear.mockReset()
  registerClassifierLogHandlers()
})

describe('classifierLog IPC', () => {
  it('IPC-CL1 恰好注册 list / get / scenes / clear 四条', () => {
    expect([...state.handlers.keys()].sort()).toEqual([...CHANNELS].sort())
  })

  it('IPC-CL2 list：params 按引用交给服务，结果原样回；params 缺省 → list(undefined)，不抛', async () => {
    const params = { scene: 'command-risk', sessionId: 's1', status: 'failed', limit: 50 }
    const rows = [{ id: 'a' }, { id: 'b' }]
    state.list.mockReturnValue(rows)
    expect(await handler('classifierLog:list')({}, params)).toBe(rows)
    expect(state.list).toHaveBeenCalledTimes(1)
    expect(state.list.mock.calls[0][0]).toBe(params)

    state.list.mockReturnValue([])
    expect(await handler('classifierLog:list')({}, undefined)).toEqual([])
    expect(state.list).toHaveBeenLastCalledWith(undefined)
  })

  it('IPC-CL3 get：id 交给 getById，结果原样回；没有这一行 → undefined', async () => {
    const row = { id: 'log-1', request: '{}' }
    state.getById.mockReturnValue(row)
    expect(await handler('classifierLog:get')({}, 'log-1')).toBe(row)
    expect(state.getById).toHaveBeenCalledWith('log-1')

    state.getById.mockReturnValue(undefined)
    expect(await handler('classifierLog:get')({}, 'missing')).toBeUndefined()
    expect(state.getById).toHaveBeenLastCalledWith('missing')
  })

  it('IPC-CL4 scenes 原样回；clear 调一次服务的 clear、回 { success: true }', async () => {
    const scenes = ['command-risk']
    state.scenes.mockReturnValue(scenes)
    expect(await handler('classifierLog:scenes')({})).toBe(scenes)
    expect(state.scenes).toHaveBeenCalledTimes(1)

    expect(await handler('classifierLog:clear')({})).toEqual({ success: true })
    expect(state.clear).toHaveBeenCalledTimes(1)
  })

  it('IPC-CL5 preload 的 classifierLog.* 调的就是这四条通道；handlers.ts 注册了它们', () => {
    const preload = readFileSync(join(__dirname, '../../../preload/index.ts'), 'utf-8')
    const block = /classifierLog:\s*\{([\s\S]*?)\n {2}\}/.exec(preload)?.[1] ?? ''
    expect(block).not.toBe('')
    const invoked = [...block.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1])
    expect(invoked.sort()).toEqual([...CHANNELS].sort())
    expect(block).toMatch(/list:[^\n]*'classifierLog:list', params\)/)
    expect(block).toMatch(/get:[^\n]*'classifierLog:get', id\)/)
    expect(block).toMatch(/scenes:[^\n]*'classifierLog:scenes'/)
    expect(block).toMatch(/clear:[^\n]*'classifierLog:clear'/)

    const handlers = readFileSync(join(__dirname, '../handlers.ts'), 'utf-8')
    expect(handlers).toMatch(
      /import \{ registerClassifierLogHandlers \} from '\.\/classifierLogHandlers'/
    )
    expect(handlers).toMatch(/^\s*registerClassifierLogHandlers\(\)/m)
  })
})
