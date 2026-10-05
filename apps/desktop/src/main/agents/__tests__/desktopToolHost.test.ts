/**
 * P1-11 —— 桌面 ToolHost（`createDesktopToolHost`）：内置工具、按 agent 解析（派发 / 技能 / MCP 惰性连接）、
 * 按锁重建、包装的选项、调用方身份（agentOf），以及留给旧调用方的 agentFactory。编号同设计稿
 * （docs/pi-durable/p1-11-test-design.md，H11-xx）。
 *
 * P2-06（docs/pi-durable/p2-06-test-design.md，P2-06-xx）：调用方身份按对话认人 —— ToolHost 经注入的
 * `sessionOf` 拿打开着的会话、问它的 `agentIdentity(对话)`（Fx-SH：FakeSessionHost 上可设的 `identities`）。
 * 由此喂 MCP 的 callerIdOf、知识库的章与门的主体。P2-06-12 用真 McpManager + SDK 的 InMemoryTransport
 * 与一台最小的 Server 看 `_meta` 的组成（PIN-07）。
 *
 * 本文件是「替身模式」：包装器换成记账的恒等桩（Fx-WRAP spy），SkillTool 换成按 findEnabled /
 * findAll 过滤名单的桩（构造实参可查），派发工具换成桩，mcpService 是 Fx-MCP 的 spy；注册表是**真的**
 * （Fx-REG：与真注册项同名、同平台的桩工厂）。真包装器 / 真 SkillTool / 真派发工具那几条在
 * desktopToolHost.real.test.ts，沙箱钉子在 desktopToolHost.sandbox.test.ts。
 *
 * ⚠️ SkillTool 桩自带过滤（`hasSkills` / `skillNames` 都由 findEnabled 决定）：一个空 `class {}` 会让
 * hasSkills 恒为 undefined、工具永不注入，用例全绿却什么都没测（见 skillToolInjection 的 mock 陷阱）。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock
} from 'vitest'
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'

interface SkillToolCall {
  args: unknown[]
}

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  requestUserInputFor: vi.fn(),
  statusByName: vi.fn(),
  ensureServerByName: vi.fn(),
  declarationsOf: vi.fn(),
  registrationsFromDeclarations: vi.fn(),
  getRegistrationsByServerName: vi.fn(),
  findEnabled: vi.fn(),
  findAll: vi.fn(),
  skillToolCalls: [] as SkillToolCall[],
  createAgentTool: vi.fn(),
  wrapCalls: [] as Array<{ tool: object; opts: Record<string, unknown>; wrapped: object }>,
  sandboxGloballyActive: vi.fn(),
  pick: vi.fn(),
  pickSettings: vi.fn(),
  projectPick: vi.fn(),
  getDesktopSecurityContext: vi.fn(),
  resolveProjectConfig: vi.fn(),
  findAllEnabledModels: vi.fn(),
  forSession: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../logger', () => ({ createLogger: () => mocks.log }))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { pick: mocks.pick, pickSettings: mocks.pickSettings }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: { findAllEnabledModels: mocks.findAllEnabledModels }
}))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../services/memory', () => ({ resolveProjectMemoryIndex: vi.fn() }))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: mocks.broadcast } }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: { broadcast: vi.fn() },
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: mocks.getDesktopSecurityContext,
  resolveProjectConfig: mocks.resolveProjectConfig
}))
vi.mock('../../services/userInputBroker', () => ({
  requestUserInputFor: mocks.requestUserInputFor
}))
vi.mock('../../services/sandbox', () => ({
  sandboxGloballyActive: mocks.sandboxGloballyActive
}))
vi.mock('../../services/botService', () => ({ botService: { forSession: mocks.forSession } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: vi.fn() }))
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    statusByName: mocks.statusByName,
    ensureServerByName: mocks.ensureServerByName,
    declarationsOf: mocks.declarationsOf,
    registrationsFromDeclarations: mocks.registrationsFromDeclarations,
    getRegistrationsByServerName: mocks.getRegistrationsByServerName
  }
}))
vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: mocks.findEnabled, findAll: mocks.findAll }
}))
/** SkillTool 桩：照真 SkillTool 的过滤（名单 ∩ 池，池 = findEnabled，或按锁重建时的 findAll） */
vi.mock('../../services/skillTool', () => ({
  SkillTool: class {
    readonly name = 'skill'
    readonly label = 'skill'
    readonly description: string
    readonly replay = 'unsafe'
    private readonly offered: string[]
    constructor(...args: unknown[]) {
      mocks.skillToolCalls.push({ args })
      const names = args[0] as string[]
      const pool = (args[2] === 'known' ? mocks.findAll() : mocks.findEnabled()) as {
        name: string
      }[]
      this.offered = pool.map((s) => s.name).filter((n) => names.includes(n))
      this.description = `skill: ${this.offered.join(', ')}`
    }
    get hasSkills(): boolean {
      return this.offered.length > 0
    }
    get skillNames(): string[] {
      return [...this.offered]
    }
  }
}))
vi.mock('../AgentTool', () => ({ createAgentTool: mocks.createAgentTool }))
/** Fx-WRAP spy：记下每一次包装（原工具、选项），交回一个叠在原工具上的新对象 */
vi.mock('../../services/wrapToolOutput', () => ({
  wrapDurableTool: (tool: object, opts: Record<string, unknown>) => {
    const wrapped = Object.create(tool) as object
    mocks.wrapCalls.push({ tool, opts, wrapped })
    return wrapped
  }
}))

import i18next from 'i18next'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import {
  composeAgentTools,
  isPhasePendingError,
  LAZY_CONNECT_TIMEOUT_MS,
  McpManager,
  type AgentIdentity,
  type LockRecord,
  type McpRegistrationOptions,
  type McpToolDeclaration,
  type ResolvedAgentTools,
  type SubAgentModelConfig,
  type ToolHost
} from '@shuvix/agent-runtime'
import type { ToolContext } from '../../services/toolContext'
import {
  FakeSessionHost,
  type FakeDurableSession
} from '../../services/__tests__/support/fakeSessionHost'
import { agentActorOf, withCallAgent } from '../../services/toolAgent'
import {
  getPlatformBuiltinToolEntries,
  registerBuiltinTool,
  unregisterBuiltinTool
} from '../../services/toolRegistry'
import { agentFactory, createDesktopToolHost, resolveProfileModelSpec } from '../agentHost'
import {
  D_C7,
  D_SSH,
  MCP_DECLS,
  MODEL,
  decl,
  deferred,
  factoryCalls,
  flush,
  inProcess,
  lockD,
  mcpRegistration,
  profileOf,
  registerStubBuiltins,
  requestD,
  restorePlatform,
  setPlatform,
  stubTool
} from './support/toolHostFixtures'

const DARWIN_BUILTINS = [
  'bash',
  'read',
  'write',
  'edit',
  'ask',
  'git',
  'artifact',
  'session',
  'knowledge',
  'doc_read',
  'doc_edit',
  'doc_insert',
  'ls',
  'grep',
  'glob'
]

const skill = (name: string): { name: string } => ({ name })

/**
 * Fx-SH（身份来源，P2-06）：假的会话宿主；ToolHost 经 `sessionOf`（spy）同步拿打开着的会话，按对话问它的
 * `agentIdentity`（没设的对话 = 锁的根身份，没锁 = undefined）。
 */
let fake: FakeSessionHost
let sessionOf: Mock<(sessionId: string) => FakeDurableSession | undefined>

/** 打开着的会话（没开就放一个进去） */
function sessionFor(sessionId = 's1'): FakeDurableSession {
  return fake.get(sessionId) ?? fake.put(sessionId)
}

/** 设 / 清这条会话的锁（会话没开就先打开） */
function setLock(sessionId: string, lock: LockRecord | undefined): FakeDurableSession {
  const session = sessionFor(sessionId)
  session.lock = lock
  return session
}

/** 一条 MCP 配置行（P2-06-12 的真 McpManager 用） */
function mcpRow(patch: Partial<McpServer> & { id: string; name: string }): McpServer {
  return {
    type: 'http',
    command: '',
    args: '[]',
    env: '{}',
    url: 'http://127.0.0.1/mcp',
    headers: '{}',
    metadata: '{}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[]',
    createdAt: 0,
    updatedAt: 0,
    ...patch
  }
}

/** 一份惰性模型配置（haiku） */
const haiku = (): SubAgentModelConfig => ({
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  capabilities: {}
})

/** s1 里各对话上的身份（每个用例新建，spy 不串） */
let SPAWN_E: AgentIdentity
let HOOK_R: AgentIdentity
let BARE: AgentIdentity

