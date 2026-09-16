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
  applyModel = vi.fn()
  requestUserInput = vi.fn().mockResolvedValue({ kind: 'ok' })
  getThinkingLevel = vi.fn().mockReturnValue('high')
  broadcast = vi.fn()
  /**
   * pi 原生 harness 的替身 —— createAgent 会把它登记进运行时注册中心。
   * 只需铺注册中心真正会碰的面：登记时 subscribe，取快照时那几个 getter。
   */
  piHarness = {
    subscribe: vi.fn().mockReturnValue(() => {}),
    getModel: vi.fn().mockReturnValue({ provider: 'p1', id: 'm1', contextWindow: 1000 }),
    getThinkingLevel: vi.fn().mockReturnValue('high'),
    getTools: vi.fn().mockReturnValue([]),
    getActiveTools: vi.fn().mockReturnValue([])
  }
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
  tools: ['read', 'grep', 'agent'],
  systemPrompt: 'BASE {{shuvix:persona}}',
  instructionFiles: ['AGENTS.md', 'CLAUDE.md']
}
const MODEL_CFG: SubAgentModelConfig = { provider: 'p1', model: 'm1', capabilities: {} }
const SPAWN: SpawnContext = {
  agentId: 'sub-1',
  depth: 1,
  parentAgentId: 'root-s',
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
  resolveProjectMemory: ReturnType<typeof vi.fn>
  resolveKnowledgeBases: ReturnType<typeof vi.fn>
  resolveProfileModel: ReturnType<typeof vi.fn>
  logger: {
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  fakeEnv: object
  transform: object
}

function makeHost(): HostBundle {
  const treeSession = { buildContextEntries: vi.fn().mockResolvedValue([]) }
  const resolveTools = vi.fn().mockResolvedValue([{ name: 'fake-tool' }])
  const logRequest = vi.fn().mockReturnValue('log-1')
  const eventSink = { broadcast: vi.fn(), hasUserInputCapability: () => true }
  const resolveInstruction = vi.fn().mockResolvedValue({ filename: 'CLAUDE.md', content: 'INS' })
  const resolveProjectPrompt = vi.fn().mockResolvedValue('PROJ-PROMPT')
  const resolveProjectMemory = vi.fn().mockResolvedValue('PROJ-MEMORY')
  // 知识库围栏 seam：只有档案的工具清单里有 `knowledge` 时才被调用
  //（PROFILE 不带这个工具 —— 既有用例零影响）
  const resolveKnowledgeBases = vi.fn().mockResolvedValue('KB-GUIDE')
  // 缺省不解析（返回 null = 档案模型当前不可用）；声明模型的用例各自 mockResolvedValue
  const resolveProfileModel = vi.fn().mockResolvedValue(null)
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const fakeEnv = { marker: 'node-env' }
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
    transformToolResult: transform as never,
    httpLog: { logRequest, updateUsage: vi.fn() },
    logger,
    resolveInstruction,
    resolveProjectPrompt,
    resolveProjectMemory,
    resolveKnowledgeBases
  }
  return {
    host,
    resolveTools,
    logRequest,
    eventSink,
    treeSession,
    resolveInstruction,
    resolveProjectPrompt,
    resolveProjectMemory,
    resolveKnowledgeBases,
    resolveProfileModel,
    logger,
    fakeEnv,
    transform
  }
}

beforeEach(() => {
  constructed.length = 0
})

