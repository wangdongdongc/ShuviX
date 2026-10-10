/**
 * mdMetaHandlers —— 属性卡「ShuviX 设置」条的 IPC（`mdMeta:get` / `setFill` / `unsetFill`）只做透传：
 *
 *   IPC-1 恰好注册这三条通道；
 *   IPC-2 get 把 `params.sessionId` 交给 noteView、结果原样交回；params 缺省也不抛（交 undefined，判定归服务）；
 *   IPC-3 setFill / unsetFill 把 params **按引用**交给服务、结果原样交回（校验全在服务里）；
 *   IPC-4 preload 暴露的 `mdMeta.*` 用的是同样三条通道名（静态读源码）。
 *
 * electron 是替身（handle 收进 Map），服务整个替掉。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  noteView: vi.fn(),
  setNoteFill: vi.fn(),
  unsetNoteFill: vi.fn()
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
  unsetNoteFill: state.unsetNoteFill
}))

import { registerMdMetaHandlers } from '../mdMetaHandlers'

const CHANNELS = ['mdMeta:get', 'mdMeta:setFill', 'mdMeta:unsetFill']
const handler = (channel: string): Handler => {
  const fn = state.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn
}

beforeEach(() => {
  state.handlers.clear()
  state.noteView.mockReset()
  state.setNoteFill.mockReset()
  state.unsetNoteFill.mockReset()
  registerMdMetaHandlers()
})

describe('mdMeta IPC', () => {
  it('IPC-1 恰好注册 mdMeta:get / setFill / unsetFill 三条', () => {
    expect([...state.handlers.keys()].sort()).toEqual([...CHANNELS].sort())
  })

  it('IPC-2 get：sessionId 交给 noteView，结果原样回；params 缺省 → noteView(undefined)，不抛', async () => {
    const view = { kind: 'agent', objectId: null }
    state.noteView.mockReturnValue(view)
    expect(await handler('mdMeta:get')({}, { sessionId: 's' })).toBe(view)
    expect(state.noteView).toHaveBeenCalledWith('s')

    state.noteView.mockReturnValue(null)
    expect(await handler('mdMeta:get')({}, undefined)).toBeNull()
    expect(state.noteView).toHaveBeenLastCalledWith(undefined)
  })

  it('IPC-3 setFill / unsetFill：params 按引用交给服务，结果原样回', async () => {
    const setParams = { sessionId: 's', objectId: 'o', key: 'shuvix-thinking', value: 'high' }
    const setResult = { success: false, reason: 'no-object-id' }
    state.setNoteFill.mockReturnValue(setResult)
    expect(await handler('mdMeta:setFill')({}, setParams)).toBe(setResult)
    expect(state.setNoteFill).toHaveBeenCalledTimes(1)
    expect(state.setNoteFill.mock.calls[0][0]).toBe(setParams)

    const unsetParams = { sessionId: 's', objectId: 'o', key: 'shuvix-model' }
    const unsetResult = { success: true }
    state.unsetNoteFill.mockReturnValue(unsetResult)
    expect(await handler('mdMeta:unsetFill')({}, unsetParams)).toBe(unsetResult)
    expect(state.unsetNoteFill.mock.calls[0][0]).toBe(unsetParams)
  })

  it('IPC-4 preload 的 mdMeta.* 调的就是这三条通道', () => {
    const preload = readFileSync(join(__dirname, '../../../preload/index.ts'), 'utf-8')
    const block = /mdMeta:\s*\{([\s\S]*?)\n {2}\}/.exec(preload)?.[1] ?? ''
    expect(block).not.toBe('')
    const invoked = [...block.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1])
    expect(invoked.sort()).toEqual([...CHANNELS].sort())
    expect(block).toMatch(/get:[\s\S]*'mdMeta:get'/)
    expect(block).toMatch(/setFill:[\s\S]*'mdMeta:setFill'/)
    expect(block).toMatch(/unsetFill:[\s\S]*'mdMeta:unsetFill'/)
  })
})