let host: ToolHost
let unregister: () => void

const names = (tools: readonly { name: string }[]): string[] => tools.map((t) => t.name)
const signal = (): AbortSignal => new AbortController().signal

/** 一次 registrationsFromDeclarations 调用的 callerIdOf */
function callerIdOfCall(i: number): (conversationId: number) => string | undefined {
  const opts = mocks.registrationsFromDeclarations.mock.calls[i][3] as McpRegistrationOptions
  return opts.callerIdOf as (conversationId: number) => string | undefined
}

/** 某个工具（包装后的对象）的包装选项 */
function wrapOf(tool: object): Record<string, unknown> {
  const call = mocks.wrapCalls.find((c) => c.wrapped === tool)
  expect(call, 'tool should be a wrapper return value').toBeDefined()
  return call!.opts
}

/** 包装选项里的 security 解析器，以一次假调用（对话 conversationId）求值；交回交给门面的 ctx */
function securityCtxOf(tool: object, conversationId = 1): ToolContext {
  const security = wrapOf(tool).security as (api: ToolExecutionApi, context: Context) => unknown
  mocks.getDesktopSecurityContext.mockClear()
  security(
    { conversationId, callId: 'c1', taskId: 1 } as unknown as ToolExecutionApi,
    {} as Context
  )
  expect(mocks.getDesktopSecurityContext).toHaveBeenCalledTimes(1)
  return mocks.getDesktopSecurityContext.mock.calls[0][0] as ToolContext
}

beforeAll(async () => {
  unregister = registerStubBuiltins()
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: 'en',
      resources: {
        en: { translation: { chat: { mcpConnectFailed: 'MCP {{name}} failed: {{error}}' } } }
      },
      showSupportNotice: false
    })
  }
})

afterAll(() => {
  unregister()
})

beforeEach(() => {
  setPlatform('darwin')
  fake = new FakeSessionHost()
  sessionOf = vi.fn((sessionId: string) => fake.get(sessionId))
  SPAWN_E = { profileName: 'explore', kind: 'spawned', callerId: 'sub-a1', getModelConfig: haiku }
  HOOK_R = {
    profileName: 'permission-reviewer',
    kind: 'spawned',
    callerId: 'sub-r1',
    getModelConfig: haiku
  }
  BARE = { profileName: 'explore', kind: 'spawned', callerId: 'sub-x' }
  factoryCalls.length = 0
  mocks.wrapCalls.length = 0
  mocks.skillToolCalls.length = 0
  for (const fn of [
    mocks.broadcast,
    mocks.requestUserInputFor,
    mocks.statusByName,
    mocks.ensureServerByName,
    mocks.declarationsOf,
    mocks.registrationsFromDeclarations,
    mocks.getRegistrationsByServerName,
    mocks.findEnabled,
    mocks.findAll,
    mocks.createAgentTool,
    mocks.sandboxGloballyActive,
    mocks.pick,
    mocks.pickSettings,
    mocks.projectPick,
    mocks.getDesktopSecurityContext,
    mocks.resolveProjectConfig,
    mocks.findAllEnabledModels,
    mocks.forSession,
    mocks.log.warn
  ]) {
    fn.mockReset()
  }
  mocks.statusByName.mockReturnValue('disconnected')
  mocks.ensureServerByName.mockResolvedValue({ ok: true })
  mocks.declarationsOf.mockImplementation((server: string) =>
    (MCP_DECLS[server] ?? []).map((d) => ({ ...d }))
  )
  mocks.registrationsFromDeclarations.mockImplementation(
    (server: string, _sid: string, decls: readonly McpToolDeclaration[]) =>
      decls.map((d) => mcpRegistration(server, d))
  )
  mocks.findEnabled.mockReturnValue([skill('builtin:drawing'), skill('pdf'), skill('other')])
  mocks.findAll.mockReturnValue([skill('builtin:drawing'), skill('pdf'), skill('other')])
  mocks.createAgentTool.mockImplementation(() => stubTool('agent'))
  mocks.sandboxGloballyActive.mockReturnValue(false)
  mocks.pick.mockReturnValue({ projectId: 'p1' })
  mocks.projectPick.mockReturnValue({ name: 'Proj', path: '/w/proj', systemPrompt: 'Be terse.' })
  mocks.getDesktopSecurityContext.mockImplementation(() => ({ sentinel: 'gate' }))
  mocks.findAllEnabledModels.mockReturnValue([])
  mocks.resolveProjectConfig.mockReturnValue({ workingDirectory: '/w/proj' })
  host = createDesktopToolHost({ sessionOf })
})

afterEach(() => {
  restorePlatform()
})

// ─── 内置工具 ───────────────────────────────────────────────────────────

describe('buildBuiltinTools', () => {
  it('H11-01 darwin：注册表里本平台有工厂的全部内置工具，注册表次序；没有 powershell / skill / agent，不按档案过滤', async () => {
    const tools = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    const expected = getPlatformBuiltinToolEntries()
      .filter((e) => e.factory)
      .map((e) => e.name)
    expect(names(tools)).toEqual(expected)
    expect(names(tools)).toEqual(DARWIN_BUILTINS)
    for (const absent of ['powershell', 'skill', 'agent'])
      expect(names(tools)).not.toContain(absent)
  })

  it.each([
    ['linux', 'bash', 'powershell'],
    ['win32', 'powershell', 'bash']
  ])('H11-02 %s：有 %s、没有 %s', async (platform, present, absent) => {
    setPlatform(platform)
    const tools = names(await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false }))
    expect(tools).toContain(present)
    expect(tools).not.toContain(absent)
  })

  it('H11-03 一个会话级 ToolContext：每个工厂拿到同一个 ctx（sessionId s1、没有 agent、有 agentOf）；emitChatEvent / requestUserInput 归 s1', async () => {
    await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    expect(factoryCalls.length).toBeGreaterThan(1)
    const ctx = factoryCalls[0].ctx
    for (const call of factoryCalls) expect(call.ctx).toBe(ctx)
    expect(ctx.sessionId).toBe('s1')
    expect(ctx.agent).toBeUndefined()
    expect(ctx.agentOf).toBeTypeOf('function')

    ctx.emitChatEvent!({ type: 'mcp_connecting', server: 'x', connecting: true })
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: 'mcp_connecting',
      server: 'x',
      connecting: true,
      sessionId: 's1'
    })

    const answer = Promise.resolve({ kind: 'cancel' })
    mocks.requestUserInputFor.mockReturnValue(answer)
    const question = { kind: 'ask', requestId: 'q1' } as never
    expect(ctx.requestUserInput!(question)).toBe(answer)
    expect(mocks.requestUserInputFor).toHaveBeenCalledWith('s1', question)
  })

  it('H11-04 / P2-06-28 打开时那一次是纯本地的：不碰 MCP / 技能 / 会话宿主 / 广播；会话行不存在也照常', async () => {
    mocks.pick.mockReturnValue(undefined)
    setLock('s1', lockD())
    const get = vi.spyOn(fake, 'get')
    const tools = await host.buildBuiltinTools({ sessionId: 's1' })
    expect(names(tools)).toEqual(DARWIN_BUILTINS)
    for (const fn of [
      mocks.statusByName,
      mocks.ensureServerByName,
      mocks.declarationsOf,
      mocks.registrationsFromDeclarations,
      mocks.getRegistrationsByServerName,
      mocks.findEnabled,
      mocks.broadcast
    ]) {
      expect(fn).not.toHaveBeenCalled()
    }
    expect(sessionOf).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('H11-05 / P2-06-28 每次都是新实例、会话之间互不相干：s2 的 ctx 归 s2，它的 agentOf 只问 sessionOf(s2)', async () => {
    const first = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    const firstCtx = factoryCalls[0].ctx
    factoryCalls.length = 0
    const second = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    const secondCtx = factoryCalls[0].ctx
    for (const tool of second) expect(first).not.toContain(tool)
    expect(secondCtx).not.toBe(firstCtx)

    factoryCalls.length = 0
    await host.buildBuiltinTools({ sessionId: 's2', sandboxed: false })
    const s2 = factoryCalls[0].ctx
    expect(s2.sessionId).toBe('s2')
    expect(sessionOf).not.toHaveBeenCalled()
    s2.agentOf!(1)
    expect(sessionOf.mock.calls).toEqual([['s2']])
  })

  it('H11-06 一个工厂抛错：其余照装、没有它，记一条点名它的警告（PIN-05）', async () => {
    registerBuiltinTool({
      name: 'boom',
      group: 'general',
      getLabel: () => 'boom',
      getHint: () => 'boom',
      factory: () => {
        throw new Error('kaboom')
      }
    })
    try {
      const tools = names(await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false }))
      expect(tools).toEqual(DARWIN_BUILTINS)
      expect(mocks.log.warn).toHaveBeenCalledTimes(1)
      expect(String(mocks.log.warn.mock.calls[0][0])).toContain('boom')
    } finally {
      unregisterBuiltinTool('boom')
    }
  })
})