describe('createAgentFactory — root 决策列', () => {
  it('root:落盘树/宿主 env/原样 eventSink/autoCompact/transform/onPayload 归自身', async () => {
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
    expect(deps.transformToolResult).toBe(b.transform)
    expect(deps.onPromptAccepted).toBe(onPromptAccepted)
    expect(deps.thinkingLevel).toBe('medium')
    // 清单非空 → 指令文件带围栏 append 在基座后（项目提示词开关未开不追加）
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
  })

  it('resolveTools 请求:归一名单保序去重、root overlay 只收 mcp:/skill:、root 身份、requestUserInput 达自身运行时', async () => {
    const b = makeHost()
    await createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile: PROFILE,
      model: MODEL_CFG,
      cwd: '/w',
      // bash 不在档案白名单里：勾选里混进的内置名不能借 overlay 越过档案
      toolOverlay: ['mcp:ctx', 'bash', 'skill:pdf', 'mcp:ctx']
    })
    const req = b.resolveTools.mock.calls[0][0] as ToolResolveRequest
    expect(req.kind).toBe('root')
    expect(req.rootSessionId).toBe('s1')
    expect(req.selfSessionId).toBe('s1')
    expect(req.names).toEqual(['read', 'grep', 'agent', 'mcp:ctx', 'skill:pdf'])
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
      profile: { ...PROFILE, instructionFiles: [] },
      model: MODEL_CFG,
      thinkingLevel: 'off',
      cwd: '',
      spawn: SPAWN,
      spawnHelpers: { requestUserInput: helper }
    })
    return { created, helper }
  }

  it('spawned:内存树/stub env/包装 eventSink/无 transform/onPayload 归根会话', async () => {
    const b = makeHost()
    await createSpawned(b)
    const deps = constructed[0].deps

    expect(b.host.openSessionTree).not.toHaveBeenCalled()
    expect(deps.session).not.toBe(b.treeSession) // 内存树(真 Session 实例)
    expect(deps.env).not.toBe(b.fakeEnv)
    expect(deps.autoCompact).toBe(false)
    expect(deps.broadcastUserMessages).toBe(false)
    expect(deps.transformToolResult).toBeUndefined()
    expect(deps.onPromptAccepted).toBeUndefined()
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

  it('上下文注入:清单为空/开关关闭 → 不解析、系统提示词纯基座', async () => {
    const b = makeHost()
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's2',
      profile: { ...PROFILE, instructionFiles: [] },
      model: MODEL_CFG,
      cwd: '/w'
    })
    expect(b.resolveInstruction).not.toHaveBeenCalled()
    expect(b.resolveProjectPrompt).not.toHaveBeenCalled()
    expect(b.resolveProjectMemory).not.toHaveBeenCalled()
    expect(created.systemPrompt).toBe('BASE PERSONA')
  })

  it('上下文注入:spawned 全开 → 按根会话 id 解析、按序 append(指令文件→项目提示词→项目记忆)', async () => {
    const b = makeHost()
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'spawned',
      sessionId: 'sub-9',
      profile: { ...PROFILE, projectAwareness: true },
      model: MODEL_CFG,
      thinkingLevel: 'off',
      cwd: '',
      spawn: SPAWN,
      spawnHelpers: { requestUserInput: vi.fn() }
    })
    // 派生解析恒用根会话 id（spawn.rootSessionId），而非自身 agentId
    // 档案清单原样透传给宿主 —— 「读哪些文件」的决定权全在档案
    expect(b.resolveInstruction).toHaveBeenCalledWith('root-s', '', ['AGENTS.md', 'CLAUDE.md'])
    // 项目感知是一个开关带两段注入 —— 提示词与记忆索引同开同关
    expect(b.resolveProjectPrompt).toHaveBeenCalledWith('root-s')
    expect(b.resolveProjectMemory).toHaveBeenCalledWith('root-s')
    // 直接 append 到系统提示词,不落任何消息；三段各自被围栏包住
    const expected =
      'BASE PERSONA\n\n' +
      '<project_instructions file="CLAUDE.md">\nINS\n</project_instructions>\n\n' +
      '<project_prompt>\nPROJ-PROMPT\n</project_prompt>\n\n' +
      '<project_memory>\nPROJ-MEMORY\n</project_memory>'
    expect(created.systemPrompt).toBe(expected)
    expect(constructed[constructed.length - 1].deps.systemPrompt).toBe(expected)
    // resolveTools 收到的也是完整系统提示词（扩展默认子代理继承它）
    const req = b.resolveTools.mock.calls[0][0] as ToolResolveRequest
    expect(req.systemPrompt).toBe(expected)
  })
})

