/**
 * P1-11 —— 桌面 ToolHost（`createDesktopToolHost`）：内置工具、按 agent 解析（派发 / 技能 / MCP 惰性连接）、
 * 按锁重建、包装的选项、调用方身份（agentOf），以及留给旧调用方的 agentFactory。编号同设计稿
 * （docs/pi-durable/p1-11-test-design.md，H11-xx）。
 *
 * 本文件是「替身模式」：包装器换成记账的恒等桩（Fx-WRAP spy），SkillTool 换成按 findEnabled /
 * findAll 过滤名单的桩（构造实参可查），派发工具换成桩，mcpService 是 Fx-MCP 的 spy；注册表是**真的**
 * （Fx-REG：与真注册项同名、同平台的桩工厂）。真包装器 / 真 SkillTool / 真派发工具那几条在
 * desktopToolHost.real.test.ts，沙箱钉子在 desktopToolHost.sandbox.test.ts。
 *
 * ⚠️ SkillTool 桩自带过滤（`hasSkills` / `skillNames` 都由 findEnabled 决定）：一个空 `class {}` 会让
 * hasSkills 恒为 undefined、工具永不注入，用例全绿却什么都没测（见 skillToolInjection 的 mock 陷阱）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  getOutputStrategy: vi.fn(),
  sandboxGloballyActive: vi.fn(),
  pinSession: vi.fn(),
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
  sandboxGloballyActive: mocks.sandboxGloballyActive,
  pinSession: mocks.pinSession
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
  getOutputStrategy: mocks.getOutputStrategy,
  wrapDurableTool: (tool: object, opts: Record<string, unknown>) => {
    const wrapped = Object.create(tool) as object
    mocks.wrapCalls.push({ tool, opts, wrapped })
    return wrapped
  }
}))

import i18next from 'i18next'
import {
  composeAgentTools,
  isPhasePendingError,
  LAZY_CONNECT_TIMEOUT_MS,
  McpManager,
  type LockRecord,
  type McpRegistrationOptions,
  type McpToolDeclaration,
  type ResolvedAgentTools,
  type ToolHost
} from '@shuvix/agent-runtime'
import type { ToolContext } from '../../services/toolContext'
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

/** lockOf：可变表上的 spy */
const locks = new Map<string, LockRecord>()
const lockOf = vi.fn((sessionId: string) => locks.get(sessionId))

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
  locks.clear()
  lockOf.mockClear()
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
    mocks.getOutputStrategy,
    mocks.sandboxGloballyActive,
    mocks.pinSession,
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
  host = createDesktopToolHost({ lockOf })
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

  it('H11-04 打开时那一次是纯本地的：不碰 MCP / 技能 / 锁 / 广播 / pinSession；会话行不存在也照常', async () => {
    mocks.pick.mockReturnValue(undefined)
    const tools = await host.buildBuiltinTools({ sessionId: 's1' })
    expect(names(tools)).toEqual(DARWIN_BUILTINS)
    for (const fn of [
      mocks.statusByName,
      mocks.ensureServerByName,
      mocks.declarationsOf,
      mocks.registrationsFromDeclarations,
      mocks.getRegistrationsByServerName,
      mocks.findEnabled,
      mocks.broadcast,
      mocks.pinSession
    ]) {
      expect(fn).not.toHaveBeenCalled()
    }
    expect(lockOf).not.toHaveBeenCalled()
  })

  it('H11-05 每次都是新实例、会话之间互不相干：s2 的 ctx 归 s2，它的 agentOf 只问 lockOf(s2)', async () => {
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
    lockOf.mockClear()
    s2.agentOf!(1)
    expect(lockOf.mock.calls).toEqual([['s2']])
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

  it.todo('MTI-1 派生 agent：连接与取工具按根会话、调用方报它自己的 agentId (pi-durable p2)')
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

  it('H11-25 callerIdOf：根对话与别的对话都报 s1；没有锁也一样', async () => {
    locks.set('s1', lockD())
    await host.resolveAgentTools(requestD(ssh), { signal: signal() })
    const callerIdOf = callerIdOfCall(0)
    expect(callerIdOf(1)).toBe('s1')
    expect(callerIdOf(7)).toBe('s1')
    locks.clear()
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
  it('H11-32 不碰网络：不问状态、不连、不取声明 / 活注册项、不读锁、不广播；不读会话配置', async () => {
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
    expect(lockOf).not.toHaveBeenCalled()
    for (const [, fields] of mocks.pick.mock.calls) expect(fields).not.toContain('settings')
  })

  it('H11-33 这一组出自锁：agent 在；SkillTool 按（锁里的技能、项目路径、known）造；MCP 按锁里的声明建、callerIdOf(1) = s1；没有 tools / extras', async () => {
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

  it('H11-38 fork 上的锁（对话 5）照样重建，callerIdOf(5) = s1', async () => {
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
  it('H11-40 每条路上的每个工具恰好包一次；选项恰为 {sessionId s1, spill auto, security 函数}，不带策略 / 上限；交出的是包装器的返回值；不问 getOutputStrategy', async () => {
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
    expect(mocks.getOutputStrategy).not.toHaveBeenCalled()
  })

  it('H11-44 门的主体按调用现取：有锁 → work / root；没锁 → 没有档案名；锁换成 bot → 下一次报 bot；每种工具同一次调用同一个主体', async () => {
    const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    const resolved = await host.resolveAgentTools(requestD({ extraTools: [stubTool('next')] }), {
      signal: signal()
    })
    const sample = [
      builtin.find((t) => t.name === 'read')!,
      resolved.agent!,
      resolved.skill!,
      resolved.mcp![0].tools[0],
      resolved.extraTools![0]
    ]
    const subjectOf = (tool: object): Record<string, unknown> => {
      const ctx = securityCtxOf(tool)
      return {
        sessionId: ctx.sessionId,
        agentKind: ctx.agent?.kind ?? 'root',
        ...(ctx.agent?.profileName ? { profileName: ctx.agent.profileName } : {})
      }
    }

    locks.set('s1', lockD())
    for (const tool of sample) {
      expect(subjectOf(tool)).toEqual({ sessionId: 's1', agentKind: 'root', profileName: 'work' })
    }
    locks.clear()
    for (const tool of sample) {
      expect(subjectOf(tool)).toEqual({ sessionId: 's1', agentKind: 'root' })
    }
    locks.set('s1', lockD({ profileName: 'bot' }))
    for (const tool of sample) {
      expect(subjectOf(tool)).toEqual({ sessionId: 's1', agentKind: 'root', profileName: 'bot' })
    }
  })
})

// ─── 调用方身份 ─────────────────────────────────────────────────────────

describe('agentOf', () => {
  async function sessionCtx(sessionId = 's1'): Promise<ToolContext> {
    factoryCalls.length = 0
    await host.buildBuiltinTools({ sessionId, sandboxed: false })
    return factoryCalls[0].ctx
  }

  it('H11-45 按锁认出根 agent：work / root / 锁定的模型；actor = shuvix-work/claude-sonnet-4-5（PIN-01）', async () => {
    locks.set('s1', lockD())
    const agent = (await sessionCtx()).agentOf!(1)
    expect(agent?.profileName).toBe('work')
    expect(agent?.kind).toBe('root')
    expect(agent?.getModelConfig?.()).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      capabilities: {}
    })
    expect(agentActorOf({ agent })).toBe('shuvix-work/claude-sonnet-4-5')
  })

  it('H11-46 没有锁 → undefined；lockOf 抛错 → undefined，不抛（PIN-15）', async () => {
    const ctx = await sessionCtx()
    expect(ctx.agentOf!(1)).toBeUndefined()
    lockOf.mockImplementationOnce(() => {
      throw new Error('storage closed')
    })
    expect(() => ctx.agentOf!(1)).not.toThrow()
    lockOf.mockImplementationOnce(() => {
      throw new Error('storage closed')
    })
    expect(ctx.agentOf!(1)).toBeUndefined()
  })

  it('H11-47 现读：同一个 ctx，锁 L1 → work/m1；清掉 → undefined；L2 → bot/m2；lockOf 只按 s1 问', async () => {
    const ctx = await sessionCtx()
    const actor = (): string => agentActorOf(withCallAgent(ctx, { conversationId: 1 }))
    expect(actor()).toBe('shuvix-agent/unknown')
    locks.set('s1', lockD({ model: { provider: 'p', modelId: 'm1' } }))
    expect(actor()).toBe('shuvix-work/m1')
    locks.clear()
    expect(ctx.agentOf!(1)).toBeUndefined()
    locks.set('s1', lockD({ profileName: 'bot', model: { provider: 'p', modelId: 'm2' } }))
    expect(actor()).toBe('shuvix-bot/m2')
    expect(new Set(lockOf.mock.calls.map(([id]) => id))).toEqual(new Set(['s1']))
  })

  it('H11-48 phase 1 不看对话：锁在对话 5 上，agentOf(5) 与 agentOf(1) 都是根 agent（PIN-14）', async () => {
    locks.set('s1', lockD({ conversationId: 5 as never }))
    const ctx = await sessionCtx()
    expect(ctx.agentOf!(5)?.profileName).toBe('work')
    expect(ctx.agentOf!(1)?.profileName).toBe('work')
  })

  it('H11-50 actor 经 withCallAgent：L_D → shuvix-work/claude-sonnet-4-5；没锁 → shuvix-agent/unknown；档案名 my bot → shuvix-my-bot/…；模型那一截取 modelId、从不取 provider', async () => {
    const ctx = await sessionCtx()
    const actor = (): string => agentActorOf(withCallAgent(ctx, { conversationId: 1 }))
    locks.set('s1', lockD())
    expect(actor()).toBe('shuvix-work/claude-sonnet-4-5')
    locks.clear()
    expect(actor()).toBe('shuvix-agent/unknown')
    locks.set('s1', lockD({ profileName: 'my bot' }))
    expect(actor()).toBe('shuvix-my-bot/claude-sonnet-4-5')
    locks.set('s1', lockD({ model: { provider: 'provider-x', modelId: 'model-y' } }))
    expect(actor()).toBe('shuvix-work/model-y')
    expect(actor()).not.toContain('provider-x')
  })

  it('H11-54 会话之间互不串：s1 锁 work/m1、s2 锁 bot/m2 —— 各自的章与门的主体各说各的', async () => {
    locks.set('s1', lockD({ model: { provider: 'p', modelId: 'm1' } }))
    locks.set('s2', lockD({ profileName: 'bot', model: { provider: 'p', modelId: 'm2' } }))
    const s1Tools = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
    const s1Ctx = factoryCalls.at(-1)!.ctx
    const s2Tools = await host.buildBuiltinTools({ sessionId: 's2', sandboxed: false })
    const s2Ctx = factoryCalls.at(-1)!.ctx

    expect(agentActorOf(withCallAgent(s1Ctx, { conversationId: 1 }))).toBe('shuvix-work/m1')
    expect(agentActorOf(withCallAgent(s2Ctx, { conversationId: 1 }))).toBe('shuvix-bot/m2')
    expect(securityCtxOf(s1Tools[0]).agent?.profileName).toBe('work')
    expect(securityCtxOf(s1Tools[0]).sessionId).toBe('s1')
    expect(securityCtxOf(s2Tools[0]).agent?.profileName).toBe('bot')
    expect(securityCtxOf(s2Tools[0]).sessionId).toBe('s2')
  })
})

// ─── 旧入口 ────────────────────────────────────────────────────────────

describe('旧入口', () => {
  it('H11-67 agentFactory：派生 → PhasePendingError(phase 2)，根 → 拒绝（锁创建根 agent）；都不碰 MCP / SkillTool / 派发工具；resolveProfileModelSpec 还在', async () => {
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

    const root = await agentFactory
      .createAgent({
        kind: 'root',
        sessionId: 's1',
        profile: inProcess(profileOf('work')),
        model,
        cwd: '/w/proj'
      })
      .catch((e: unknown) => e)
    // 根 agent 由 durable 会话的锁创建（P1-10 接线之后工厂不再有根路径）：拒绝，且不是「未实现」
    expect(root).toBeInstanceOf(Error)
    expect(isPhasePendingError(root)).toBe(false)

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