// ─── resolveAgentTools ─────────────────────────────────────────────────

describe('resolveAgentTools', () => {
  it('H11-14 结果的完整形状：agent、skill、两台 MCP（声明 + 工具）、skills、沙箱布尔；不含任何内置工具', async () => {
    const resolved = await host.resolveAgentTools(requestD(), { signal: signal() })
    expect(resolved.agent?.name).toBe('agent')
    expect(resolved.skill?.name).toBe('skill')
    expect(resolved.mcp?.map((m) => m.server)).toEqual(['context7', 'ssh'])
    expect(resolved.mcp?.[0].declarations).toEqual(D_C7)
    expect(resolved.mcp?.[0].tools).toHaveLength(2)
    expect(resolved.mcp?.[1].declarations).toEqual(D_SSH)
    expect(resolved.mcp?.[1].tools).toHaveLength(5)
    expect(resolved.skills).toEqual(['builtin:drawing', 'pdf'])
    expect(resolved.tools ?? []).toEqual([])
    expect(resolved.extraTools ?? []).toEqual([])
    expect(typeof resolved.sandboxed).toBe('boolean')

    const all = [
      resolved.agent!,
      resolved.skill!,
      ...resolved.mcp!.flatMap((m) => m.tools),
      ...(resolved.tools ?? []),
      ...(resolved.extraTools ?? [])
    ]
    for (const builtin of DARWIN_BUILTINS) expect(names(all)).not.toContain(builtin)
  })

  it('H11-15 派发工具：名单含 agent → createAgentTool 一次（ctx 归 s1、询问经 broker），模型配置取锁定的模型 + 思考档位；不含 → 不造（PIN-08）', async () => {
    const resolved = await host.resolveAgentTools(requestD(), { signal: signal() })
    expect(resolved.agent).toBeDefined()
    expect(mocks.createAgentTool).toHaveBeenCalledTimes(1)
    const [ctx, agentCtx] = mocks.createAgentTool.mock.calls[0] as [
      ToolContext,
      { rootSessionId: string; modelConfig: unknown }
    ]
    expect(ctx.sessionId).toBe('s1')
    const question = { kind: 'ask', requestId: 'q2' } as never
    ctx.requestUserInput!(question)
    expect(mocks.requestUserInputFor).toHaveBeenCalledWith('s1', question)
    expect(agentCtx.rootSessionId).toBe('s1')
    const config =
      typeof agentCtx.modelConfig === 'function' ? agentCtx.modelConfig() : agentCtx.modelConfig
    expect(config).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      capabilities: {},
      thinkingLevel: 'low'
    })

    mocks.createAgentTool.mockClear()
    const without = await host.resolveAgentTools(requestD({ names: ['read', 'skill:pdf'] }), {
      signal: signal()
    })
    expect(without.agent).toBeUndefined()
    expect(mocks.createAgentTool).not.toHaveBeenCalled()
  })

  it('H11-16 SkillTool 的实参：恰好（名单去前缀、项目路径）两个；无项目第二个是 undefined；名单没有 skill: 就不造', async () => {
    await host.resolveAgentTools(
      requestD({ names: ['read', 'skill:builtin:drawing', 'skill:pdf'] }),
      { signal: signal() }
    )
    expect(mocks.skillToolCalls).toEqual([{ args: [['builtin:drawing', 'pdf'], '/w/proj'] }])

    mocks.skillToolCalls.length = 0
    mocks.pick.mockReturnValue(undefined)
    await host.resolveAgentTools(requestD({ names: ['skill:pdf'] }), { signal: signal() })
    expect(mocks.skillToolCalls).toEqual([{ args: [['pdf'], undefined] }])

    mocks.skillToolCalls.length = 0
    const none = await host.resolveAgentTools(requestD({ names: ['read', 'agent'] }), {
      signal: signal()
    })
    expect(mocks.skillToolCalls).toEqual([])
    expect(none.skill).toBeUndefined()
    expect(none.skills ?? []).toEqual([])
  })

  it('H11-18 点了名但这一次一个都不在架：构造一次，不挂 skill，skills 为空', async () => {
    mocks.findEnabled.mockReturnValue([])
    const resolved = await host.resolveAgentTools(
      requestD({ names: ['read', 'skill:builtin:drawing'] }),
      { signal: signal() }
    )
    expect(mocks.skillToolCalls).toHaveLength(1)
    expect(resolved.skill).toBeUndefined()
    expect(resolved.skills).toEqual([])
  })

  it('H11-19 extraTools 原样交回：一条 next，包一次（H11-40 的选项），不混进 agent / skill / mcp', async () => {
    const next = stubTool('next')
    const resolved = await host.resolveAgentTools(requestD({ extraTools: [next] }), {
      signal: signal()
    })
    expect(names(resolved.extraTools ?? [])).toEqual(['next'])
    const wraps = mocks.wrapCalls.filter((c) => c.tool === next)
    expect(wraps).toHaveLength(1)
    expect(resolved.extraTools![0]).toBe(wraps[0].wrapped)
    expect(Object.keys(wraps[0].opts).sort()).toEqual(['security', 'sessionId', 'spill'])
    const others = [resolved.agent, resolved.skill, ...(resolved.mcp ?? []).flatMap((m) => m.tools)]
    expect(others.map((t) => t?.name)).not.toContain('next')
  })

  it('H11-20 派生请求：PhasePendingError（phase 2），不连 MCP、不造 SkillTool / 派发工具（PIN-07）', async () => {
    const error = await host
      .resolveAgentTools(requestD({ kind: 'spawned', selfSessionId: 'agent-7' }), {
        signal: signal()
      })
      .catch((e: unknown) => e)
    expect(isPhasePendingError(error)).toBe(true)
    expect((error as { phase: number }).phase).toBe(2)
    expect(mocks.statusByName).not.toHaveBeenCalled()
    expect(mocks.ensureServerByName).not.toHaveBeenCalled()
    expect(mocks.skillToolCalls).toEqual([])
    expect(mocks.createAgentTool).not.toHaveBeenCalled()
  })

  it('H11-21 调用前 signal 已落：拒绝；statusByName / ensure 都没调，什么都没广播', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(
      host.resolveAgentTools(requestD({ names: ['mcp:ssh'] }), { signal: controller.signal })
    ).rejects.toThrow('cancelled')
    expect(mocks.statusByName).not.toHaveBeenCalled()
    expect(mocks.ensureServerByName).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('P2-06-28 解析（没有 MCP 调用）不问会话宿主：sessionOf / fake.get 都没调', async () => {
    setLock('s1', lockD())
    const get = vi.spyOn(fake, 'get')
    await host.resolveAgentTools(requestD(), { signal: signal() })
    expect(sessionOf).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('MTI-1 / P2-06-22 派生 agent：连接与取工具按根会话、调用方报它自己的 agentId', async () => {
    setLock('s1', lockD()).identities.set(2, SPAWN_E)
    mocks.statusByName.mockReturnValue('disconnected')
    await host.resolveAgentTools(requestD({ names: ['mcp:ssh'] }), { signal: signal() })

    // 连接与工具都按根会话
    expect(mocks.ensureServerByName.mock.calls).toEqual([
      ['ssh', { timeoutMs: LAZY_CONNECT_TIMEOUT_MS, sessionId: 's1' }]
    ])
    expect(mocks.declarationsOf.mock.calls).toEqual([['ssh', 's1']])
    expect(mocks.registrationsFromDeclarations.mock.calls[0].slice(0, 2)).toEqual(['ssh', 's1'])
    expect(mocks.broadcast).toHaveBeenCalled()
    for (const [event] of mocks.broadcast.mock.calls) expect(event.sessionId).toBe('s1')

    // 调用方报它自己的 agent id
    const created = callerIdOfCall(0)
    expect(created(2)).toBe('sub-a1')
    expect(created(1)).toBe('s1')

    // 重建：同样按根会话建，调用方照样按对话认
    const lock = lockD()
    await host.rebuildAgentTools(lock, { sessionId: 's1' })
    expect(mocks.registrationsFromDeclarations.mock.calls[1].slice(0, 3)).toEqual([
      'context7',
      's1',
      lock.mcp.context7
    ])
    expect(callerIdOfCall(1)(2)).toBe('sub-a1')

    expect(sessionOf).toHaveBeenCalled()
    for (const [id] of sessionOf.mock.calls) expect(id).toBe('s1')
  })
})

// ─── MCP 惰性连接 ────────────────────────────────────────────────────────

describe('MCP 惰性连接', () => {
  const ssh = { names: ['mcp:ssh'] }

  it('H11-22 连接实参与占位卡：statusByName(ssh, s1) → ensure 恰一次（超时 + 根会话）；广播恰好 connecting true / false，false 在 ensure 落定之后（PIN-09）', async () => {
    const pending = deferred<{ ok: boolean }>()
    mocks.ensureServerByName.mockReturnValue(pending.promise)
    const resolving = host.resolveAgentTools(requestD(ssh), { signal: signal() })
    await flush()
    expect(mocks.statusByName).toHaveBeenCalledWith('ssh', 's1')
    expect(mocks.ensureServerByName.mock.calls).toEqual([
      ['ssh', { timeoutMs: LAZY_CONNECT_TIMEOUT_MS, sessionId: 's1' }]
    ])
    expect(mocks.broadcast.mock.calls).toEqual([
      [{ type: 'mcp_connecting', sessionId: 's1', server: 'ssh', connecting: true }]
    ])
    pending.resolve({ ok: true })
    await resolving
    expect(mocks.broadcast.mock.calls).toEqual([
      [{ type: 'mcp_connecting', sessionId: 's1', server: 'ssh', connecting: true }],
      [{ type: 'mcp_connecting', sessionId: 's1', server: 'ssh', connecting: false }]
    ])
  })

  it('H11-23 已连上：不发 mcp_connecting；ensure 仍调一次；工具在', async () => {
    mocks.statusByName.mockReturnValue('connected')
    const resolved = await host.resolveAgentTools(requestD(ssh), { signal: signal() })
    expect(mocks.broadcast).not.toHaveBeenCalled()
    expect(mocks.ensureServerByName).toHaveBeenCalledTimes(1)
    expect(resolved.mcp?.[0].tools).toHaveLength(5)
  })

  it('H11-24 声明与工具出自同一份快照：declarationsOf 一次（ensure 之后），按它 registrationsFromDeclarations 一次；工具按声明次序；不调 getRegistrationsByServerName（PIN-10）', async () => {
    const order: string[] = []
    mocks.ensureServerByName.mockImplementation(async () => {
      order.push('ensure')
      return { ok: true }
    })
    mocks.declarationsOf.mockImplementation((server: string) => {
      order.push('declarations')
      return (MCP_DECLS[server] ?? []).map((d) => ({ ...d }))
    })
    const resolved = await host.resolveAgentTools(requestD(ssh), { signal: signal() })
    expect(order).toEqual(['ensure', 'declarations'])
    expect(mocks.declarationsOf.mock.calls).toEqual([['ssh', 's1']])
    const entry = resolved.mcp![0]
    expect(entry.declarations).toEqual(JSON.parse(JSON.stringify(entry.declarations)))
    expect(mocks.registrationsFromDeclarations).toHaveBeenCalledTimes(1)
    const [server, sid, decls, opts] = mocks.registrationsFromDeclarations.mock.calls[0]
    expect([server, sid]).toEqual(['ssh', 's1'])
    expect(decls).toBe(entry.declarations)
    expect(Object.keys(opts as object)).toEqual(['callerIdOf'])
    expect(names(entry.tools)).toEqual([
      'mcp__ssh__list-hosts',
      'mcp__ssh__exec',
      'mcp__ssh__upload',
      'mcp__ssh__download',
      'mcp__ssh__sync'
    ])
    expect(mocks.getRegistrationsByServerName).not.toHaveBeenCalled()
  })

  it('H11-25 / P2-06-29 callerIdOf：根对话与别的（非派生）对话都报 s1；没有锁也一样', async () => {
    setLock('s1', lockD())
    await host.resolveAgentTools(requestD(ssh), { signal: signal() })
    const callerIdOf = callerIdOfCall(0)
    expect(callerIdOf(1)).toBe('s1')
    expect(callerIdOf(7)).toBe('s1')
    setLock('s1', undefined)
    expect(callerIdOf(1)).toBe('s1')
    expect(callerIdOf(7)).toBe('s1')
  })

  it('H11-26 连不上：照常解析、mcp 里只有连上的那台；一条点名它的 error 广播（在解析完成之前）；它的 connecting 对照发；不为它取声明 / 建工具', async () => {
    mocks.ensureServerByName.mockImplementation(async (server: string) =>
      server === 'broken' ? { ok: false, error: 'spawn npx ENOENT' } : { ok: true }
    )
    const resolved = await host.resolveAgentTools(requestD({ names: ['mcp:broken', 'mcp:ssh'] }), {
      signal: signal()
    })
    expect(resolved.mcp?.map((m) => m.server)).toEqual(['ssh'])
    const errors = mocks.broadcast.mock.calls.filter(([e]) => e.type === 'error')
    expect(errors).toEqual([
      [
        {
          type: 'error',
          sessionId: 's1',
          error: i18next.t('chat.mcpConnectFailed', { name: 'broken', error: 'spawn npx ENOENT' })
        }
      ]
    ])
    const brokenConnecting = mocks.broadcast.mock.calls
      .filter(([e]) => e.type === 'mcp_connecting' && e.server === 'broken')
      .map(([e]) => e.connecting)
    expect(brokenConnecting).toEqual([true, false])
    expect(mocks.declarationsOf.mock.calls.map(([s]) => s)).toEqual(['ssh'])
    expect(mocks.registrationsFromDeclarations.mock.calls.map(([s]) => s)).toEqual(['ssh'])
  })

  it('H11-27 不在启用列表里（{ok:false} 没有 error）：不报错，也不在 mcp 里', async () => {
    mocks.ensureServerByName.mockResolvedValue({ ok: false })
    const resolved = await host.resolveAgentTools(requestD(ssh), { signal: signal() })
    expect(resolved.mcp).toEqual([])
    expect(mocks.broadcast.mock.calls.filter(([e]) => e.type === 'error')).toEqual([])
  })

  it('H11-28 连接抛错：按连不上处理 —— 照常解析，错误广播带着原因，connecting:false 照发，别的服务器不受影响（PIN-11）', async () => {
    mocks.ensureServerByName.mockImplementation(async (server: string) => {
      if (server === 'ssh') throw new Error('boom')
      return { ok: true }
    })
    const resolved = await host.resolveAgentTools(
      requestD({ names: ['mcp:ssh', 'mcp:context7'] }),
      { signal: signal() }
    )
    expect(resolved.mcp?.map((m) => m.server)).toEqual(['context7'])
    const errors = mocks.broadcast.mock.calls.filter(([e]) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0][0].error).toContain('boom')
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: 'mcp_connecting',
      sessionId: 's1',
      server: 'ssh',
      connecting: false
    })
  })

  it('H11-29 并发但有序：两台的 ensure 都在任何一台落定之前发出；后连上的排在名单里靠前的位置', async () => {
    const c7 = deferred<{ ok: boolean }>()
    mocks.ensureServerByName.mockImplementation((server: string) =>
      server === 'context7' ? c7.promise : Promise.resolve({ ok: true })
    )
    const resolving = host.resolveAgentTools(requestD({ names: ['mcp:context7', 'mcp:ssh'] }), {
      signal: signal()
    })
    await flush()
    expect(mocks.ensureServerByName.mock.calls.map(([s]) => s)).toEqual(['context7', 'ssh'])
    c7.resolve({ ok: true })
    const resolved = await resolving
    expect(resolved.mcp?.map((m) => m.server)).toEqual(['context7', 'ssh'])
  })

  it('H11-30 连接途中被中止：当场拒绝（ensure 还没落定）；最后一条广播是 connecting:false，没有 error；之后 ensure 连上也不再广播、不取声明（PIN-09）', async () => {
    const pending = deferred<{ ok: boolean }>()
    mocks.ensureServerByName.mockReturnValue(pending.promise)
    const controller = new AbortController()
    const resolving = host.resolveAgentTools(requestD(ssh), { signal: controller.signal })
    await flush()
    controller.abort(new Error('creation cancelled'))
    await expect(resolving).rejects.toThrow('creation cancelled')
    const last = mocks.broadcast.mock.calls.at(-1)?.[0]
    expect(last).toEqual({
      type: 'mcp_connecting',
      sessionId: 's1',
      server: 'ssh',
      connecting: false
    })
    expect(mocks.broadcast.mock.calls.filter(([e]) => e.type === 'error')).toEqual([])

    const before = mocks.broadcast.mock.calls.length
    pending.resolve({ ok: true })
    await flush(10)
    expect(mocks.broadcast.mock.calls.length).toBe(before)
    expect(mocks.declarationsOf).not.toHaveBeenCalled()
  })

  it('H11-31 连上了但一个工具都没有：照记 {server, declarations: [], tools: []}（PIN-12）', async () => {
    const resolved = await host.resolveAgentTools(requestD({ names: ['mcp:empty'] }), {
      signal: signal()
    })
    expect(resolved.mcp).toEqual([{ server: 'empty', declarations: [], tools: [] }])
  })
})