describe('createAgentFactory —— 指令文件注入的接缝口径', () => {
  /** root 创建的固定形状；profile 由各用例就地覆盖 */
  function createRoot(
    b: HostBundle,
    profile: InProcessAgentType
  ): Promise<Awaited<ReturnType<AgentFactory['createAgent']>>> {
    return createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile,
      model: MODEL_CFG,
      cwd: '/w'
    })
  }

  it('IF-U-17 root 列同样按档案清单解析：(sessionId, cwd, 清单) 恰调一次，清单原样透传', async () => {
    const b = makeHost()
    await createRoot(b, PROFILE)

    // 派生列早有防线（见「上下文注入:spawned 全开」），root 列这条同样要钉 ——
    // 「读哪些文件」的决定权全在档案，两列都不得夹带宿主自己的候选名表
    expect(b.resolveInstruction).toHaveBeenCalledTimes(1)
    expect(b.resolveInstruction).toHaveBeenCalledWith('s1', '/w', ['AGENTS.md', 'CLAUDE.md'])

    // 顺序即优先级 —— createAgent 不排序、不去重、不截断，宿主收到的就是档案里写的
    const scrambled = ['z.md', 'a.md', 'z.md', 'docs/house.md']
    await createRoot(b, { ...PROFILE, instructionFiles: scrambled })
    expect(b.resolveInstruction.mock.calls[1][2]).toEqual(scrambled)
  })

  it('IF-U-18 宿主解析不出（null）→ 系统提示词逐字节等于纯基座（不留空围栏/尾随空行）', async () => {
    const b = makeHost()
    b.resolveInstruction.mockResolvedValue(null)
    const created = await createRoot(b, PROFILE)

    expect(created.systemPrompt).toBe('BASE PERSONA')
    expect(constructed[0].deps.systemPrompt).toBe('BASE PERSONA')
  })

  it('IF-U-19 命中了但内容为空串 → 同样不加围栏（空围栏比不注入更糟：模型会当成"项目没规矩"）', async () => {
    const b = makeHost()
    b.resolveInstruction.mockResolvedValue({ filename: 'X', content: '' })
    const created = await createRoot(b, PROFILE)

    expect(created.systemPrompt).toBe('BASE PERSONA')
    expect(created.systemPrompt).not.toContain('project_instructions')
  })

  it('IF-U-20 档案有清单但宿主没注入 resolveInstruction（可选注入）→ 不抛、纯基座', async () => {
    const b = makeHost()
    delete (b.host as { resolveInstruction?: unknown }).resolveInstruction

    const created = await createRoot(b, PROFILE)
    expect(created.runtime).toBeDefined()
    expect(created.systemPrompt).toBe('BASE PERSONA')
  })

  it('IF-U-21 档案未声明清单（undefined）→ 解析器零调用、不抛', async () => {
    const b = makeHost()
    const created = await createRoot(b, { ...PROFILE, instructionFiles: undefined })

    expect(b.resolveInstruction).not.toHaveBeenCalled()
    expect(created.systemPrompt).toBe('BASE PERSONA')
  })
})

/**
 * 知识库围栏 `<knowledge_bases>` —— 这条会话手头有哪几个库。
 *
 * 它**不跟项目感知走**（那是「知不知道自己在哪个项目里」，与库无关：不属于任何项目的会话照样有
 * 用户自己的库）。唯一的门是**档案的工具清单里有没有 `knowledge`** —— 这段文案通篇是那个工具的
 * 用法，档案不带它时注入就是在教一个够不着的东西。位置钉在项目提示词之后、项目记忆之前：前者
 * 是在用的库，后者是只读的旧档，旧档的表头指回前者。
 */
