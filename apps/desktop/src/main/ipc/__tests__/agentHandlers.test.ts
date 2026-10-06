/**
 * agentHandlers —— 会话模型、销毁运行时与工具列表的 IPC 透传（ML-U-8）。
 *
 *   ML-U-8a `agent:setModel` 只把 `(sessionId, provider, model)` 交给网关 —— 载荷里夹带的
 *           baseUrl / apiProtocol（旧前端的热切换覆盖值）不再往下传；网关答 true / false →
 *           `{ success: true / false }`（false = 会话已有运行时，什么也没写）；
 *   ML-U-8b 网关 reject → handler reject（不吞成 success，否则前端永远以为写进去了）；
 *   ML-U-8c `agent:destroy` 调 `destroyAgent(sid)`，等它落定才回 `{ success: true }`；
 *   ML-U-8d `tools:list` 原样转发 `(sessionId, options)` —— 欢迎页的 `(undefined, {profile:'chat'})`
 *           与会话里的 `(sid)` 都一样；
 *   P2-05-39 派生 agent 的三个面板 IPC 按 agentId 交给路由：追问 fire-and-forget、中断 / 销毁等路由做完，
 *           路由的拒绝都只记日志（PIN-17）。
 *   P3-13-19 `agentMonitor:list` 把服务的结果原样交回（每行都是纯 JSON）。
 *   P3-06-31 `agent:getInfo` 在 `createElectronContext(sessionId)` 的请求上下文里把 `(sessionId, options)` 原样交给
 *           网关；网关的 null 原样交回。
 *   P3-08-60 `agent:respondToInput` 带上答题方 `ipc:<webContentsId>`（PIN-20），只交给网关，回 {success:true}。
 *   P3-11-07 `agent:withdrawQueued` 在 `createElectronContext(sessionId)` 的上下文里把 `(sessionId, submissionId)`
 *           交给网关，回 `{ result }`；`agent:nextTurn` 不再注册。
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
    listTools: vi.fn<(sessionId?: string, options?: { profile?: string }) => unknown[]>(),
    getAgentInfo: vi.fn<(sessionId: string, options?: { ensure?: boolean }) => Promise<unknown>>(),
    respondToInput: vi.fn(),
    withdrawQueued: vi.fn<(sessionId: string, submissionId: number) => Promise<string>>()
  },
  contexts: [] as unknown[],
  /** operationContext.run 的嵌套深度（>0 = 在请求上下文里） */
  runDepth: 0,
  router: {
    continueTask: vi.fn<(params: unknown) => Promise<void>>(),
    interrupt: vi.fn<(agentId: string) => Promise<void>>(),
    destroy: vi.fn<(agentId: string) => Promise<void>>()
  },
  warn: vi.fn()
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
  operationContext: {
    run: (_ctx: unknown, fn: () => unknown) => {
      state.runDepth++
      try {
        return fn()
      } finally {
        state.runDepth--
      }
    }
  },
  createElectronContext: (sessionId?: string) => {
    state.contexts.push(sessionId)
    return { sessionId }
  }
}))
vi.mock('../../services/toolRegistry', () => ({ getBuiltinToolPresentations: vi.fn(() => ({})) }))
vi.mock('../../services/agentToolBuilder', () => ({ getBuiltinToolDefinitions: vi.fn(() => []) }))
vi.mock('../../agents/AgentManager', () => ({ agentManager: state.router }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: state.warn, error: () => {} })
}))
vi.mock('../../services/agentMonitorService', () => ({
  getAgentRuntimeDetail: vi.fn(),
  listAgentRuntimes: vi.fn(async () => [])
}))

import type { AgentMonitorEntry } from '@shuvix/chat-protocol/types/agentMonitor'
import { listAgentRuntimes } from '../../services/agentMonitorService'
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