// ─── rebuildAgentTools ────────────────────────────────────────────────────

describe('rebuildAgentTools', () => {
  it('H11-32 / P2-06-28 不碰网络：不问状态、不连、不取声明 / 活注册项、不问会话宿主、不广播；不读会话配置', async () => {
    setLock('s1', lockD())
    const get = vi.spyOn(fake, 'get')
    await host.rebuildAgentTools(lockD(), { sessionId: 's1' })
    for (const fn of [
      mocks.statusByName,
      mocks.ensureServerByName,
      mocks.declarationsOf,
      mocks.getRegistrationsByServerName,
      mocks.broadcast,
      mocks.pickSettings
    ]) {
      expect(fn).not.toHaveBeenCalled()
    }
    expect(sessionOf).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    for (const [, fields] of mocks.pick.mock.calls) expect(fields).not.toContain('settings')
  })

  it('H11-33 / P2-06-29 这一组出自锁：agent 在；SkillTool 按（锁里的技能、项目路径、known）造；MCP 按锁里的声明建、callerIdOf(1) = s1；没有 tools / extras', async () => {
    setLock('s1', lockD())
    const lock = lockD()
    const set = await host.rebuildAgentTools(lock, { sessionId: 's1' })
    expect(set.agent?.name).toBe('agent')
    expect(mocks.skillToolCalls).toEqual([{ args: [lock.skills, '/w/proj', 'known'] }])
    expect(set.mcp?.map((m) => m.server)).toEqual(['context7'])
    expect(mocks.registrationsFromDeclarations).toHaveBeenCalledTimes(1)
    const [server, sid, decls] = mocks.registrationsFromDeclarations.mock.calls[0]
    expect([server, sid, decls]).toEqual(['context7', 's1', lock.mcp.context7])
    expect(names(set.mcp![0].tools)).toEqual([
      'mcp__context7__resolve-library-id',
      'mcp__context7__get-library-docs'
    ])
    expect(callerIdOfCall(0)(1)).toBe('s1')
    expect(set.tools ?? []).toEqual([])
    expect((set as ResolvedAgentTools).extraTools).toBeUndefined()
  })

  it('H11-34 锁赢过此刻的状态：(a) 锁没有 agent → 没有；(b) 反过来 → 有；(c) 锁没技能 → 不造 SkillTool；(d) 锁没 MCP → 不建、不连', async () => {
    const without = lockD({ toolNames: lockD().toolNames.filter((n) => n !== 'agent') })
    expect((await host.rebuildAgentTools(without, { sessionId: 's1' })).agent).toBeUndefined()

    const withAgent = lockD({ profileName: 'bot', toolNames: ['read', 'agent'] })
    expect((await host.rebuildAgentTools(withAgent, { sessionId: 's1' })).agent).toBeDefined()

    mocks.skillToolCalls.length = 0
    const noSkills = await host.rebuildAgentTools(lockD({ skills: [] }), { sessionId: 's1' })
    expect(mocks.skillToolCalls).toEqual([])
    expect(noSkills.skill).toBeUndefined()

    mocks.registrationsFromDeclarations.mockClear()
    const noMcp = await host.rebuildAgentTools(lockD({ mcp: {} }), { sessionId: 's1' })
    expect(noMcp.mcp).toEqual([])
    expect(mocks.registrationsFromDeclarations).not.toHaveBeenCalled()
    expect(mocks.ensureServerByName).not.toHaveBeenCalled()
  })

  it('H11-36 服务器已从配置里删掉：按锁的声明照样建出两件 mcp__context7__*，不抛；调用时报「没连上」', async () => {
    const real = new McpManager({
      store: { findAll: () => [], findEnabled: () => [], findById: () => undefined } as never,
      createTransport: (() => {
        throw new Error('no transport')
      }) as never
    })
    mocks.registrationsFromDeclarations.mockImplementation(
      (
        server: string,
        sid: string,
        decls: readonly McpToolDeclaration[],
        opts: McpRegistrationOptions
      ) => real.registrationsFromDeclarations(server, sid, decls, opts)
    )
    const set = await host.rebuildAgentTools(lockD(), { sessionId: 's1' })
    const tools = set.mcp![0].tools
    expect(names(tools)).toEqual([
      'mcp__context7__resolve-library-id',
      'mcp__context7__get-library-docs'
    ])
    const raw = mocks.wrapCalls.find((c) => c.wrapped === tools[0])!.tool as ToolRegistration
    const result = await raw.execute(
      {},
      { callId: 'c1', taskId: 1, conversationId: 1 } as unknown as ToolExecutionApi,
      {} as Context
    )
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not connected')
  })

  it('H11-38 / P2-06-29 fork 上的锁（对话 5）照样重建，callerIdOf(5) = s1', async () => {
    setLock('s1', lockD({ conversationId: 5 as never }))
    const set = await host.rebuildAgentTools(lockD({ conversationId: 5 as never }), {
      sessionId: 's1'
    })
    expect(set.mcp).toHaveLength(1)
    expect(callerIdOfCall(0)(5)).toBe('s1')
  })

  it('H11-39 派生 agent 的锁：PhasePendingError（phase 2）（PIN-07）', async () => {
    const error = await Promise.resolve()
      .then(() => host.rebuildAgentTools(lockD({ kind: 'spawned' }), { sessionId: 's1' }))
      .catch((e: unknown) => e)
    expect(isPhasePendingError(error)).toBe(true)
    expect((error as { phase: number }).phase).toBe(2)
  })
})