describe('createAgentFactory —— 知识库围栏（KB-U）', () => {
  const KB_FENCE = '<knowledge_bases>\nKB-GUIDE\n</knowledge_bases>'
  /** 带 knowledge 工具的档案；注入开关由各用例覆盖 */
  const KB_PROFILE: InProcessAgentType = {
    ...PROFILE,
    tools: [...PROFILE.tools, 'knowledge'],
    instructionFiles: []
  }

  function createRoot(
    b: HostBundle,
    profile: InProcessAgentType
  ): Promise<Awaited<ReturnType<AgentFactory['createAgent']>>> {
    return createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile,
      model: MODEL_CFG,
      cwd: '/w'
    })
  }

  it('KB-U-1 围栏不跟项目感知走：项目感知关着、档案带 knowledge → 照样注入', async () => {
    const b = makeHost()
    const created = await createRoot(b, { ...KB_PROFILE, projectAwareness: false })

    expect(b.resolveKnowledgeBases).toHaveBeenCalledTimes(1)
    expect(b.resolveKnowledgeBases).toHaveBeenCalledWith('s1')
    expect(created.systemPrompt).toBe(`BASE PERSONA\n\n${KB_FENCE}`)
    // 项目感知那两段确实没被顺带打开
    expect(b.resolveProjectPrompt).not.toHaveBeenCalled()
    expect(b.resolveProjectMemory).not.toHaveBeenCalled()
  })

  it('KB-U-2 唯一的门是工具清单：档案不带 knowledge（项目感知全开）→ seam 零调用、无围栏', async () => {
    const b = makeHost()
    const created = await createRoot(b, {
      ...PROFILE,
      instructionFiles: [],
      projectAwareness: true
    })

    expect(b.resolveKnowledgeBases).not.toHaveBeenCalled()
    expect(created.systemPrompt).not.toContain('knowledge_bases')
    // 对照：同一次创建里项目提示词 / 记忆照常 —— 少的只有围栏这一段
    expect(created.systemPrompt).toBe(
      'BASE PERSONA\n\n' +
        '<project_prompt>\nPROJ-PROMPT\n</project_prompt>\n\n' +
        '<project_memory>\nPROJ-MEMORY\n</project_memory>'
    )
  })

  it('KB-U-3 四段注入顺序钉板：指令文件 → 项目提示词 → 知识库 → 项目记忆；派生按根会话 id 解析', async () => {
    const b = makeHost()
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'spawned',
      sessionId: 'sub-9',
      profile: {
        ...PROFILE,
        tools: [...PROFILE.tools, 'knowledge'],
        projectAwareness: true
      },
      model: MODEL_CFG,
      thinkingLevel: 'off',
      cwd: '',
      spawn: SPAWN,
      spawnHelpers: { requestUserInput: vi.fn() }
    })

    const expected =
      'BASE PERSONA\n\n' +
      '<project_instructions file="CLAUDE.md">\nINS\n</project_instructions>\n\n' +
      '<project_prompt>\nPROJ-PROMPT\n</project_prompt>\n\n' +
      `${KB_FENCE}\n\n` +
      '<project_memory>\nPROJ-MEMORY\n</project_memory>'
    expect(created.systemPrompt).toBe(expected)
    expect(constructed[constructed.length - 1].deps.systemPrompt).toBe(expected)
    // 派生 agent 既无会话也无项目：库按**根会话**解析（与其余三段同口径）
    expect(b.resolveKnowledgeBases).toHaveBeenCalledTimes(1)
    expect(b.resolveKnowledgeBases).toHaveBeenCalledWith('root-s')
  })

  it('KB-U-4 解析出 null / 纯空白 → 不加空围栏', async () => {
    for (const value of [null, '   \n\t']) {
      const b = makeHost()
      b.resolveKnowledgeBases.mockResolvedValue(value)
      const created = await createRoot(b, { ...KB_PROFILE, projectAwareness: false })
      // 空围栏比不注入更糟：模型会当成「这条会话一个库都没有，但好像应该有」
      expect(created.systemPrompt, JSON.stringify(value)).toBe('BASE PERSONA')
      expect(constructed[constructed.length - 1].deps.systemPrompt).toBe('BASE PERSONA')
    }
  })

  it('KB-U-5 宿主没实现这个可选 seam → 不抛、纯基座（即便档案带 knowledge）', async () => {
    const b = makeHost()
    delete (b.host as { resolveKnowledgeBases?: unknown }).resolveKnowledgeBases

    const created = await createRoot(b, { ...KB_PROFILE, projectAwareness: false })
    expect(created.runtime).toBeDefined()
    expect(created.systemPrompt).toBe('BASE PERSONA')
  })
})

/**
 * `systemContext` —— 调用方随本次创建给的上下文块（已围栏）。与项目注入同一机制、不同来源：
 * 项目注入按会话解析，这些块由调用方给（bot 会话把绑定的 bot md 正文交给根 Agent，见
 * renderBotContext；派发路径经 RunTaskParams.systemContext → manager.runTask 带到这里）。
 * createAgent 只做一件事：逐块以空行分隔追加在**项目注入之后**，空白块跳过。
 */