describe('P3-06-31 agent:getInfo', () => {
  const INFO = { systemPrompt: 'p', tools: [], messageCount: 0, isStreaming: false }

  beforeEach(() => {
    state.gateway.getAgentInfo.mockReset()
  })

  it('P3-06-31 (sessionId, options) 原样交给网关，且在 createElectronContext(sessionId) 的上下文里', async () => {
    const depths: number[] = []
    state.gateway.getAgentInfo.mockImplementation(async () => {
      depths.push(state.runDepth)
      return INFO
    })
    await expect(invoke('agent:getInfo', SID, { ensure: true })).resolves.toEqual(INFO)
    await expect(invoke('agent:getInfo', SID)).resolves.toEqual(INFO)
    expect(state.gateway.getAgentInfo.mock.calls).toEqual([
      [SID, { ensure: true }],
      [SID, undefined]
    ])
    expect(depths).toEqual([1, 1])
    expect(state.contexts).toEqual([SID, SID])
  })

  it('P3-06-31 网关答 null → null；网关 reject → handler reject', async () => {
    state.gateway.getAgentInfo.mockResolvedValue(null)
    await expect(invoke('agent:getInfo', SID, { ensure: true })).resolves.toBeNull()
    state.gateway.getAgentInfo.mockRejectedValue(new Error('tool host exploded'))
    await expect(invoke('agent:getInfo', SID, { ensure: true })).rejects.toThrow(
      'tool host exploded'
    )
  })
})

describe('P3-11-07 agent:withdrawQueued', () => {
  it('P3-11-07 (sessionId, submissionId) 交给网关、在请求上下文里；回 { result }', async () => {
    const depths: number[] = []
    state.gateway.withdrawQueued.mockReset().mockImplementation(async () => {
      depths.push(state.runDepth)
      return 'already_placed'
    })
    await expect(invoke('agent:withdrawQueued', { sessionId: SID, submissionId: 4 })).resolves.toEqual(
      { result: 'already_placed' }
    )
    expect(state.gateway.withdrawQueued.mock.calls).toEqual([[SID, 4]])
    expect(depths).toEqual([1])
    expect(state.contexts).toEqual([SID])
  })

  it('P3-11-07 「下一轮」的通道不再注册（Q-P3-09）', () => {
    expect([...state.handlers.keys()].filter((channel) => /turn/i.test(channel))).toEqual([])
    expect(state.handlers.has('agent:withdrawQueued')).toBe(true)
  })
})