// ─── 包装 ──────────────────────────────────────────────────────────────

describe('包装', () => {
  it('H11-40 每条路上的每个工具恰好包一次；选项恰为 {sessionId s1, spill auto, security 函数}，不带策略 / 上限；交出的是包装器的返回值', async () => {
    const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    const next = stubTool('next')
    const resolved = await host.resolveAgentTools(requestD({ extraTools: [next] }), {
      signal: signal()
    })
    const rebuilt = await host.rebuildAgentTools(lockD(), { sessionId: 's1' })
    const returned = [
      ...builtin,
      resolved.agent!,
      resolved.skill!,
      ...resolved.mcp!.flatMap((m) => m.tools),
      ...resolved.extraTools!,
      rebuilt.agent!,
      rebuilt.skill!,
      ...rebuilt.mcp!.flatMap((m) => m.tools)
    ]
    expect(mocks.wrapCalls).toHaveLength(returned.length)
    expect(new Set(mocks.wrapCalls.map((c) => c.tool)).size).toBe(returned.length)
    for (const tool of returned) {
      const opts = wrapOf(tool)
      expect(Object.keys(opts).sort()).toEqual(['security', 'sessionId', 'spill'])
      expect(opts.sessionId).toBe('s1')
      expect(opts.spill).toBe('auto')
      expect(opts.security).toBeTypeOf('function')
    }
  })

  /** H11-44 的样本：内置 read、派发、技能、一件 MCP、一条附加的 next */
  async function sampleTools(): Promise<ToolRegistration[]> {
    const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    const resolved = await host.resolveAgentTools(requestD({ extraTools: [stubTool('next')] }), {
      signal: signal()
    })
    return [
      builtin.find((t) => t.name === 'read')!,
      resolved.agent!,
      resolved.skill!,
      resolved.mcp![0].tools[0],
      resolved.extraTools![0]
    ]
  }

  it('H11-44 / P2-06-25 门的主体按调用现取：有锁 → work / root；没锁 → 没有档案名；锁换成 bot → 下一次报 bot；每种工具同一次调用同一个主体', async () => {
    const sample = await sampleTools()
    const subjectOf = (tool: object): Record<string, unknown> => {
      const ctx = securityCtxOf(tool)
      return {
        sessionId: ctx.sessionId,
        agentKind: ctx.agent?.kind ?? 'root',
        ...(ctx.agent?.profileName ? { profileName: ctx.agent.profileName } : {})
      }
    }

    setLock('s1', lockD())
    for (const tool of sample) {
      expect(subjectOf(tool)).toEqual({ sessionId: 's1', agentKind: 'root', profileName: 'work' })
    }
    setLock('s1', undefined)
    for (const tool of sample) {
      expect(subjectOf(tool)).toEqual({ sessionId: 's1', agentKind: 'root' })
    }
    setLock('s1', lockD({ profileName: 'bot' }))
    for (const tool of sample) {
      expect(subjectOf(tool)).toEqual({ sessionId: 's1', agentKind: 'root', profileName: 'bot' })
    }
  })

  it('P2-06-16 门的主体经宿主按对话认人，每种工具都一样：2 → SPAWN_E、3 → HOOK_R、1 → 根、4 → BARE', async () => {
    const session = setLock('s1', lockD())
    session.identities.set(2, SPAWN_E)
    session.identities.set(3, HOOK_R)
    session.identities.set(4, BARE)
    const sample = await sampleTools()
    // 同一条对话、每种工具都是同一个身份对象（运行时给的那一个，原样交回）
    for (const tool of sample) {
      const spawned = securityCtxOf(tool, 2)
      expect(spawned.agent).toBe(SPAWN_E)
      expect(spawned.sessionId).toBe('s1')
      expect(securityCtxOf(tool, 3).agent).toBe(HOOK_R)
      expect(securityCtxOf(tool, 4).agent).toBe(BARE)
      const root = securityCtxOf(tool, 1).agent
      expect(root).toMatchObject({ profileName: 'work', kind: 'root' })
      expect(root).not.toHaveProperty('callerId')
    }
  })
})