describe('createAgentFactory —— systemContext（调用方追加的上下文块）', () => {
  const BLOCK_A = '<bot_profile name="scout" file="/b/scout.md">\nP\n</bot_profile>'
  const BLOCK_B = '<extra>\nE\n</extra>'
  /** spawned 全开时的系统提示词（「上下文注入:spawned 全开」那条钉过的形状） */
  const FULL_APPENDS =
    'BASE PERSONA\n\n' +
    '<project_instructions file="CLAUDE.md">\nINS\n</project_instructions>\n\n' +
    '<project_prompt>\nPROJ-PROMPT\n</project_prompt>\n\n' +
    '<project_memory>\nPROJ-MEMORY\n</project_memory>'

  function spawnFull(
    b: HostBundle,
    systemContext?: readonly string[]
  ): Promise<Awaited<ReturnType<AgentFactory['createAgent']>>> {
    return createAgentFactory(b.host).createAgent({
      kind: 'spawned',
      sessionId: 'sub-9',
      profile: { ...PROFILE, projectAwareness: true },
      model: MODEL_CFG,
      thinkingLevel: 'off',
      cwd: '',
      spawn: SPAWN,
      spawnHelpers: { requestUserInput: vi.fn() },
      systemContext
    })
  }

  it('CTX-1 各块按序追加在项目注入之后，逐块以空行分隔；deps 与 resolveTools 收到同一份', async () => {
    const b = makeHost()
    const created = await spawnFull(b, [BLOCK_A, BLOCK_B])
    const expected = `${FULL_APPENDS}\n\n${BLOCK_A}\n\n${BLOCK_B}`
    expect(created.systemPrompt).toBe(expected)
    expect(constructed[constructed.length - 1].deps.systemPrompt).toBe(expected)
    expect((b.resolveTools.mock.calls[0][0] as ToolResolveRequest).systemPrompt).toBe(expected)
  })

  it('CTX-2 空白块跳过（不留空段落）；块两端空白被 trim', async () => {
    const b = makeHost()
    const created = await spawnFull(b, ['', '   \n\t', `\n  ${BLOCK_A}  \n`])
    expect(created.systemPrompt).toBe(`${FULL_APPENDS}\n\n${BLOCK_A}`)
  })

  it('CTX-3 不传 / 空数组 / 全是空白块 → 系统提示词逐字节不变', async () => {
    for (const systemContext of [undefined, [], ['', '  ']]) {
      const b = makeHost()
      const created = await spawnFull(b, systemContext)
      expect(created.systemPrompt, JSON.stringify(systemContext)).toBe(FULL_APPENDS)
    }
  })

  it('CTX-4 root 列同样追加（与项目注入同一机制，不分 root/spawned）', async () => {
    const b = makeHost()
    const created = await createAgentFactory(b.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile: { ...PROFILE, instructionFiles: [] },
      model: MODEL_CFG,
      cwd: '/w',
      systemContext: [BLOCK_A]
    })
    expect(created.systemPrompt).toBe(`BASE PERSONA\n\n${BLOCK_A}`)
    expect(constructed[0].deps.systemPrompt).toBe(`BASE PERSONA\n\n${BLOCK_A}`)
  })
})

/**
 * 扩展能力（mcp:/skill:）的 overlay —— 会话设置里的勾选，**只在创建这一刻读一次**。
 *
 * root：档案里声明的 mcp:/skill: 不直接生效（它们是子会话钉档案时的种子，最终以勾选为准），
 * 勾选里只有 mcp:/skill: 进得来；spawned 没有勾选，档案即全部。产物上不再有换工具的入口 ——
 * 宿主在运行时存在期间把勾选锁成只读，靠的正是「运行期换不了」这条。
 */
describe('createAgentFactory —— 扩展能力 overlay（EXT-U-5）', () => {
  const EXT_PROFILE: InProcessAgentType = {
    ...PROFILE,
    tools: ['read', 'mcp:prof', 'skill:prof', 'agent']
  }
  /** 首次 resolveTools 请求里的归一名单 */
  const namesOf = (b: HostBundle): readonly string[] =>
    (b.resolveTools.mock.calls[0][0] as ToolResolveRequest).names

  it('EXT-U-5 root 以勾选为准（档案的 mcp:/skill: 让位）、不带勾选只剩内置名；spawned 取档案全量；产物没有 applyToolOverlay', async () => {
    const withOverlay = makeHost()
    const created = await createAgentFactory(withOverlay.host).createAgent({
      kind: 'root',
      sessionId: 's1',
      profile: EXT_PROFILE,
      model: MODEL_CFG,
      cwd: '/w',
      toolOverlay: ['skill:sel']
    })
    expect(namesOf(withOverlay)).toEqual(['read', 'agent', 'skill:sel'])

    // 没有勾选 = 一个扩展能力都不带：档案里的 mcp:prof / skill:prof 不会借白名单溜回来
    const bare = makeHost()
    await createAgentFactory(bare.host).createAgent({
      kind: 'root',
      sessionId: 's2',
      profile: EXT_PROFILE,
      model: MODEL_CFG,
      cwd: '/w'
    })
    expect(namesOf(bare)).toEqual(['read', 'agent'])

    const spawned = makeHost()
    await createAgentFactory(spawned.host).createAgent({
      kind: 'spawned',
      sessionId: 'sub-1',
      profile: EXT_PROFILE,
      model: MODEL_CFG,
      thinkingLevel: 'off',
      cwd: '',
      spawn: SPAWN,
      spawnHelpers: { requestUserInput: vi.fn() }
    })
    expect(namesOf(spawned)).toEqual(['read', 'mcp:prof', 'skill:prof', 'agent'])

    // 运行期换工具的入口已删：谁把它加回来，「运行时存在期间勾选只读」就不再成立
    expect('applyToolOverlay' in created).toBe(false)
  })
})
