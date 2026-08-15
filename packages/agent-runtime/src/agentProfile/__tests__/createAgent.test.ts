/**
 * createAgentFactory 决策表单测 —— mock HarnessSession 捕获构造参数,
 * 逐项钉死 root/spawned 差异与现状等价(P3/P4 迁移的行为防线)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from '@earendil-works/pi-agent-core'
import type { Model, Api } from '@earendil-works/pi-ai'
import {
  createAgentFactory,
  type AgentFactory,
  type AgentHostAdapter,
  type ToolResolveRequest
} from '../createAgent'
import type { InProcessAgentType, SubAgentModelConfig } from '../../subagent/types'
import type { SpawnContext } from '../../subagent/manager'

// ── mock HarnessSession:捕获 deps + 暴露 CreatedAgent 用到的最小方法面 ──
const constructed: FakeHarness[] = []

class FakeHarness {
  deps: Record<string, unknown>
  session: unknown
  applyTools = vi.fn()
  applyModel = vi.fn()
  requestUserInput = vi.fn().mockResolvedValue({ kind: 'ok' })
  getThinkingLevel = vi.fn().mockReturnValue('high')
  broadcast = vi.fn()
  constructor(deps: Record<string, unknown>) {
    this.deps = deps
    this.session = deps.session
    constructed.push(this)
  }
}

vi.mock('../../harness/harnessSession', () => ({
  HarnessSession: vi.fn().mockImplementation(function (deps: Record<string, unknown>) {
    return new FakeHarness(deps)
  })
}))

// ── fakes ──
const PROFILE: InProcessAgentType = {
  name: 'default',
  displayName: 'Default',
  description: '',
  tools: ['read', 'grep', 'Agent'],
  systemPrompt: 'BASE {{shuvix:persona}}',
  instructionFiles: true
}
const MODEL_CFG: SubAgentModelConfig = { provider: 'p1', model: 'm1', capabilities: {} }
const SPAWN: SpawnContext = {
  agentId: 'sub-1',
  depth: 1,
  rootSessionId: 'root-s',
  modelConfig: MODEL_CFG,
  canSpawn: true
}

interface HostBundle {
  host: AgentHostAdapter
  resolveTools: ReturnType<typeof vi.fn>
  logRequest: ReturnType<typeof vi.fn>
  eventSink: { broadcast: ReturnType<typeof vi.fn>; hasUserInputCapability: () => boolean }
  treeSession: { buildContextEntries: ReturnType<typeof vi.fn> }
  resolveInstruction: ReturnType<typeof vi.fn>
  resolveProjectPrompt: ReturnType<typeof vi.fn>
  resolveProfileModel: ReturnType<typeof vi.fn>
  logger: {
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  fakeEnv: object
  hooks: object
  transform: object
}

function makeHost(): HostBundle {
  const treeSession = { buildContextEntries: vi.fn().mockResolvedValue([]) }
  const resolveTools = vi.fn().mockResolvedValue([{ name: 'fake-tool' }])
  const logRequest = vi.fn().mockReturnValue('log-1')
  const eventSink = { broadcast: vi.fn(), hasUserInputCapability: () => true }
  const resolveInstruction = vi.fn().mockResolvedValue({ filename: 'CLAUDE.md', content: 'INS' })
  const resolveProjectPrompt = vi.fn().mockResolvedValue('PROJ-PROMPT')
  // 缺省不解析（返回 null = 档案模型当前不可用）；声明模型的用例各自 mockResolvedValue
  const resolveProfileModel = vi.fn().mockResolvedValue(null)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const fakeEnv = { marker: 'node-env' }
  const hooks = { marker: 'hooks' }
  const transform = { marker: 'transform' }
  const host: AgentHostAdapter = {
    resolveTools,
    promptVars: () => ({ persona: 'PERSONA' }),
    buildModel: vi.fn((cfg: SubAgentModelConfig, extra?: object) => {
      return { provider: cfg.provider, id: cfg.model, extra } as unknown as Model<Api>
    }),
    resolveProfileModel,
    getApiKey: () => 'key',
    openSessionTree: vi.fn().mockResolvedValue(treeSession as unknown as Session),
    createExecutionEnv: vi.fn().mockReturnValue(fakeEnv),
    eventSink,
    shouldDeferToolDisplay: vi.fn().mockReturnValue(() => false),
    transformToolResult: transform as never,
    hooks: hooks as never,
    httpLog: { logRequest, updateUsage: vi.fn() },
    logger,
    resolveInstruction,
    resolveProjectPrompt
  }
  return {
    host,
    resolveTools,
    logRequest,
    eventSink,
    treeSession,
    resolveInstruction,
    resolveProjectPrompt,
    resolveProfileModel,
    logger,
    fakeEnv,
    hooks,
    transform
  }
}

beforeEach(() => {
  constructed.length = 0
})

describe('createAgentFactory — root 决策列', () => {
  it('root:落盘树/宿主 env/原样 eventSink/autoCompact/hook/transform/getCwd/onPayload 归自身', async () => {
    const b = makeHost()
    const onPromptAccepted = vi.fn()
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile: PROFILE,
      model: MODEL_CFG,
      thinkingLevel: 'medium',
      cwd: '/w',
      toolOverlay: ['mcp:ctx', 'read'],
      onPromptAccepted
    })
    const deps = constructed[0].deps

    expect(b.host.openSessionTree).toHaveBeenCalledWith('s1', '/w')
    expect(deps.session).toBe(b.treeSession)
    expect(deps.env).toBe(b.fakeEnv)
    expect(deps.eventSink).toBe(b.eventSink)
    expect(deps.autoCompact).toBe(true)
    expect(deps.broadcastUserMessages).toBeUndefined()
    expect(deps.hooks).toBe(b.hooks)
    expect(deps.transformToolResult).toBe(b.transform)
    expect(deps.onPromptAccepted).toBe(onPromptAccepted)
    expect(deps.thinkingLevel).toBe('medium')
    expect((deps.getCwd as () => string)()).toBe('/w')
    // instructionFiles=true → 指令文件带围栏 append 在基座后（项目提示词开关未开不追加）
    const fencedIns = '<project_instructions file="CLAUDE.md">\nINS\n</project_instructions>'
    expect(created.systemPrompt).toBe(`BASE PERSONA\n\n${fencedIns}`)
    expect(deps.systemPrompt).toBe(`BASE PERSONA\n\n${fencedIns}`)
    // onPayload 归属自身会话
    ;(deps.onPayload as (p: unknown, m: { provider: string; id: string }) => void)(
      { x: 1 },
      { provider: 'p1', id: 'm1' }
    )
    expect(b.logRequest).toHaveBeenCalledWith({
      sessionId: 's1',
      provider: 'p1',
      model: 'm1',
      payload: { x: 1 }
    })
    // shouldDeferToolDisplay 经宿主按会话构造
    expect(b.host.shouldDeferToolDisplay).toHaveBeenCalledWith('s1')
  })

  it('resolveTools 请求:归一名单保序去重、root 身份、requestUserInput 达自身运行时', async () => {
    const b = makeHost()
    await createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile: PROFILE,
      model: MODEL_CFG,
      cwd: '/w',
      toolOverlay: ['mcp:ctx', 'read', 'skill:pdf']
    })
    const req = b.resolveTools.mock.calls[0][0] as ToolResolveRequest
    expect(req.kind).toBe('root')
    expect(req.rootSessionId).toBe('s1')
    expect(req.selfSessionId).toBe('s1')
    expect(req.names).toEqual(['read', 'grep', 'Agent', 'mcp:ctx', 'skill:pdf'])
    expect(req.spawn).toBeUndefined()
    // root 的 requestUserInput 前向引用运行时
    await req.requestUserInput!({ kind: 'ask' } as never)
    expect(constructed[0].requestUserInput).toHaveBeenCalled()
  })
})

describe('createAgentFactory — spawned 决策列', () => {
  async function createSpawned(b: HostBundle): Promise<{
    created: Awaited<ReturnType<AgentFactory['createAgent']>>
    helper: ReturnType<typeof vi.fn>
  }> {
    const helper = vi.fn().mockResolvedValue({ kind: 'ok' })
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'spawned',
      sessionId: 'sub-1',
      profile: { ...PROFILE, instructionFiles: false },
      model: MODEL_CFG,
      thinkingLevel: 'off',
      cwd: '',
      spawn: SPAWN,
      spawnHelpers: { requestUserInput: helper }
    })
    return { created, helper }
  }

  it('spawned:内存树/stub env/包装 eventSink/无 hook/无 transform/onPayload 归根会话', async () => {
    const b = makeHost()
    await createSpawned(b)
    const deps = constructed[0].deps

    expect(b.host.openSessionTree).not.toHaveBeenCalled()
    expect(deps.session).not.toBe(b.treeSession) // 内存树(真 Session 实例)
    expect(deps.env).not.toBe(b.fakeEnv)
    expect(deps.autoCompact).toBe(false)
    expect(deps.broadcastUserMessages).toBe(false)
    expect(deps.hooks).toBeUndefined()
    expect(deps.transformToolResult).toBeUndefined()
    expect(deps.onPromptAccepted).toBeUndefined()
    expect(deps.getCwd).toBeUndefined()
    expect((deps.shouldDeferToolDisplay as () => boolean)()).toBe(true)
    // eventSink 包装:转发 broadcast、hasUserInputCapability 恒 false
    const sink = deps.eventSink as {
      broadcast: (e: unknown) => void
      hasUserInputCapability: () => boolean
    }
    sink.broadcast({ type: 'x' })
    expect(b.eventSink.broadcast).toHaveBeenCalledWith({ type: 'x' })
    expect(sink.hasUserInputCapability()).toBe(false)
    // onPayload 归根会话
    ;(deps.onPayload as (p: unknown, m: { provider: string; id: string }) => void)(
      {},
      { provider: 'p1', id: 'm1' }
    )
    expect(b.logRequest).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'root-s' }))
  })

  it('resolveTools 请求:spawn 身份 + helpers 的 requestUserInput 原样传递', async () => {
    const b = makeHost()
    const { helper } = await createSpawned(b)
    const req = b.resolveTools.mock.calls[0][0] as ToolResolveRequest
    expect(req.kind).toBe('spawned')
    expect(req.rootSessionId).toBe('root-s')
    expect(req.selfSessionId).toBe('sub-1')
    expect(req.spawn).toBe(SPAWN)
    expect(req.requestUserInput).toBe(helper)
  })

  it('缺 spawn 上下文即抛错', async () => {
    const b = makeHost()
    await expect(
      createAgentFactory(b.host).createAgent({
        kind: 'spawned',
        sessionId: 'sub-1',
        profile: PROFILE,
        model: MODEL_CFG,
        cwd: ''
      })
    ).rejects.toThrow('requires spawn context')
  })
})

describe('createAgentFactory — 档案模型（shuvix-model）', () => {
  const DECLARED: SubAgentModelConfig = {
    provider: 'p-declared',
    model: 'm-declared',
    capabilities: { reasoning: true }
  }

  /** 派生创建的固定形状；profile 由各用例就地覆盖 */
  function spawnWith(
    b: HostBundle,
    profile: InProcessAgentType,
    model: SubAgentModelConfig = { ...MODEL_CFG, thinkingLevel: 'low' }
  ): Promise<Awaited<ReturnType<AgentFactory['createAgent']>>> {
    return createAgentFactory(b.host).createAgent({
      kind: 'spawned',
      sessionId: 'sub-1',
      profile,
      model,
      thinkingLevel: 'off',
      cwd: '',
      spawn: SPAWN,
      spawnHelpers: { requestUserInput: vi.fn() }
    })
  }

  /** host.buildModel 的首次调用入参（= 传给 HarnessSession 的初始模型） */
  const firstBuildArg = (b: HostBundle): SubAgentModelConfig =>
    (b.host.buildModel as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as SubAgentModelConfig

  it('spawned + 档案模型可解析：以原样字符串调用一次解析器，初始模型全部来自解析产物', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(DECLARED)
    await spawnWith(b, { ...PROFILE, model: 'p-declared/m-declared' })

    expect(b.resolveProfileModel).toHaveBeenCalledTimes(1)
    expect(b.resolveProfileModel).toHaveBeenCalledWith('p-declared/m-declared')
    const arg = firstBuildArg(b)
    expect(arg.provider).toBe('p-declared')
    expect(arg.model).toBe('m-declared')
    expect(arg.capabilities).toEqual({ reasoning: true })
    expect(b.logger.warn).not.toHaveBeenCalled()
  })

  it('档案只表达「用哪个模型」：thinkingLevel 仍随派发方，不跟着档案走', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue({ ...DECLARED, thinkingLevel: 'high' })
    await spawnWith(b, { ...PROFILE, model: 'p-declared/m-declared' }, {
      ...MODEL_CFG,
      thinkingLevel: 'low'
    } as SubAgentModelConfig)

    expect(firstBuildArg(b).thinkingLevel).toBe('low')
  })

  it('spawned + 档案模型不可用：回落派发方模型、不抛错，且 warn 含档案名与原始声明值', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(null)
    await spawnWith(b, { ...PROFILE, name: 'explore', model: 'gone/model' })

    expect(firstBuildArg(b)).toEqual({ ...MODEL_CFG, thinkingLevel: 'low' })
    expect(b.logger.warn).toHaveBeenCalledTimes(1)
    const msg = String(b.logger.warn.mock.calls[0][0])
    expect(msg).toContain('explore')
    expect(msg).toContain('gone/model')
  })

  it('spawned + 未声明模型：解析器零调用，直接用派发方模型', async () => {
    const b = makeHost()
    await spawnWith(b, PROFILE)

    expect(b.resolveProfileModel).not.toHaveBeenCalled()
    expect(firstBuildArg(b)).toEqual({ ...MODEL_CFG, thinkingLevel: 'low' })
    expect(b.logger.warn).not.toHaveBeenCalled()
  })

  it('root + 档案声明了模型：解析器零调用，初始模型仍是会话传入值（会话树为准）', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(DECLARED)
    await createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile: { ...PROFILE, model: 'p-declared/m-declared' },
      model: MODEL_CFG,
      thinkingLevel: 'medium',
      cwd: '/w'
    })

    expect(b.resolveProfileModel).not.toHaveBeenCalled()
    expect(firstBuildArg(b)).toBe(MODEL_CFG)
    expect(b.logger.warn).not.toHaveBeenCalled()
  })

  it('档案模型生效后 getModelConfig() 返回档案模型（孙代理继承它，不是派发方模型）', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(DECLARED)
    const created = await spawnWith(b, { ...PROFILE, model: 'p-declared/m-declared' })

    expect(created.getModelConfig()).toEqual({
      ...DECLARED,
      thinkingLevel: 'high' // fake 运行时当前档位
    })
  })

  it('档案不粘住运行期：applyModel 之后 getModelConfig() 跟随后者', async () => {
    const b = makeHost()
    b.resolveProfileModel.mockResolvedValue(DECLARED)
    const created = await spawnWith(b, { ...PROFILE, model: 'p-declared/m-declared' })

    await created.applyModel({ provider: 'p9', model: 'm9', capabilities: {} })
    expect(created.getModelConfig()).toEqual({
      provider: 'p9',
      model: 'm9',
      capabilities: {},
      thinkingLevel: 'high'
    })
  })

  it('宿主未注入 resolveProfileModel（可选注入）：不抛错、回落派发方模型、不告警', async () => {
    const b = makeHost()
    // 「本端不支持档案模型」≠「这个模型不可用」——混为一谈会误导排障
    delete (b.host as { resolveProfileModel?: unknown }).resolveProfileModel

    const created = await spawnWith(b, { ...PROFILE, model: 'p-declared/m-declared' })
    expect(created.runtime).toBeDefined()
    expect(firstBuildArg(b)).toEqual({ ...MODEL_CFG, thinkingLevel: 'low' })
    expect(b.logger.warn).not.toHaveBeenCalled()
  })
})