// ─── 调用方身份（P2-06：按对话认人） ──────────────────────────────────────

/** 会话级装配的那一个 ctx（内置工具工厂拿到的） */
async function sessionCtx(sessionId = 's1'): Promise<ToolContext> {
  factoryCalls.length = 0
  await host.buildBuiltinTools({ sessionId, sandboxed: false })
  return factoryCalls[0].ctx
}

describe('agentOf by conversation', () => {
  it('P2-06-01 派生与根按对话认：agentOf(2) 就是 SPAWN_E；agentOf(1) 就是 agentIdentity(1) 交回的那个对象（根、没有 callerId）；每次现问、不缓存', async () => {
    const session = setLock('s1', lockD())
    session.identities.set(2, SPAWN_E)
    const ctx = await sessionCtx()
    const lookup = vi.spyOn(session, 'agentIdentity')

    expect(ctx.agentOf!(2)).toBe(SPAWN_E)
    expect(ctx.agentOf!(2)?.callerId).toBe('sub-a1')
    lookup.mockClear()
    sessionOf.mockClear()

    expect(ctx.agentOf!(2)).toBe(SPAWN_E)
    const root = ctx.agentOf!(1)
    expect(root).toBe(lookup.mock.results[1].value)
    expect(root?.profileName).toBe('work')
    expect(root?.kind).toBe('root')
    expect('callerId' in root!).toBe(false)
    expect(lookup.mock.calls).toEqual([[2], [1]])
    expect(sessionOf.mock.calls).toEqual([['s1'], ['s1']])
  })

  it('P2-06-02 hook agent：agentOf(3) 就是 HOOK_R（spawned、callerId sub-r1）', async () => {
    setLock('s1', lockD()).identities.set(3, HOOK_R)
    const agent = (await sessionCtx()).agentOf!(3)
    expect(agent).toBe(HOOK_R)
    expect(agent?.kind).toBe('spawned')
    expect(agent?.callerId).toBe('sub-r1')
  })

  it('P2-06-03 不认识的 / 非派生的对话：原样交回 agentIdentity 给的（根身份），对话 id 原样传下去', async () => {
    const session = setLock('s1', lockD())
    const ctx = await sessionCtx()
    const lookup = vi.spyOn(session, 'agentIdentity')
    const fork = ctx.agentOf!(5)
    const unknown = ctx.agentOf!(999)
    expect(lookup.mock.calls).toEqual([[5], [999]])
    expect(fork).toBe(lookup.mock.results[0].value)
    expect(unknown).toBe(lookup.mock.results[1].value)
    expect(fork).toMatchObject({ profileName: 'work', kind: 'root' })
    expect(unknown).toMatchObject({ profileName: 'work', kind: 'root' })
  })

  it('P2-06-04 会话开着但没锁：根对话 / 不认识的 → undefined；派生的照认', async () => {
    setLock('s1', undefined).identities.set(2, SPAWN_E)
    const ctx = await sessionCtx()
    expect(ctx.agentOf!(1)).toBeUndefined()
    expect(ctx.agentOf!(999)).toBeUndefined()
    expect(ctx.agentOf!(2)).toBe(SPAWN_E)
    expect(withCallAgent(ctx, { conversationId: 1 }).agent).toBeUndefined()
    expect(withCallAgent(ctx, { conversationId: 2 }).agent).toBe(SPAWN_E)
  })

  it('P2-06-05a 会话没开：undefined，不抛；问过 sessionOf(s1)，从不打开 / peek', async () => {
    const ctx = await sessionCtx()
    expect(() => ctx.agentOf!(1)).not.toThrow()
    expect(ctx.agentOf!(1)).toBeUndefined()
    expect(ctx.agentOf!(2)).toBeUndefined()
    expect(sessionOf).toHaveBeenCalledWith('s1')
    expect(fake.calls.filter(([kind]) => kind === 'open' || kind === 'peek')).toEqual([])
  })

  it('P2-06-05b / P2-06-06 开着时建的 ctx：会话关了 → undefined，旧实例不再被问；重开后跟着新实例走', async () => {
    const first = setLock('s1', lockD())
    first.identities.set(2, SPAWN_E)
    const ctx = await sessionCtx()
    expect(ctx.agentOf!(2)).toBe(SPAWN_E)
    const lookup = vi.spyOn(first, 'agentIdentity')

    await fake.close('s1')
    expect(ctx.agentOf!(2)).toBeUndefined()
    expect(lookup).not.toHaveBeenCalled()

    // P2-06-06：重开（新实例、新锁、新记录）—— 旧 ctx 认的是新的
    const SPAWN_E2: AgentIdentity = { ...SPAWN_E, profileName: 'explore2', callerId: 'sub-a2' }
    const second = fake.put('s1', { lock: lockD({ profileName: 'bot' }) })
    second.identities.set(2, SPAWN_E2)
    expect(ctx.agentOf!(2)).toBe(SPAWN_E2)
    expect(ctx.agentOf!(1)?.profileName).toBe('bot')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('P2-06-07 出错不抛（P1-11 PIN-15）：sessionOf 抛 / agentIdentity 抛 → undefined 并 warn（带会话 id）；各处落回兜底', async () => {
    const session = setLock('s1', lockD())
    session.identities.set(2, SPAWN_E)
    const ctx = await sessionCtx()

    // (a) sessionOf 抛
    sessionOf.mockImplementationOnce(() => {
      throw new Error('host gone')
    })
    expect(ctx.agentOf!(2)).toBeUndefined()
    expect(mocks.log.warn).toHaveBeenCalledTimes(1)
    expect(String(mocks.log.warn.mock.calls[0][0])).toContain('s1')

    // (b) agentIdentity 抛
    mocks.log.warn.mockClear()
    vi.spyOn(session, 'agentIdentity').mockImplementationOnce(() => {
      throw new Error('directory broken')
    })
    expect(ctx.agentOf!(2)).toBeUndefined()
    expect(mocks.log.warn).toHaveBeenCalledTimes(1)
    const warning = String(mocks.log.warn.mock.calls[0][0])
    expect(warning).toContain('s1')
    expect(warning).toContain('2')

    // (c) 经用它的地方：章、门的主体、MCP 调用方 id 都落回兜底
    const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    await host.resolveAgentTools(requestD({ names: ['mcp:ssh'] }), { signal: signal() })
    sessionOf.mockImplementation(() => {
      throw new Error('host gone')
    })
    expect(agentActorOf(withCallAgent(ctx, { conversationId: 2 }))).toBe('shuvix-agent/unknown')
    expect(securityCtxOf(builtin.find((t) => t.name === 'read')!, 2).agent).toBeUndefined()
    expect(callerIdOfCall(0)(2)).toBe('s1')
  })

  it('P2-06-13 actor 经宿主 ctx 按对话盖章：1 → work/sonnet、2 → explore/haiku、3 → permission-reviewer/haiku、4 → explore/unknown；模型惰性取', async () => {
    const getModelConfig = vi.fn(haiku)
    const spawn: AgentIdentity = { ...SPAWN_E, getModelConfig }
    const session = setLock('s1', lockD())
    session.identities.set(2, spawn)
    session.identities.set(3, HOOK_R)
    session.identities.set(4, BARE)
    const ctx = await sessionCtx()
    const actor = (c: number): string => agentActorOf(withCallAgent(ctx, { conversationId: c }))

    expect(ctx.agentOf!(2)).toBe(spawn)
    expect(getModelConfig).not.toHaveBeenCalled()

    expect(actor(1)).toBe('shuvix-work/claude-sonnet-4-5')
    expect(actor(2)).toBe('shuvix-explore/claude-haiku-4-5')
    expect(getModelConfig).toHaveBeenCalledTimes(1)
    expect(actor(3)).toBe('shuvix-permission-reviewer/claude-haiku-4-5')
    expect(actor(4)).toBe('shuvix-explore/unknown')

    session.lock = undefined
    expect(actor(1)).toBe('shuvix-agent/unknown')
    expect(actor(2)).toBe('shuvix-explore/claude-haiku-4-5')
  })

  it('P2-06-26（改写 H11-45）根身份就是 agentIdentity(1) 给的对象：没有 callerId；模型配置取锁定的模型；actor = shuvix-work/claude-sonnet-4-5', async () => {
    const session = setLock('s1', lockD())
    const ctx = await sessionCtx()
    const lookup = vi.spyOn(session, 'agentIdentity')
    const agent = ctx.agentOf!(1)
    expect(agent).toBe(lookup.mock.results[0].value)
    expect(agent).not.toHaveProperty('callerId')
    expect(agent?.getModelConfig?.()).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      capabilities: {}
    })
    expect(agentActorOf({ agent })).toBe('shuvix-work/claude-sonnet-4-5')
  })

  it('P2-06-27（改写 H11-46/47，保留 H11-50）现读：同一个 ctx 跟着锁走；模型那一截取 modelId、从不取 provider；只按 s1 问', async () => {
    const session = setLock('s1', undefined)
    const ctx = await sessionCtx()
    const actor = (): string => agentActorOf(withCallAgent(ctx, { conversationId: 1 }))
    expect(actor()).toBe('shuvix-agent/unknown')
    session.lock = lockD({ model: { provider: 'p', modelId: 'm1' } })
    expect(actor()).toBe('shuvix-work/m1')
    session.lock = undefined
    expect(ctx.agentOf!(1)).toBeUndefined()
    session.lock = lockD({ profileName: 'bot', model: { provider: 'p', modelId: 'm2' } })
    expect(actor()).toBe('shuvix-bot/m2')
    session.lock = lockD({ profileName: 'my bot' })
    expect(actor()).toBe('shuvix-my-bot/claude-sonnet-4-5')
    session.lock = lockD({ model: { provider: 'provider-x', modelId: 'model-y' } })
    expect(actor()).toBe('shuvix-work/model-y')
    expect(actor()).not.toContain('provider-x')
    expect(new Set(sessionOf.mock.calls.map(([id]) => id))).toEqual(new Set(['s1']))
  })
})