describe('P2-05-39 派生 agent 面板 IPC 按 agentId 交给路由', () => {
  const TOKENS = { t1: { kind: 'skill', name: 'pdf' } }

  beforeEach(() => {
    state.router.continueTask.mockReset().mockResolvedValue(undefined)
    state.router.interrupt.mockReset().mockResolvedValue(undefined)
    state.router.destroy.mockReset().mockResolvedValue(undefined)
    state.warn.mockReset()
  })

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('agent:subAgentPrompt 同步答 {success:true}，continueTask 恰一次、参数原样', async () => {
    let settle!: () => void
    state.router.continueTask.mockReturnValue(new Promise<void>((resolve) => (settle = resolve)))
    const answer = invoke('agent:subAgentPrompt', {
      subSessionId: 'sub-1',
      text: 't',
      inlineTokens: TOKENS
    })
    // 不 await 整轮：处理函数直接交回结果对象，不是 Promise
    expect(answer).toEqual({ success: true })
    expect(state.router.continueTask).toHaveBeenCalledTimes(1)
    expect(state.router.continueTask).toHaveBeenCalledWith({
      subSessionId: 'sub-1',
      text: 't',
      inlineTokens: TOKENS
    })
    settle()
  })

  it('agent:subAgentPrompt 的 continueTask 拒绝：不成为未处理的拒绝，只记一条日志', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      state.router.continueTask.mockRejectedValue(new Error('Sub-session is busy: sub-1'))
      expect(invoke('agent:subAgentPrompt', { subSessionId: 'sub-1', text: 't' })).toEqual({
        success: true
      })
      await flush()
      await flush()
      expect(unhandled).not.toHaveBeenCalled()
      expect(state.warn).toHaveBeenCalledTimes(1)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it.each([
    ['subSession:interrupt', 'interrupt'],
    ['subSession:destroy', 'destroy']
  ] as const)(
    '%s 把 agentId 交给路由一次、等它做完再答 {success:true}',
    async (channel, method) => {
      let settle!: () => void
      state.router[method].mockReturnValue(new Promise<void>((resolve) => (settle = resolve)))
      let answered = false
      const pending = Promise.resolve(invoke(channel, 'sub-1')).then((value) => {
        answered = true
        return value
      })
      await flush()
      expect(state.router[method]).toHaveBeenCalledTimes(1)
      expect(state.router[method]).toHaveBeenCalledWith('sub-1')
      expect(answered).toBe(false)
      settle()
      expect(await pending).toEqual({ success: true })
    }
  )

  it.each([
    ['subSession:interrupt', 'interrupt'],
    ['subSession:destroy', 'destroy']
  ] as const)(
    '%s 路由拒绝 → 照样答 {success:true}（PIN-17），记一条日志',
    async (channel, method) => {
      state.router[method].mockRejectedValue(new Error('boom'))
      expect(await invoke(channel, 'sub-1')).toEqual({ success: true })
      expect(state.warn).toHaveBeenCalledTimes(1)
    }
  )

  it('三个处理函数都不打开会话、不碰网关', async () => {
    invoke('agent:subAgentPrompt', { subSessionId: 'sub-1', text: 't' })
    await invoke('subSession:interrupt', 'sub-1')
    await invoke('subSession:destroy', 'sub-1')
    expect(state.gateway.setModel).not.toHaveBeenCalled()
    expect(state.gateway.destroyAgent).not.toHaveBeenCalled()
    expect(state.gateway.listTools).not.toHaveBeenCalled()
    expect(state.contexts).toEqual([])
  })
})

describe('P3-08-60 agent:respondToInput 带上答题方', () => {
  it('webContents 7 的应答 → 网关收到 clientId ipc:7；在请求上下文里；回 {success:true}', async () => {
    const handler = state.handlers.get('agent:respondToInput')!
    const response = { kind: 'ask', allowed: true }
    await expect(
      Promise.resolve(handler({ sender: { id: 7 } }, { sessionId: SID, requestId: 'r', response }))
    ).resolves.toEqual({ success: true })
    expect(state.gateway.respondToInput.mock.calls).toEqual([
      [SID, 'r', response, { clientId: 'ipc:7' }]
    ])
    expect(state.contexts.at(-1)).toBe(SID)
  })
})

describe('P3-13-19 agentMonitor:list', () => {
  it('P3-13-19 returns the service result unchanged; every row survives structuredClone and a JSON round trip', async () => {
    const entry: AgentMonitorEntry = {
      agentId: SID,
      kind: 'root',
      rootSessionId: SID,
      depth: 0,
      profileName: 'work',
      displayName: 'Work',
      phase: 'interrupted',
      startedAt: 1,
      lastActivityAt: 2,
      queue: { steer: 1, followUp: 2 },
      model: { provider: 'faux', id: 'faux-1', contextWindow: 1000 },
      thinkingLevel: 'low',
      toolCount: 3,
      contextTokens: 40,
      cache: {
        input: 10,
        cacheRead: 5,
        cacheWrite: 0,
        reported: true,
        last: { input: 1, cacheRead: 0, cacheWrite: 0 }
      },
      cost: { total: 0.25 },
      sessionCost: 0.5,
      rootSessionTitle: 'T'
    }
    const spawned: AgentMonitorEntry = {
      ...entry,
      agentId: 'sub-1',
      kind: 'spawned',
      parentAgentId: SID,
      depth: 1,
      dispatch: 'hook',
      phase: 'turn',
      activeToolName: 'read'
    }
    const result = [entry, spawned]
    vi.mocked(listAgentRuntimes).mockResolvedValueOnce(result)
    const listed = (await invoke('agentMonitor:list')) as AgentMonitorEntry[]
    expect(listed).toBe(result)
    for (const row of listed) {
      expect(structuredClone(row)).toEqual(row)
      expect(JSON.parse(JSON.stringify(row))).toEqual(row)
    }
  })
})