describe('CreatedAgent 运行期操作', () => {
  it('getModelConfig 惰性:thinkingLevel 读运行时当前档位;applyModel 后 provider/model 跟随', async () => {
    const b = makeHost()
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile: PROFILE,
      model: MODEL_CFG,
      thinkingLevel: 'low',
      cwd: '/w'
    })
    expect(created.getModelConfig()).toEqual({ ...MODEL_CFG, thinkingLevel: 'high' }) // fake 运行时档位
    await created.applyModel({ provider: 'p2', model: 'm2', capabilities: {} }, { baseUrl: 'u' })
    expect(constructed[0].applyModel).toHaveBeenCalledTimes(1)
    expect(created.getModelConfig()).toEqual({
      provider: 'p2',
      model: 'm2',
      capabilities: {},
      thinkingLevel: 'high'
    })
  })

  it('applyToolOverlay:按新 overlay 重解析并 applyTools', async () => {
    const b = makeHost()
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile: PROFILE,
      model: MODEL_CFG,
      cwd: '/w',
      toolOverlay: ['mcp:a']
    })
    b.resolveTools.mockResolvedValueOnce([{ name: 't2' }])
    await created.applyToolOverlay(['mcp:b'])
    const req = b.resolveTools.mock.calls[1][0] as ToolResolveRequest
    expect(req.names).toEqual(['read', 'grep', 'Agent', 'mcp:b'])
    expect(constructed[0].applyTools).toHaveBeenCalledWith([{ name: 't2' }])
  })

  it('上下文注入:开关关闭 → 不解析、系统提示词纯基座', async () => {
    const b = makeHost()
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's2',
      profile: { ...PROFILE, instructionFiles: false },
      model: MODEL_CFG,
      cwd: '/w'
    })
    expect(b.resolveInstruction).not.toHaveBeenCalled()
    expect(b.resolveProjectPrompt).not.toHaveBeenCalled()
    expect(created.systemPrompt).toBe('BASE PERSONA')
  })

  it('上下文注入:spawned 全开 → 按根会话 id 解析、按序 append(指令文件→项目提示词)', async () => {
    const b = makeHost()
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'spawned',
      sessionId: 'sub-9',
      profile: { ...PROFILE, projectPrompt: true },
      model: MODEL_CFG,
      thinkingLevel: 'off',
      cwd: '',
      spawn: SPAWN,
      spawnHelpers: { requestUserInput: vi.fn() }
    })
    // 派生解析恒用根会话 id（spawn.rootSessionId），而非自身 agentId
    expect(b.resolveInstruction).toHaveBeenCalledWith('root-s', '')
    expect(b.resolveProjectPrompt).toHaveBeenCalledWith('root-s')
    // 直接 append 到系统提示词,不落任何消息；两段各自被围栏包住
    const expected =
      'BASE PERSONA\n\n' +
      '<project_instructions file="CLAUDE.md">\nINS\n</project_instructions>\n\n' +
      '<project_prompt>\nPROJ-PROMPT\n</project_prompt>'
    expect(created.systemPrompt).toBe(expected)
    expect(constructed[constructed.length - 1].deps.systemPrompt).toBe(expected)
    // resolveTools 收到的也是完整系统提示词（扩展默认子代理继承它）
    const req = b.resolveTools.mock.calls[0][0] as ToolResolveRequest
    expect(req.systemPrompt).toBe(expected)
  })
})