// ─── 调用方 id（MCP `_meta`） ──────────────────────────────────────────

describe('callerId by conversation', () => {
  it('P2-06-08 创建时的注册项：1 / 5 / 999 → s1；2 → sub-a1；3 → sub-r1', async () => {
    const session = setLock('s1', lockD())
    session.identities.set(2, SPAWN_E)
    session.identities.set(3, HOOK_R)
    await host.resolveAgentTools(requestD({ names: ['mcp:ssh'] }), { signal: signal() })
    const callerIdOf = callerIdOfCall(0)
    expect(callerIdOf(1)).toBe('s1')
    expect(callerIdOf(2)).toBe('sub-a1')
    expect(callerIdOf(3)).toBe('sub-r1')
    expect(callerIdOf(5)).toBe('s1')
    expect(callerIdOf(999)).toBe('s1')
  })

  it('P2-06-09 重建时的注册项：同一张表；fork 锁上 5 → s1、2 → sub-a1；重建期间不问 sessionOf', async () => {
    const session = setLock('s1', lockD())
    session.identities.set(2, SPAWN_E)
    session.identities.set(3, HOOK_R)
    await host.rebuildAgentTools(lockD(), { sessionId: 's1' })
    expect(sessionOf).not.toHaveBeenCalled()
    const callerIdOf = callerIdOfCall(0)
    expect(callerIdOf(1)).toBe('s1')
    expect(callerIdOf(2)).toBe('sub-a1')
    expect(callerIdOf(3)).toBe('sub-r1')
    expect(callerIdOf(5)).toBe('s1')
    expect(callerIdOf(999)).toBe('s1')
    expect(sessionOf).toHaveBeenCalled()

    sessionOf.mockClear()
    session.lock = lockD({ conversationId: 5 as never })
    await host.rebuildAgentTools(lockD({ conversationId: 5 as never }), { sessionId: 's1' })
    expect(sessionOf).not.toHaveBeenCalled()
    expect(callerIdOfCall(1)(5)).toBe('s1')
    expect(callerIdOfCall(1)(2)).toBe('sub-a1')
  })

  it('P2-06-10 按调用现取，不在注册那一刻定死：记录改了 → 新 id；锁清了 → 根报 s1；会话关了 → 都报 s1', async () => {
    const session = setLock('s1', lockD())
    session.identities.set(2, SPAWN_E)
    await host.rebuildAgentTools(lockD(), { sessionId: 's1' })
    const callerIdOf = callerIdOfCall(0)
    expect(callerIdOf(2)).toBe('sub-a1')

    session.identities.set(2, { ...SPAWN_E, callerId: 'sub-a2' })
    expect(callerIdOf(2)).toBe('sub-a2')

    session.lock = undefined
    expect(callerIdOf(1)).toBe('s1')
    expect(callerIdOf(2)).toBe('sub-a2')

    await fake.close('s1')
    expect(callerIdOf(1)).toBe('s1')
    expect(callerIdOf(2)).toBe('s1')
  })

  it('P2-06-11 落回会话 id：根身份没有 callerId；派生身份缺 callerId（PIN-03）；sessionOf 抛错 —— callerIdOf 自己从不抛', async () => {
    const session = setLock('s1', lockD())
    session.identities.set(4, { profileName: 'explore', kind: 'spawned' })
    await host.resolveAgentTools(requestD({ names: ['mcp:ssh'] }), { signal: signal() })
    const callerIdOf = callerIdOfCall(0)
    expect(callerIdOf(1)).toBe('s1')
    expect(callerIdOf(4)).toBe('s1')
    sessionOf.mockImplementation(() => {
      throw new Error('host gone')
    })
    expect(() => callerIdOf(4)).not.toThrow()
    expect(callerIdOf(4)).toBe('s1')
  })
})

// ─── 会话之间互不串 ─────────────────────────────────────────────────────

