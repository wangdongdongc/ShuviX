/**
 * agentHandlers —— 会话模型、销毁运行时与工具列表的 IPC 透传（ML-U-8）。
 *
 *   ML-U-8a `agent:setModel` 只把 `(sessionId, provider, model)` 交给网关 —— 载荷里夹带的
 *           baseUrl / apiProtocol（旧前端的热切换覆盖值）不再往下传；网关答 true / false →
 *           `{ success: true / false }`（false = 会话已有运行时，什么也没写）；
 *   ML-U-8b 网关 reject → handler reject（不吞成 success，否则前端永远以为写进去了）；
 *   ML-U-8c `agent:destroy` 调 `destroyAgent(sid)`，等它落定才回 `{ success: true }`；
 *   ML-U-8d `tools:list` 原样转发 `(sessionId, options)` —— 欢迎页的 `(undefined, {profile:'chat'})`
 *           与会话里的 `(sid)` 都一样。
 *
 * electron 是替身（handle 收进 Map）；`../frontend` 只替到网关与 operationContext 那一层，handler
 * import 的其余重模块（工具注册表、工具定义、AgentManager、监控）整个换成空壳。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  gateway: {
    setModel: vi.fn<(sessionId: string, ...rest: unknown[]) => Promise<boolean>>(),
    destroyAgent: vi.fn<(sessionId: string) => Promise<void>>(),
    listTools: vi.fn<(sessionId?: string, options?: { profile?: string }) => unknown[]>()
  },
  contexts: [] as unknown[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      state.handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../frontend', () => ({
  chatGateway: state.gateway,
  operationContext: { run: (_ctx: unknown, fn: () => unknown) => fn() },
  createElectronContext: (sessionId?: string) => {
    state.contexts.push(sessionId)
    return { sessionId }
  }
}))
vi.mock('../../services/toolRegistry', () => ({ getBuiltinToolPresentations: vi.fn(() => ({})) }))
vi.mock('../../services/agentToolBuilder', () => ({ getBuiltinToolDefinitions: vi.fn(() => []) }))
vi.mock('../../agents/AgentManager', () => ({
  agentManager: { continueTask: vi.fn(), destroy: vi.fn(), interrupt: vi.fn() }
}))
vi.mock('../../services/agentMonitorService', () => ({
  getAgentRuntimeDetail: vi.fn(),
  listAgentRuntimes: vi.fn(() => [])
}))

import { registerAgentHandlers } from '../agentHandlers'

registerAgentHandlers()

/** 像渲染端 invoke 那样调一个已注册的处理函数 */
const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args)
}

const SID = 's1'

beforeEach(() => {
  state.gateway.setModel.mockReset().mockResolvedValue(true)
  state.gateway.destroyAgent.mockReset().mockResolvedValue(undefined)
  state.gateway.listTools.mockReset().mockReturnValue([{ name: 'read', label: 'read' }])
  state.contexts.length = 0
})

describe('ML-U-8a / 8b agent:setModel', () => {
  it('ML-U-8a 只转发 (sessionId, provider, model)：载荷夹带的 baseUrl / apiProtocol 不往下传', async () => {
    await invoke('agent:setModel', {
      sessionId: SID,
      provider: 'prov',
      model: 'm-b',
      baseUrl: 'https://evil.example/v1',
      apiProtocol: 'openai'
    })
    expect(state.gateway.setModel).toHaveBeenCalledTimes(1)
    expect(state.gateway.setModel.mock.calls[0]).toEqual([SID, 'prov', 'm-b'])
    expect(state.contexts).toEqual([SID])
  })

  it.each<[boolean]>([[true], [false]])('ML-U-8a 网关答 %s → { success: %s }', async (accepted) => {
    state.gateway.setModel.mockResolvedValue(accepted)
    await expect(
      invoke('agent:setModel', { sessionId: SID, provider: 'prov', model: 'm-b' })
    ).resolves.toEqual({ success: accepted })
  })

  it('ML-U-8b 网关 reject → handler reject（错误原样上交）', async () => {
    state.gateway.setModel.mockRejectedValue(new Error('tree write failed'))
    await expect(
      invoke('agent:setModel', { sessionId: SID, provider: 'prov', model: 'm-b' })
    ).rejects.toThrow('tree write failed')
  })
})

describe('ML-U-8c agent:destroy', () => {
  it('ML-U-8c 调 destroyAgent(sid)，等关停落定才回 { success: true }', async () => {
    let finish!: () => void
    state.gateway.destroyAgent.mockReturnValue(new Promise<void>((r) => (finish = r)))

    let result: unknown = 'pending'
    const pending = Promise.resolve(invoke('agent:destroy', SID)).then((r) => {
      result = r
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(state.gateway.destroyAgent).toHaveBeenCalledTimes(1)
    expect(state.gateway.destroyAgent.mock.calls[0]).toEqual([SID])
    expect(result).toBe('pending')

    finish()
    await pending
    expect(result).toEqual({ success: true })
    expect(state.contexts).toEqual([SID])
  })
})

describe('ML-U-8d tools:list', () => {
  it("ML-U-8d 欢迎页的 (undefined, {profile:'chat'}) 原样转发，回网关的列表", async () => {
    const result = await invoke('tools:list', undefined, { profile: 'chat' })
    expect(state.gateway.listTools).toHaveBeenCalledTimes(1)
    expect(state.gateway.listTools.mock.calls[0]).toEqual([undefined, { profile: 'chat' }])
    expect(result).toEqual([{ name: 'read', label: 'read' }])
  })

  it('ML-U-8d 会话里的 (sid) 原样转发：没有 options 就不造一个', async () => {
    await invoke('tools:list', SID)
    expect(state.gateway.listTools.mock.calls[0]).toEqual([SID, undefined])
    expect(state.contexts).toEqual([SID])
  })
})
