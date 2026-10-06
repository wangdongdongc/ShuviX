/**
 * messageHandlers —— IPC `message:rollback` 的结果（P3-10b-11，PIN-02）。
 *
 * 真的回退了 → `{success:true}`；没有可回退的目标（运行时拒绝、旧格式会话、id 不是条目 id —— 网关都答
 * false）→ `{success:false}`，界面据此不回填草稿、不重发。处理函数跑在 `createElectronContext(sessionId)`
 * 里；运行时抛错原样拒绝（不吞成 `{success:false}`）。
 *
 * electron 是替身（handle 收进 Map）；网关只替到 rollbackMessage 那一层，operationContext 记下上下文。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  rollbackMessage: vi.fn<(sessionId: string, messageId: string) => Promise<boolean>>(),
  /** operationContext.run 收到的上下文与此刻是否在其中 */
  contexts: [] as unknown[],
  inside: undefined as unknown,
  seenInside: [] as unknown[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../frontend', () => ({
  chatGateway: {
    rollbackMessage: (sessionId: string, messageId: string) => {
      state.seenInside.push(state.inside)
      return state.rollbackMessage(sessionId, messageId)
    }
  },
  operationContext: {
    run: async (ctx: unknown, fn: () => unknown) => {
      state.contexts.push(ctx)
      state.inside = ctx
      try {
        return await fn()
      } finally {
        state.inside = undefined
      }
    }
  },
  createElectronContext: (sessionId: string) => ({ electron: sessionId })
}))

import { registerMessageHandlers } from '../messageHandlers'

registerMessageHandlers()

const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args)
}

beforeEach(() => {
  state.rollbackMessage.mockReset()
  state.contexts.length = 0
  state.seenInside.length = 0
})

describe('P3-10b-11 message:rollback 的结果（PIN-02）', () => {
  it('P3-10b-11 回退了 → {success:true}；网关在 createElectronContext(sessionId) 里被调', async () => {
    state.rollbackMessage.mockResolvedValue(true)
    expect(await invoke('message:rollback', { sessionId: 's1', messageId: '42' })).toEqual({
      success: true
    })
    expect(state.rollbackMessage.mock.calls).toEqual([['s1', '42']])
    expect(state.contexts).toEqual([{ electron: 's1' }])
    expect(state.seenInside).toEqual([{ electron: 's1' }])
  })

  it('P3-10b-11 没有可回退的目标（拒绝 / 旧格式 / 不规范的 id —— 网关答 false）→ {success:false}', async () => {
    state.rollbackMessage.mockResolvedValue(false)
    expect(
      await invoke('message:rollback', { sessionId: 's1', messageId: 'no-such-message' })
    ).toEqual({ success: false })
    expect(state.contexts).toEqual([{ electron: 's1' }])
  })

  it('P3-10b-11 运行时抛错 → 处理函数原样拒绝', async () => {
    const boom = new Error('boom')
    state.rollbackMessage.mockRejectedValue(boom)
    await expect(invoke('message:rollback', { sessionId: 's1', messageId: '42' })).rejects.toBe(
      boom
    )
  })
})