describe('cross-session isolation', () => {
  /** P2-06-23 的布置：s1 有派生 agent，s2 只有根；两边各建内置工具、各解析一次 ssh */
  async function twoSessions(): Promise<{
    s1Ctx: ToolContext
    s2Ctx: ToolContext
    s1Tools: readonly ToolRegistration[]
    s2Tools: readonly ToolRegistration[]
  }> {
    setLock('s1', lockD({ model: { provider: 'p', modelId: 'm1' } })).identities.set(2, SPAWN_E)
    setLock('s2', lockD({ profileName: 'bot', model: { provider: 'p', modelId: 'm2' } }))
    const s1Tools = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    const s1Ctx = factoryCalls.at(-1)!.ctx
    const s2Tools = await host.buildBuiltinTools({ sessionId: 's2', sandboxed: false })
    const s2Ctx = factoryCalls.at(-1)!.ctx
    await host.resolveAgentTools(requestD({ names: ['mcp:ssh'] }), { signal: signal() })
    await host.resolveAgentTools(
      requestD({ names: ['mcp:ssh'], sessionId: 's2', rootSessionId: 's2', selfSessionId: 's2' }),
      { signal: signal() }
    )
    return { s1Ctx, s2Ctx, s1Tools, s2Tools }
  }

  const actorOf = (ctx: ToolContext, c: number): string =>
    agentActorOf(withCallAgent(ctx, { conversationId: c }))

  it('P2-06-23（并入 H11-54）两条会话、同一个对话 id：各认各的（身份、章、门的主体、调用方 id）', async () => {
    const { s1Ctx, s2Ctx, s1Tools, s2Tools } = await twoSessions()

    expect(s1Ctx.agentOf!(2)).toBe(SPAWN_E)
    const s2Agent = s2Ctx.agentOf!(2)
    expect(s2Agent).toMatchObject({ profileName: 'bot', kind: 'root' })
    expect(s2Agent).not.toHaveProperty('callerId')

    expect(actorOf(s1Ctx, 2)).toBe('shuvix-explore/claude-haiku-4-5')
    expect(actorOf(s1Ctx, 1)).toBe('shuvix-work/m1')
    expect(actorOf(s2Ctx, 2)).toBe('shuvix-bot/m2')

    const s1Gate = securityCtxOf(s1Tools[0], 2)
    expect(s1Gate.agent).toBe(SPAWN_E)
    expect(s1Gate.sessionId).toBe('s1')
    const s2Gate = securityCtxOf(s2Tools[0], 2)
    expect(s2Gate.agent).toMatchObject({ profileName: 'bot', kind: 'root' })
    expect(s2Gate.sessionId).toBe('s2')

    expect(callerIdOfCall(0)(2)).toBe('sub-a1')
    expect(callerIdOfCall(1)(2)).toBe('s2')

    sessionOf.mockClear()
    s1Ctx.agentOf!(2)
    actorOf(s1Ctx, 1)
    expect(new Set(sessionOf.mock.calls.map(([id]) => id))).toEqual(new Set(['s1']))
    sessionOf.mockClear()
    s2Ctx.agentOf!(2)
    actorOf(s2Ctx, 1)
    expect(new Set(sessionOf.mock.calls.map(([id]) => id))).toEqual(new Set(['s2']))
  })

  it('P2-06-24 一条会话关了：它落回兜底，另一条照旧', async () => {
    const { s1Ctx, s2Ctx } = await twoSessions()
    await fake.close('s2')

    expect(s2Ctx.agentOf!(2)).toBeUndefined()
    expect(callerIdOfCall(1)(2)).toBe('s2')
    expect(actorOf(s2Ctx, 2)).toBe('shuvix-agent/unknown')

    expect(s1Ctx.agentOf!(2)).toBe(SPAWN_E)
    expect(callerIdOfCall(0)(2)).toBe('sub-a1')
    expect(actorOf(s1Ctx, 2)).toMatch(/^shuvix-explore\//)
  })
})

// ─── `_meta` 端到端（真 McpManager + 真 SDK Server，P2-06-12 / PIN-07） ───────────

describe('MCP _meta end to end', () => {
  it('P2-06-12 可信（inproc 内置）的带调用方 id 与 taskId，不可信的只带 toolCallId；根与派生共用会话 s1 那一份实例', async () => {
    const metas: Array<{ server: string; meta: unknown }> = []
    const scopes: Array<{ server: string; scope: unknown }> = []
    const store = {
      findById: (id: string) => rows.find((r) => r.id === id),
      findEnabled: () => rows,
      findAll: () => rows,
      updateCachedTools: () => {}
    }
    const rows = [
      mcpRow({ id: 'ssh-id', name: 'ssh', type: 'inproc', url: '', isBuiltin: 1 }),
      mcpRow({ id: 'web-id', name: 'web', type: 'http', isBuiltin: 0 })
    ]
    const real = new McpManager({
      store: store as never,
      createTransport: async (server, scope) => {
        scopes.push({ server: server.name, scope })
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
        const tool = server.name === 'ssh' ? 'exec' : 'search'
        const mcp = new Server(
          { name: server.name, version: '0.0.0' },
          { capabilities: { tools: {} } }
        )
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: tool, inputSchema: { type: 'object' as const, properties: {} } }]
        }))
        mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
          metas.push({ server: server.name, meta: request.params._meta })
          return { content: [{ type: 'text' as const, text: 'ok' }] }
        })
        await mcp.connect(serverSide)
        return clientSide
      }
    })
    mocks.registrationsFromDeclarations.mockImplementation(
      (
        server: string,
        sid: string,
        decls: readonly McpToolDeclaration[],
        opts: McpRegistrationOptions
      ) => real.registrationsFromDeclarations(server, sid, decls, opts)
    )
    setLock('s1', lockD()).identities.set(2, SPAWN_E)

    const set = await host.rebuildAgentTools(
      lockD({ mcp: { ssh: [decl('exec', true)], web: [decl('search', false)] } }),
      { sessionId: 's1' }
    )
    const rawOf = (server: string): ToolRegistration => {
      const wrapped = set.mcp!.find((m) => m.server === server)!.tools[0]
      return mocks.wrapCalls.find((c) => c.wrapped === wrapped)!.tool as ToolRegistration
    }
    const call = async (server: string, api: Record<string, unknown>): Promise<void> => {
      const result = await rawOf(server).execute(
        {},
        api as unknown as ToolExecutionApi,
        {} as Context
      )
      expect(result.isError).toBeFalsy()
    }

    try {
      await call('ssh', { callId: 'pi-2', taskId: 21, conversationId: 2 })
      await call('ssh', { callId: 'pi-1', taskId: 20, conversationId: 1 })
      await call('web', { callId: 'pi-3', taskId: 22, conversationId: 2 })

      expect(metas.map((m) => m.server)).toEqual(['ssh', 'ssh', 'web'])
      expect(metas[0].meta).toStrictEqual({
        'shuvix.dev/toolCallId': 'pi-2',
        'shuvix.dev/agentId': 'sub-a1',
        'shuvix.dev/taskId': 21
      })
      expect(metas[1].meta).toStrictEqual({
        'shuvix.dev/toolCallId': 'pi-1',
        'shuvix.dev/agentId': 's1',
        'shuvix.dev/taskId': 20
      })
      expect(metas[2].meta).toStrictEqual({ 'shuvix.dev/toolCallId': 'pi-3' })
      // ssh 只建过一份实例，按会话 s1 —— 根与派生共用
      expect(scopes.filter((s) => s.server === 'ssh')).toEqual([
        { server: 'ssh', scope: { sessionId: 's1' } }
      ])
    } finally {
      await real.disconnectAll()
    }
  })
})

// ─── 旧入口 ────────────────────────────────────────────────────────────

describe('旧入口', () => {
  it('H11-67 agentFactory：派生 → PhasePendingError(phase 2)（根 agent 由锁创建，工厂的参数类型只收 spawned）；不碰 MCP / SkillTool / 派发工具；resolveProfileModelSpec 还在', async () => {
    const profile = inProcess(profileOf('coding'))
    const model = { provider: MODEL.provider, model: MODEL.modelId, capabilities: {} }
    const spawned = await agentFactory
      .createAgent({
        kind: 'spawned',
        sessionId: 'sub-1',
        profile,
        model,
        cwd: '',
        spawn: {
          agentId: 'sub-1',
          depth: 1,
          parentAgentId: 's1',
          rootSessionId: 's1',
          modelConfig: model,
          canSpawn: true
        }
      })
      .catch((e: unknown) => e)
    expect(isPhasePendingError(spawned)).toBe(true)
    expect((spawned as { phase: number }).phase).toBe(2)

    expect(mocks.ensureServerByName).not.toHaveBeenCalled()
    expect(mocks.skillToolCalls).toEqual([])
    expect(mocks.createAgentTool).not.toHaveBeenCalled()

    mocks.findAllEnabledModels.mockReturnValue([
      { providerId: 'prov-1', modelId: 'gpt-5', capabilities: '{"reasoning":true}' }
    ])
    expect(resolveProfileModelSpec('prov-1/gpt-5')).toEqual({
      provider: 'prov-1',
      model: 'gpt-5',
      capabilities: { reasoning: true }
    })
    expect(resolveProfileModelSpec('nope/missing')).toBeNull()
  })
})

// ─── 与锁的拼法对得上 ───────────────────────────────────────────────────

describe('与运行时的拼法', () => {
  it('composeAgentTools 拼出 L_D 的工具次序（work 名单 + context7 一台）', async () => {
    const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: true })
    const resolved = await host.resolveAgentTools(requestD({ names: N_W_WITHOUT_SSH }), {
      signal: signal()
    })
    expect(composeAgentTools({ names: N_W_WITHOUT_SSH, builtin, set: resolved }).toolNames).toEqual(
      lockD().toolNames
    )
  })
})

const N_W_WITHOUT_SSH = requestD().names.filter((n) => n !== 'mcp:ssh')
