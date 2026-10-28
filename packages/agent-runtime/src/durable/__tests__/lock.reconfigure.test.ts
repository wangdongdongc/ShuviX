/**
 * 锁 · 重配（2026-10-26，规则见 `durable/reconfigure.ts`）：锁住的 root agent 换模型 / MCP 勾选当场生效 ——
 * 一个提交改 `pi.agent` 的模型与工具、锁记录，从下一次请求起生效，运行中也是。技能不在其中（2026-10-28）：
 * 货架在创建时定下、记进锁，侧栏的开关只作用于之后新建的 agent，重配既不换技能工具也不换人设。
 *
 * 场景 W（`support/scenario.ts`）：勾选 ['mcp:ctx']、宿主启用的技能 builtin:drawing / pdf、假服务器
 * ctx / new / ssh / other、模型 faux-1 / faux-2。缺省「锁住并答完一轮」（请求 0），改动 = 改配置对象再
 * `session.reconfigureAgent()`。
 *
 *  - RL-1..9：改了什么、怎么提交、下一次请求看到的差异（最小差异：留下的原样、新的追加）；技能工具与
 *    货架原样（RL-5）；
 *  - RL-10..14：没锁 / 宿主不支持 / 模型用不了 / 宿主抛错 / MCP 连不上（只连这一次新要的服务器，F5）；
 *  - RL-15..17：重配从不动人设、不调变量表（日期之类的波动不重发）、旧锁照样不动人设；
 *  - RL-18..21：运行中（下一次请求起生效、在途请求不受影响、被拿掉的工具 tool_unavailable、发送等重配）；
 *  - RL-22..29：合流、失败、取消（销毁 / 回退 / 关停取消，停下不取消 F3）、与创建 / 销毁串行；
 *  - RL-30..34：关了再开、重启、连续重配的差异形状；
 *  - RL-35（WT4-DL-04）：宿主启用了别的技能之后的重配不重装内置工具、不改记录的货架，重启后按锁记着的货架重装。
 */
import { ROOT_CONVERSATION_ID, type Extension } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { normalizeToolNames } from '../agentSpec'
import { AgentCreationError, type ReconfigureOutcome } from '../lock'
import type { DurableSession } from '../durableSession'
import type { AgentConfig } from '../seams'
import {
  DECL_DOCS,
  DECL_RESOLVE,
  E_W,
  W_PROFILE_TOOLS,
  scenarioConfig,
  scenarioToolHost
} from './support/agentConfig'
import { recordPublications } from './support/commits'
import { answer, callTool, held, requestTools, stalled } from './support/faux'
import { registerHostCleanup, type TestHost } from './support/host'
import { mcpDecl } from './support/mcpFake'
import {
  agentState,
  extensionTools,
  lockW,
  piAgent,
  scenarioW,
  storedLock,
  toolDescription,
  type Scenario
} from './support/scenario'
import { holdTool } from './support/tools'
import {
  allEntries,
  requestTexts,
  systemDeltas,
  toolDeltaCount,
  type SystemDelta
} from './support/transcript'
import { aborted, deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 20000
const OVERLAY = ['mcp:ctx']
const NEW_DECL = mcpDecl('fresh')

const names = (tools: readonly { name: string }[]): string[] => tools.map((tool) => tool.name)
const offered = (t: TestHost, n: number): string[] => names(requestTools(t.kit, n))

/** 场景 W 锁住并答完一轮（请求 0） */
async function lockedTurn(scenario: Scenario): Promise<DurableSession> {
  const session = await scenario.t.open()
  scenario.t.kit.queue(answer('first'))
  expect(await session.submitUser('u1')).toEqual({})
  return session
}

/** 可改的配置 + 锁住答完一轮的会话 */
async function lockedW(
  overrides: Parameters<typeof scenarioW>[0] = {}
): Promise<{ scenario: Scenario; config: AgentConfig; t: TestHost; session: DurableSession }> {
  const config = overrides.config ?? scenarioConfig()
  const scenario = await scenarioW({ ...overrides, config })
  const session = await lockedTurn(scenario)
  return { scenario, config, t: scenario.t, session }
}

function reconfigure(session: DurableSession, label = 'reconfigure'): Promise<ReconfigureOutcome> {
  return withTimeout(session.reconfigureAgent(), 5000, label)
}

/** 再答一轮（下一个请求） */
async function sendNext(t: TestHost, session: DurableSession, text = 'next'): Promise<void> {
  t.kit.queue(answer(`re:${text}`))
  expect(await withTimeout(session.submitUser(text), 5000, `send ${text}`)).toEqual({})
}

async function lastDelta(session: DurableSession): Promise<SystemDelta> {
  const deltas = await systemDeltas(await session.currentConversation())
  return deltas[deltas.length - 1]!
}

function agentExtension(t: TestHost): Extension | undefined {
  return t.registryOf('s1')!.snapshot().extension('shuvix.agent.1')
}

describe('lock · reconfigure: what changes and how it is committed', () => {
  it('RL-1 adding a server: one commit of pi.agent + the lock; the new tool goes last; nothing else about the agent changes; the next request adds exactly that tool', async () => {
    const { t, config, session } = await lockedW()
    const before = session.lock!
    const mirror = [...t.mirror]
    const resolves = t.toolHost.resolveCalls.length
    const builtins = t.toolHost.builtinCalls.length
    const recorder = recordPublications(session.harness)

    config.toolOverlay = [...OVERLAY, 'mcp:new']
    const outcome = await reconfigure(session)
    recorder.stop()

    expect(outcome.applied).toBe(true)
    const lock = session.lock!
    expect(outcome.record).toEqual(lock)
    expect(lock).toEqual(
      lockW({
        toolNames: [...E_W, 'mcp__new__fresh'],
        mcp: { ctx: [DECL_RESOLVE, DECL_DOCS], new: [NEW_DECL] },
        selection: [...OVERLAY, 'mcp:new']
      })
    )
    // 身份类的字段一个不动
    for (const key of [
      'conversationId',
      'createdAt',
      'profileName',
      'kind',
      'extensions',
      'sandboxed',
      'thinkingLevel',
      'skills',
      'model'
    ] as const) {
      expect(lock[key]).toEqual(before[key])
    }
    expect(await storedLock(session)).toEqual(lock)
    expect(((await piAgent(session)) as { tools: string[] }).tools).toEqual(lock.toolNames)
    expect(extensionTools(t, 'shuvix.agent.1')).toEqual([
      'agent',
      'skill',
      'mcp__ctx__resolve',
      'mcp__ctx__docs',
      'mcp__new__fresh'
    ])

    // 一个提交：pi.agent + 锁；人设没变 → 不碰 agent-state
    expect(recorder.publications).toHaveLength(1)
    expect(recorder.publications[0]!.docs).toEqual(
      expect.arrayContaining(['pi.agent#1', 'shuvix.session-state'])
    )
    expect(recorder.touching('shuvix.agent-state#1')).toEqual([])

    expect(t.toolHost.reconfigureCalls).toEqual([
      {
        request: {
          sessionId: 's1',
          names: normalizeToolNames('root', W_PROFILE_TOOLS, [...OVERLAY, 'mcp:new']),
          servers: ['new']
        },
        connect: true
      }
    ])
    expect(t.toolHost.resolveCalls).toHaveLength(resolves)
    expect(t.toolHost.builtinCalls).toHaveLength(builtins)
    expect(t.broadcastsOf('agent_created')).toHaveLength(1)
    expect(t.broadcastsOf('agent_closing')).toEqual([])
    expect(t.mirror).toEqual(mirror)
    expect(t.toolHost.mcp('new').connects).toBe(1)

    await sendNext(t, session)
    expect(offered(t, 1)).toEqual([...E_W, 'mcp__new__fresh'])
    expect(await lastDelta(session)).toEqual({
      sections: [],
      toolsAdded: ['mcp__new__fresh'],
      toolsRemoved: []
    })
    expect(await toolDeltaCount(await session.currentConversation())).toBe(2)
  })

  it('RL-2 removing a server: the next delta removes exactly its tools and adds nothing; the server is not touched', async () => {
    const { t, config, session } = await lockedW()
    const ctx = t.toolHost.mcp('ctx')
    const connects = ctx.connects
    config.toolOverlay = []
    expect((await reconfigure(session)).applied).toBe(true)
    expect(session.lock!.mcp).toEqual({})
    expect(session.lock!.toolNames).toEqual(E_W.filter((name) => !name.startsWith('mcp__ctx__')))
    expect(t.toolHost.reconfigureCalls[0]!.request.servers).toEqual([])

    await sendNext(t, session)
    expect(await lastDelta(session)).toEqual({
      sections: [],
      toolsAdded: [],
      toolsRemoved: ['mcp__ctx__resolve', 'mcp__ctx__docs']
    })
    expect(ctx.connects).toBe(connects)
  })

  it('RL-3 a kept server keeps its locked declarations although the server changed its list; it is never reconnected', async () => {
    const { t, config, session } = await lockedW()
    const ctx = t.toolHost.mcp('ctx')
    const connects = ctx.connects
    ctx.setTools([DECL_RESOLVE])
    config.toolOverlay = [...OVERLAY, 'mcp:new']
    expect((await reconfigure(session)).applied).toBe(true)
    expect(session.lock!.mcp.ctx).toEqual([DECL_RESOLVE, DECL_DOCS])
    await sendNext(t, session)
    expect(offered(t, 1)).toContain('mcp__ctx__docs')
    expect(ctx.connects).toBe(connects)
    expect(t.toolHost.reconfigureCalls[0]!.request.servers).toEqual(['new'])
  })

  it('RL-4 a server removed and later re-added is connected again and picks up its current list', async () => {
    const { t, config, session } = await lockedW()
    const ctx = t.toolHost.mcp('ctx')
    config.toolOverlay = []
    expect((await reconfigure(session)).applied).toBe(true)
    const extra = mcpDecl('extra')
    ctx.setTools([DECL_RESOLVE, extra])
    const connects = ctx.connects
    config.toolOverlay = [...OVERLAY]
    expect((await reconfigure(session)).applied).toBe(true)
    expect(t.toolHost.reconfigureCalls[1]!.request.servers).toEqual(['ctx'])
    expect(ctx.connects).toBe(connects + 1)
    expect(session.lock!.mcp.ctx).toEqual([DECL_RESOLVE, extra])
    expect(session.lock!.toolNames).toContain('mcp__ctx__extra')
    expect(session.lock!.toolNames).not.toContain('mcp__ctx__docs')
  })

  it('RL-5 skills are fixed at creation: after the host enabled other skills, a reconfigure (here adding a server) keeps the installed skill tool object, its place and lock.skills; the next delta adds only the server tool', async () => {
    const { t, config, session } = await lockedW()
    const skillTool = agentExtension(t)!.tools!.find((tool) => tool.name === 'skill')
    expect(skillTool).toBeDefined()
    t.toolHost.options.skills = ['pdf', 'builtin:widget']
    config.toolOverlay = [...OVERLAY, 'mcp:new']
    expect((await reconfigure(session)).applied).toBe(true)
    const lock = session.lock!
    expect(lock.skills).toEqual(['builtin:drawing', 'pdf'])
    expect(lock.toolNames).toEqual([...E_W, 'mcp__new__fresh'])
    expect(agentExtension(t)!.tools!.find((tool) => tool.name === 'skill')).toBe(skillTool)
    expect(toolDescription(t, 'shuvix.agent.1', 'skill')).toBe(
      'skill: load a skill (builtin:drawing, pdf)'
    )

    await sendNext(t, session)
    expect(offered(t, 1)).toEqual(lock.toolNames)
    expect(await lastDelta(session)).toEqual({
      sections: [],
      toolsAdded: ['mcp__new__fresh'],
      toolsRemoved: []
    })
  })

  it.each([
    ['an opt-out of a skill', ['-skill:builtin:drawing']],
    ['a tick of a skill', ['skill:other']]
  ])(
    'RL-5 variant: a legacy skill entry in the selection (%s) changes neither the skill tool nor lock.skills; only the recorded selection follows; no tool delta',
    async (_label, legacy) => {
      const { t, config, session } = await lockedW()
      const before = session.lock!
      const skillTool = agentExtension(t)!.tools!.find((tool) => tool.name === 'skill')
      config.toolOverlay = [...OVERLAY, ...legacy]
      // 记录的勾选变了（锁照原样记它），所以算一次提交；工具一个不变
      expect((await reconfigure(session)).applied).toBe(true)
      const lock = session.lock!
      expect(lock.selection).toEqual([...OVERLAY, ...legacy])
      expect(lock.toolNames).toEqual(before.toolNames)
      expect(lock.skills).toEqual(before.skills)
      expect(lock.mcp).toEqual(before.mcp)
      expect(agentExtension(t)!.tools!.find((tool) => tool.name === 'skill')).toBe(skillTool)
      expect(t.toolHost.reconfigureCalls[0]!.request.names).toEqual(
        normalizeToolNames('root', W_PROFILE_TOOLS, OVERLAY)
      )
      await sendNext(t, session)
      expect(offered(t, 1)).toEqual(E_W)
      expect(await toolDeltaCount(await session.currentConversation())).toBe(1)
    }
  )

  it('RL-5 variant: an agent created with an empty shelf stays without the skill tool after the host enabled a skill; only a recreated agent gets it', async () => {
    const { t, config, session } = await lockedW({ toolHost: scenarioToolHost({ skills: [] }) })
    expect(session.lock!.toolNames).not.toContain('skill')
    t.toolHost.options.skills = ['pdf']
    config.toolOverlay = [...OVERLAY, 'mcp:new']
    expect((await reconfigure(session)).applied).toBe(true)
    expect(session.lock!.skills).toEqual([])
    expect(session.lock!.toolNames).not.toContain('skill')
    expect(extensionTools(t, 'shuvix.agent.1')).not.toContain('skill')

    await session.destroyAgent()
    await session.createAgent()
    expect(session.lock!.skills).toEqual(['pdf'])
    expect(toolDescription(t, 'shuvix.agent.1', 'skill')).toBe('skill: load a skill (pdf)')
  })

  it('RL-6 opting out of an entry the profile declares is a removal like any other', async () => {
    const config = scenarioConfig()
    config.profile = { ...config.profile, tools: [...W_PROFILE_TOOLS, 'mcp:ctx'] }
    config.toolOverlay = []
    const { t, session } = await lockedW({ config })
    expect(session.lock!.mcp).toHaveProperty('ctx')
    config.toolOverlay = ['-mcp:ctx']
    expect((await reconfigure(session)).applied).toBe(true)
    expect(session.lock!.mcp).toEqual({})
    expect(session.lock!.selection).toEqual(['-mcp:ctx'])
    await sendNext(t, session)
    expect(await lastDelta(session)).toEqual({
      sections: [],
      toolsAdded: [],
      toolsRemoved: ['mcp__ctx__resolve', 'mcp__ctx__docs']
    })
  })

  it('RL-7 a model change: the record and pi.agent carry faux-2, the next request runs on it with no tool delta; the live thinking level survives and the record keeps the creation-time level', async () => {
    const { t, config, session } = await lockedW()
    await session.setThinkingLevel('high')
    config.model = { provider: 'faux', modelId: 'faux-2' }
    expect((await reconfigure(session)).applied).toBe(true)
    expect(session.lock!.model).toEqual({ provider: 'faux', modelId: 'faux-2' })
    expect(session.lock!.thinkingLevel).toBe('low')
    expect(session.lock!.toolNames).toEqual(E_W)
    expect(((await piAgent(session)) as { model: unknown }).model).toEqual({
      provider: 'faux',
      modelId: 'faux-2'
    })
    expect(t.toolHost.reconfigureCalls[0]!.request.servers).toEqual([])

    await sendNext(t, session)
    expect(t.kit.requests[1]!.modelId).toBe('faux-2')
    expect(t.kit.requests[1]!.options?.reasoning).toBe('high')
    expect(offered(t, 1)).toEqual(offered(t, 0))
    expect(await toolDeltaCount(await session.currentConversation())).toBe(1)
  })

  it('RL-8 model and tools changed together land in one commit', async () => {
    const { t, config, session } = await lockedW()
    const recorder = recordPublications(session.harness)
    config.model = { provider: 'faux', modelId: 'faux-2' }
    config.toolOverlay = [...OVERLAY, 'mcp:new']
    expect((await reconfigure(session)).applied).toBe(true)
    recorder.stop()
    expect(recorder.touching('pi.agent#1')).toHaveLength(1)
    expect(recorder.touching('shuvix.session-state')).toEqual(recorder.touching('pi.agent#1'))
    expect(session.lock!.model.modelId).toBe('faux-2')
    expect(session.lock!.mcp).toHaveProperty('new')
    await sendNext(t, session)
    expect(t.kit.requests[1]!.modelId).toBe('faux-2')
    expect(offered(t, 1)).toContain('mcp__new__fresh')
  })

  it('RL-9 nothing changed → {applied: false} with the same lock; no publication; the agent extension is the same object; the host was asked once with no servers', async () => {
    const { t, session } = await lockedW()
    const before = session.lock!
    const extension = agentExtension(t)
    const recorder = recordPublications(session.harness)
    const outcome = await reconfigure(session)
    recorder.stop()
    expect(outcome.applied).toBe(false)
    expect(outcome.record).toEqual(before)
    expect(session.lock).toEqual(before)
    expect(recorder.publications).toEqual([])
    expect(agentExtension(t)).toBe(extension)
    expect(t.toolHost.reconfigureCalls).toHaveLength(1)
    expect(t.toolHost.reconfigureCalls[0]!.request.servers).toEqual([])
  })
})

describe('lock · reconfigure: refusals and failures', () => {
  it('RL-10 no lock → {applied: false}; neither the config nor the host is asked', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    expect(await reconfigure(session)).toEqual({ applied: false })
    expect(t.configCalls).toEqual([])
    expect(t.toolHost.reconfigureCalls).toEqual([])
    expect(session.lock).toBeUndefined()
  })

  it('RL-11 a host without reconfigureAgentTools → AgentCreationError unsupported; the config is not read; the lock stays', async () => {
    const { t, session } = await lockedW({
      toolHost: scenarioToolHost({ reconfigure: false })
    })
    expect(t.toolHost.reconfigureAgentTools).toBeUndefined()
    const configCalls = t.configCalls.length
    const before = session.lock
    const error = await reconfigure(session).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AgentCreationError)
    expect(error).toMatchObject({ code: 'unsupported' })
    expect(t.configCalls).toHaveLength(configCalls)
    expect(session.lock).toEqual(before)
  })

  it.each<[string, (config: AgentConfig, t: TestHost) => void, string]>([
    [
      'an unknown model',
      (config) => (config.model = { provider: 'faux', modelId: 'faux-9' }),
      'model_unknown'
    ],
    [
      'a provider disabled through the port',
      (_config, t) => (t.port.rows[0]!.isEnabled = false),
      'provider_disabled'
    ],
    ['no model at all', (config) => delete config.model, 'no_model']
  ])(
    'RL-12 %s → AgentCreationError no_model (%#); nothing written, the host is not asked',
    async (_label, mutate, refusal) => {
      const { t, config, session } = await lockedW()
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      mutate(config, t)
      const before = session.lock
      const recorder = recordPublications(session.harness)
      const error = await reconfigure(session).catch((caught: unknown) => caught)
      recorder.stop()
      expect(error).toBeInstanceOf(AgentCreationError)
      expect(error).toMatchObject({ code: 'no_model', refusal })
      expect(recorder.publications).toEqual([])
      expect(t.toolHost.reconfigureCalls).toEqual([])
      expect(session.lock).toEqual(before)
      expect(t.toolHost.mcp('new').connects).toBe(0)
    }
  )

  it('RL-13 the host throws → the same error, untouched; nothing written, the agent extension is the same object', async () => {
    const { t, config, session } = await lockedW()
    const boom = new Error('boom')
    t.toolHost.failReconfigure = boom
    const extension = agentExtension(t)
    const before = session.lock
    const recorder = recordPublications(session.harness)
    config.toolOverlay = [...OVERLAY, 'mcp:new']
    const error = await reconfigure(session).catch((caught: unknown) => caught)
    recorder.stop()
    expect(error).toBe(boom)
    expect(recorder.publications).toEqual([])
    expect(agentExtension(t)).toBe(extension)
    expect(session.lock).toEqual(before)
    expect(await storedLock(session)).toEqual(before)
  })

  it('RL-14 an MCP server that cannot connect: applied without its tools (the selection keeps it), one error row; an unrelated change does not retry it; untick and re-tick does', async () => {
    const { t, config, session } = await lockedW()
    const fresh = t.toolHost.mcp('new')
    fresh.failConnect()
    config.toolOverlay = [...OVERLAY, 'mcp:new']
    const outcome = await reconfigure(session)
    expect(outcome.applied).toBe(true)
    expect(session.lock!.mcp).not.toHaveProperty('new')
    expect(session.lock!.toolNames).toEqual(E_W)
    expect(session.lock!.selection).toEqual([...OVERLAY, 'mcp:new'])
    const errors = (): string[] =>
      t.broadcastsOf('error').map((event) => (event as { error: string }).error)
    expect(errors()).toHaveLength(1)
    expect(errors()[0]).toContain('new')
    expect(fresh.connects).toBe(1)
    await sendNext(t, session, 'u2')
    expect(await toolDeltaCount(await session.currentConversation())).toBe(1)

    // 不相干的改动（换模型）不重试它，也不再报错
    config.model = { provider: 'faux', modelId: 'faux-2' }
    expect((await reconfigure(session)).applied).toBe(true)
    expect(t.toolHost.reconfigureCalls[1]!.request.servers).toEqual([])
    expect(fresh.connects).toBe(1)
    expect(errors()).toHaveLength(1)

    // 取消再勾上（这时服务器好了）→ 重试，工具到下一次请求
    config.toolOverlay = [...OVERLAY]
    expect((await reconfigure(session)).applied).toBe(true)
    fresh.heal()
    config.toolOverlay = [...OVERLAY, 'mcp:new']
    expect((await reconfigure(session)).applied).toBe(true)
    expect(t.toolHost.reconfigureCalls[3]!.request.servers).toEqual(['new'])
    expect(fresh.connects).toBe(2)
    expect(session.lock!.mcp.new).toEqual([NEW_DECL])
    await sendNext(t, session, 'u3')
    expect(offered(t, 2)).toContain('mcp__new__fresh')
    expect(errors()).toHaveLength(1)
  })
})

describe('lock · reconfigure: the persona', () => {
  it('RL-15 a reconfigure never touches the persona: even with a changed shelf on the host and a legacy skill entry in the selection, the commit carries pi.agent and the lock only, the frozen persona stays and the next delta has no persona section', async () => {
    const { t, config, session } = await lockedW()
    expect(t.kit.requests[0]!.systemPrompt).toBe('You are M1')
    t.toolHost.options.skills = ['pdf']
    const recorder = recordPublications(session.harness)
    config.toolOverlay = [...OVERLAY, '-skill:builtin:drawing', 'mcp:new']
    expect((await reconfigure(session)).applied).toBe(true)
    recorder.stop()
    expect(recorder.publications).toHaveLength(1)
    expect(recorder.publications[0]!.docs).toEqual(
      expect.arrayContaining(['pi.agent#1', 'shuvix.session-state'])
    )
    expect(recorder.touching('shuvix.agent-state#1')).toEqual([])
    expect(((await agentState(session)) as { persona: string }).persona).toBe('You are M1')

    await sendNext(t, session)
    expect(t.kit.requests[1]!.systemPrompt).toBe('You are M1')
    expect(await lastDelta(session)).toEqual({
      sections: [],
      toolsAdded: ['mcp__new__fresh'],
      toolsRemoved: []
    })
  })

  it('RL-16 environment drift (a var that changed since creation) is never resent: a reconfigure does not even call the vars', async () => {
    const { t, config, session, scenario } = await lockedW()
    const { vars } = scenario
    expect(vars.state.calls).toBe(1)
    vars.state.marker = 'M2'
    config.toolOverlay = []
    expect((await reconfigure(session)).applied).toBe(true)
    expect(vars.state.calls).toBe(1)
    expect(((await agentState(session)) as { persona: string }).persona).toBe('You are M1')
    await sendNext(t, session)
    expect(t.kit.requests[1]!.systemPrompt).toBe('You are M1')
    const deltas = await systemDeltas(await session.currentConversation())
    expect(deltas.slice(1).some((delta) => delta.sections.includes('persona'))).toBe(false)

    config.toolOverlay = ['mcp:ctx', 'mcp:new']
    expect((await reconfigure(session)).applied).toBe(true)
    expect(vars.state.calls).toBe(1)
  })

  it('RL-17 a lock created without a selection (old lock): the persona is left alone; the record gains the selection', async () => {
    const config = { ...scenarioConfig() }
    delete config.toolOverlay
    const { t, session, scenario } = await lockedW({ config })
    expect(session.lock!.selection).toBeUndefined()
    expect(t.kit.requests[0]!.systemPrompt).toBe('You are M1')
    const calls = scenario.vars.state.calls
    config.toolOverlay = ['mcp:new']
    expect((await reconfigure(session)).applied).toBe(true)
    expect(session.lock!.selection).toEqual(['mcp:new'])
    expect(session.lock!.skills).toEqual(['builtin:drawing', 'pdf'])
    expect(scenario.vars.state.calls).toBe(calls)
    expect(((await agentState(session)) as { persona: string }).persona).toBe('You are M1')
  })
})

describe('lock · reconfigure: while a run is going', () => {
  it(
    'RL-18 a change during a run applies from the next request of the same run',
    async () => {
      const gate = deferred()
      const running = deferred()
      const config = scenarioConfig()
      const scenario = await scenarioW({
        config,
        toolHost: scenarioToolHost({
          agentTools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
        })
      })
      const { t } = scenario
      const session = await t.open()
      t.kit.queue(callTool('hold'), answer('after'))
      const sending = session.submitUser('go')
      await withTimeout(running.promise, 5000, 'hold runs')
      config.model = { provider: 'faux', modelId: 'faux-2' }
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      expect((await reconfigure(session)).applied).toBe(true)
      expect(session.isBusy()).toBe(true)
      gate.resolve()
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      expect(t.kit.requests).toHaveLength(2)
      expect(t.kit.requests[0]!.modelId).toBe('faux-1')
      expect(offered(t, 0)).not.toContain('mcp__new__fresh')
      expect(t.kit.requests[1]!.modelId).toBe('faux-2')
      expect(offered(t, 1)).toEqual([...offered(t, 0), 'mcp__new__fresh'])
    },
    TIMEOUT
  )

  it(
    'RL-19 the request already streaming is not affected; it finishes on the old model and tools',
    async () => {
      const { t, config, session } = await lockedW()
      const slow = held(answer('slow'))
      t.kit.queue(slow.step)
      const sending = session.submitUser('u2')
      await withTimeout(slow.reached, 5000, 'request 1 reached')
      config.model = { provider: 'faux', modelId: 'faux-2' }
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      expect((await reconfigure(session)).applied).toBe(true)
      slow.release()
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      expect(t.kit.requests).toHaveLength(2)
      expect(t.kit.requests[1]!.modelId).toBe('faux-1')
      expect(offered(t, 1)).toEqual(offered(t, 0))
      const assistants = (await allEntries(await session.currentConversation())).filter(
        (entry) => entry.kind === 'pi.assistant'
      )
      expect(assistants).toHaveLength(2)

      await sendNext(t, session, 'u3')
      expect(t.kit.requests[2]!.modelId).toBe('faux-2')
      expect(offered(t, 2)).toContain('mcp__new__fresh')
    },
    TIMEOUT
  )

  it(
    'RL-20 a call the model already emitted for a tool that was removed meanwhile gets tool_unavailable; the server is never called and the run goes on',
    async () => {
      const { t, config, session } = await lockedW()
      const ctx = t.toolHost.mcp('ctx')
      const call = held(callTool('mcp__ctx__resolve', { q: 'x' }))
      t.kit.queue(call.step, answer('carried on'))
      const sending = session.submitUser('u2')
      await withTimeout(call.reached, 5000, 'request 1 reached')
      config.toolOverlay = []
      expect((await reconfigure(session)).applied).toBe(true)
      call.release()
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      expect(ctx.calls).toEqual([])
      expect(t.kit.requests).toHaveLength(3)
      const result = requestTexts(t.kit, 2).find((line) => line.startsWith('toolResult:'))
      expect(result).toContain('Tool mcp__ctx__resolve is not available')
      expect(offered(t, 2)).not.toContain('mcp__ctx__resolve')
    },
    TIMEOUT
  )

  it(
    'RL-21 a send right after a change waits for it (a slow MCP connect) and runs with it',
    async () => {
      const { t, config, session } = await lockedW()
      const hold = t.toolHost.mcp('new').holdConnect()
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const changing = session.reconfigureAgent()
      await withTimeout(hold.reached, 5000, 'connect reached')
      t.kit.queue(answer('second'))
      const sending = session.submitUser('u2')
      await sleep(50)
      expect(t.kit.requests).toHaveLength(1)
      hold.release()
      expect((await withTimeout(changing, 5000, 'reconfigure')).applied).toBe(true)
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      expect(offered(t, 1)).toContain('mcp__new__fresh')
    },
    TIMEOUT
  )
})

describe('lock · reconfigure: serialization and cancellation', () => {
  it(
    'RL-22 changes during a reconfigure coalesce into one queued run that reads the latest settings',
    async () => {
      const { t, config, session } = await lockedW()
      const hold = t.toolHost.mcp('new').holdConnect()
      const configCalls = t.configCalls.length
      const recorder = recordPublications(session.harness)
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const p1 = session.reconfigureAgent()
      await withTimeout(hold.reached, 5000, 'connect reached')
      config.toolOverlay = [...OVERLAY, 'mcp:new', 'mcp:other']
      const p2 = session.reconfigureAgent()
      config.toolOverlay = [...OVERLAY, 'mcp:new', 'mcp:other', 'mcp:ssh']
      const p3 = session.reconfigureAgent()
      hold.release()
      const [r1, r2, r3] = await withTimeout(Promise.all([p1, p2, p3]), 5000, 'reconfigures')
      recorder.stop()
      expect(r1.applied).toBe(true)
      expect(r2).toBe(r3)
      expect(r2.applied).toBe(true)
      expect(t.toolHost.reconfigureCalls).toHaveLength(2)
      expect(t.toolHost.reconfigureCalls[1]!.request.servers).toEqual(['other', 'ssh'])
      expect(t.configCalls).toHaveLength(configCalls + 2)
      expect(session.lock!.selection).toEqual([...OVERLAY, 'mcp:new', 'mcp:other', 'mcp:ssh'])
      expect(Object.keys(session.lock!.mcp)).toEqual(['ctx', 'new', 'other', 'ssh'])
      expect(recorder.touching('shuvix.session-state').length).toBeLessThanOrEqual(2)
    },
    TIMEOUT
  )

  it(
    'RL-23 a failed run does not stop the run queued behind it',
    async () => {
      const { t, config, session } = await lockedW()
      const gate = deferred()
      const reached = deferred()
      t.toolHost.beforeReconfigure = async () => {
        if (t.toolHost.reconfigureCalls.length !== 1) return
        reached.resolve()
        await gate.promise
        throw new Error('boom')
      }
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const p1 = session.reconfigureAgent()
      await withTimeout(reached.promise, 5000, 'first run reached')
      config.toolOverlay = [...OVERLAY, 'mcp:new', 'mcp:other']
      const p2 = session.reconfigureAgent()
      gate.resolve()
      await expect(withTimeout(p1, 5000, 'p1')).rejects.toThrow('boom')
      const second = await withTimeout(p2, 5000, 'p2')
      expect(second.applied).toBe(true)
      expect(t.toolHost.reconfigureCalls[1]!.request.servers).toEqual(['new', 'other'])
      expect(Object.keys(session.lock!.mcp)).toEqual(['ctx', 'new', 'other'])
    },
    TIMEOUT
  )

  it(
    'RL-24 destroying the agent cancels the reconfigure in flight and the one queued behind it: nothing written, the connect is aborted, the next send creates from the settings',
    async () => {
      const { t, config, session } = await lockedW()
      const signals: AbortSignal[] = []
      t.toolHost.beforeReconfigure = (signal) => void signals.push(signal)
      const hold = t.toolHost.mcp('new').holdConnect()
      const agentBefore = await piAgent(session)
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const r = session.reconfigureAgent()
      await withTimeout(hold.reached, 5000, 'connect reached')
      config.toolOverlay = [...OVERLAY, 'mcp:new', 'mcp:other']
      const r2 = session.reconfigureAgent()
      // 让 r2 进到锁里排上队（会话层先进回退区段，是异步的）
      await sleep(20)
      await withTimeout(session.destroyAgent(), 5000, 'destroy')
      for (const pending of [r, r2]) {
        const error = await withTimeout(pending, 5000, 'cancelled').catch(
          (caught: unknown) => caught
        )
        expect(error).toBeInstanceOf(AgentCreationError)
        expect(error).toMatchObject({ code: 'cancelled' })
      }
      expect(signals).toHaveLength(1)
      expect(signals[0]!.aborted).toBe(true)
      expect(t.toolHost.reconfigureCalls).toHaveLength(1)
      expect(session.lock).toBeUndefined()
      expect(await storedLock(session)).toBeUndefined()
      expect(await piAgent(session)).toEqual(agentBefore)
      expect(config.toolOverlay).toEqual([...OVERLAY, 'mcp:new', 'mcp:other'])
      hold.release()

      await sendNext(t, session, 'u2')
      expect(t.toolHost.resolveCalls).toHaveLength(2)
      expect(t.toolHost.resolveCalls[1]!.names).toContain('mcp:new')
      expect(offered(t, 1)).toContain('mcp__new__fresh')
      expect(offered(t, 1)).toContain('mcp__other__unused')
    },
    TIMEOUT
  )

  it(
    'RL-24b a host that rejects with its own error after the cancel still reports cancelled',
    async () => {
      const { t, config, session } = await lockedW()
      t.toolHost.beforeReconfigure = async (signal) => {
        await aborted(signal).catch(() => undefined)
        throw new Error('connection reset')
      }
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const r = session.reconfigureAgent()
      await waitFor(() => t.toolHost.reconfigureCalls.length === 1, 3000, 'host asked')
      await withTimeout(session.destroyAgent(), 5000, 'destroy')
      const error = await withTimeout(r, 5000, 'cancelled').catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AgentCreationError)
      expect(error).toMatchObject({ code: 'cancelled' })
    },
    TIMEOUT
  )

  it(
    'RL-24c destroying the agent while a reconfigure waits for an in-flight creation settles both (no deadlock)',
    async () => {
      const config = scenarioConfig()
      const scenario = await scenarioW({ config })
      const { t } = scenario
      const session = await t.open()
      const gate = deferred()
      const resolving = deferred()
      t.toolHost.beforeResolve = async (signal) => {
        resolving.resolve()
        await Promise.race([gate.promise, aborted(signal)])
      }
      const creating = session.createAgent()
      creating.catch(() => undefined)
      await withTimeout(resolving.promise, 5000, 'creation reached')
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const r = session.reconfigureAgent()
      r.catch(() => undefined)
      await sleep(20)
      await withTimeout(session.destroyAgent(), 5000, 'destroy')
      await expect(withTimeout(creating, 5000, 'creation')).rejects.toMatchObject({
        code: 'cancelled'
      })
      const outcome = await withTimeout(r, 5000, 'reconfigure').catch((caught: unknown) => caught)
      expect(outcome).toMatchObject({ code: 'cancelled' })
      expect(session.lock).toBeUndefined()
      expect(t.toolHost.reconfigureCalls).toEqual([])
    },
    TIMEOUT
  )

  it(
    'RL-25 a rollback cancels the reconfigure in flight',
    async () => {
      const { t, config, session } = await lockedW()
      await sendNext(t, session, 'u2')
      const u2 = (await allEntries(await session.currentConversation())).filter(
        (entry) => entry.kind === 'pi.user'
      )[1]!.id as number
      const hold = t.toolHost.mcp('new').holdConnect()
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const r = session.reconfigureAgent()
      await withTimeout(hold.reached, 5000, 'connect reached')
      const rollback = await withTimeout(session.rollbackTo(u2), 5000, 'rollback')
      expect(rollback.ok).toBe(true)
      const error = await withTimeout(r, 5000, 'cancelled').catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AgentCreationError)
      expect(error).toMatchObject({ code: 'cancelled' })
      expect(session.lock).toBeUndefined()
      hold.release()
    },
    TIMEOUT
  )

  it(
    'RL-26 closing the session cancels the reconfigure; the stored lock is the old one',
    async () => {
      const { t, config, session } = await lockedW()
      const before = session.lock!
      const hold = t.toolHost.mcp('new').holdConnect()
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const r = session.reconfigureAgent()
      await withTimeout(hold.reached, 5000, 'connect reached')
      await withTimeout(t.host.close('s1'), 5000, 'close')
      const error = await withTimeout(r, 5000, 'cancelled').catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect(['AgentCreationError', 'SessionClosedError']).toContain((error as Error).name)
      hold.release()
      const reopened = await t.open()
      expect(reopened.lock).toEqual(before)
      expect(await storedLock(reopened)).toEqual(before)
    },
    TIMEOUT
  )

  it(
    'RL-27 a stop (abort) during the connect does not cancel the reconfigure: it still lands (F3)',
    async () => {
      const { t, config, session } = await lockedW()
      const hold = t.toolHost.mcp('new').holdConnect()
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const r = session.reconfigureAgent()
      await withTimeout(hold.reached, 5000, 'connect reached')
      await withTimeout(session.abort(), 5000, 'abort')
      hold.release()
      expect((await withTimeout(r, 5000, 'reconfigure')).applied).toBe(true)
      expect(session.lock!.mcp).toHaveProperty('new')
    },
    TIMEOUT
  )

  it(
    'RL-28 a change while the creation is in flight is applied after the creation commits',
    async () => {
      const config = scenarioConfig()
      const { t } = await scenarioW({ config })
      const session = await t.open()
      const gate = deferred()
      const resolving = deferred()
      t.toolHost.beforeResolve = async () => {
        resolving.resolve()
        await gate.promise
      }
      const lockedWhenAsked: boolean[] = []
      t.toolHost.beforeReconfigure = () => void lockedWhenAsked.push(session.lock !== undefined)
      const creating = session.createAgent()
      await withTimeout(resolving.promise, 5000, 'creation reached')
      // 创建已经读过配置：这次改动要靠重配
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const r = session.reconfigureAgent()
      await sleep(20)
      expect(t.toolHost.reconfigureCalls).toEqual([])
      gate.resolve()
      const created = await withTimeout(creating, 5000, 'creation')
      expect(created.mcp).not.toHaveProperty('new')
      expect((await withTimeout(r, 5000, 'reconfigure')).applied).toBe(true)
      expect(lockedWhenAsked).toEqual([true])
      expect(session.lock!.mcp).toHaveProperty('new')
    },
    TIMEOUT
  )

  it(
    'RL-28 variant: a change made before the creation read the config is already in the agent → {applied: false}',
    async () => {
      const config = scenarioConfig()
      const { t } = await scenarioW({ config })
      const session = await t.open()
      const gate = deferred()
      const resolving = deferred()
      t.toolHost.beforeResolve = async () => {
        resolving.resolve()
        await gate.promise
      }
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      const creating = session.createAgent()
      await withTimeout(resolving.promise, 5000, 'creation reached')
      const r = session.reconfigureAgent()
      gate.resolve()
      expect((await withTimeout(creating, 5000, 'creation')).mcp).toHaveProperty('new')
      expect((await withTimeout(r, 5000, 'reconfigure')).applied).toBe(false)
    },
    TIMEOUT
  )

  it('RL-29 a reconfigure during a destroy → {applied: false}; the host is not asked', async () => {
    const { t, config, session } = await lockedW()
    config.toolOverlay = [...OVERLAY, 'mcp:new']
    const destroying = session.destroyAgent()
    const r = session.reconfigureAgent()
    await withTimeout(destroying, 5000, 'destroy')
    expect(await withTimeout(r, 5000, 'reconfigure')).toEqual({ applied: false })
    expect(t.toolHost.reconfigureCalls).toEqual([])
    expect(session.lock).toBeUndefined()
  })
})

describe('lock · reconfigure: reopen and restart', () => {
  it(
    'RL-30 close and reopen in the same process: the rebuild gets the reconfigured record; the first request after it has no tool delta and the same order',
    async () => {
      const { t, config, session } = await lockedW()
      config.toolOverlay = ['mcp:ctx', 'mcp:new']
      expect((await reconfigure(session)).applied).toBe(true)
      const record = session.lock!
      await sendNext(t, session, 'u2')
      const deltas = await toolDeltaCount(await session.currentConversation())
      await withTimeout(t.host.close('s1'), 5000, 'close')
      const reopened = await t.open()
      expect(t.toolHost.rebuildCalls.at(-1)).toEqual(record)
      expect(reopened.lock).toEqual(record)
      await sendNext(t, reopened, 'u3')
      expect(offered(t, 2)).toEqual(offered(t, 1))
      expect(offered(t, 2)).toEqual(record.toolNames)
      expect(await toolDeltaCount(await reopened.currentConversation())).toBe(deltas)
    },
    TIMEOUT
  )

  it(
    'RL-31 a restart with resumable work fully initializes the reconfigured lock, connecting the newly added server',
    async () => {
      const { t, config, session } = await lockedW()
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      expect((await reconfigure(session)).applied).toBe(true)
      const record = session.lock!
      const stall = stalled()
      t.kit.queue(stall.step)
      void session.submitUser('stalled')
      await withTimeout(stall.reached, 5000, 'stalled')
      const t2 = await t.restart()
      const reopened = await t2.open()
      expect(reopened.lock).toEqual(record)
      expect(t2.toolHost.rebuildCalls).toEqual([record])
      expect(t2.toolHost.mcp('new').connects).toBe(1)
      expect(t2.toolHost.mcp('ctx').connects).toBe(1)
    },
    TIMEOUT
  )

  it(
    'RL-35 (WT4-DL-04) after the host enabled another skill, a reconfigure neither rebuilds the builtins nor changes the recorded shelf; a restart with resumable work rebuilds them with the shelf the lock recorded at creation',
    async () => {
      const { t, config, session } = await lockedW()
      expect(t.toolHost.builtinCalls).toEqual([
        { sessionId: 's1', sandboxed: true, skills: ['builtin:drawing', 'pdf'] }
      ])
      t.toolHost.options.skills = ['builtin:drawing', 'pdf', 'builtin:widget']
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      expect((await reconfigure(session)).applied).toBe(true)
      const record = session.lock!
      expect(record.skills).toEqual(['builtin:drawing', 'pdf'])
      // 重配不重装内置工具（会话级、按根 agent 的货架定描述的那几个工具只在创建 / 重建时定）
      expect(t.toolHost.builtinCalls).toHaveLength(1)

      const stall = stalled()
      t.kit.queue(stall.step)
      void session.submitUser('stalled')
      await withTimeout(stall.reached, 5000, 'stalled')
      const t2 = await t.restart()
      const reopened = await t2.open()
      expect(reopened.isInterrupted()).toBe(true)
      expect(reopened.lock).toEqual(record)
      expect(t2.toolHost.builtinCalls).toStrictEqual([
        { sessionId: 's1', sandboxed: true, skills: ['builtin:drawing', 'pdf'] }
      ])
    },
    TIMEOUT
  )

  it(
    'RL-32 an idle restart clears the lock; the next send creates the agent from the settings, change included',
    async () => {
      const { t, config, session } = await lockedW()
      config.toolOverlay = [...OVERLAY, 'mcp:new']
      expect((await reconfigure(session)).applied).toBe(true)
      const t2 = await t.restart()
      const reopened = await t2.open()
      expect(reopened.lock).toBeUndefined()
      t2.kit.queue(answer('again'))
      expect(await withTimeout(reopened.submitUser('u2'), 5000, 'send')).toEqual({})
      expect(t2.toolHost.resolveCalls).toHaveLength(1)
      expect(t2.toolHost.resolveCalls[0]!.names).toContain('mcp:new')
      expect(names(requestTools(t2.kit, 0))).toContain('mcp__new__fresh')
      expect(reopened.lock!.conversationId).toBe(ROOT_CONVERSATION_ID)
    },
    TIMEOUT
  )

  it(
    'RL-34 a sequence of reconfigures, each followed by a request: no delta ever removes a tool that stayed the same, and the order offered is always the record order',
    async () => {
      const { t, config, session } = await lockedW()
      const steps: (() => void)[] = [
        () => (config.toolOverlay = [...OVERLAY, 'mcp:new']),
        () => (config.toolOverlay = ['mcp:new']),
        () => (config.toolOverlay = ['mcp:new', 'mcp:ssh']),
        () => (config.toolOverlay = ['mcp:ctx', 'mcp:new', 'mcp:ssh']),
        () => (config.toolOverlay = ['mcp:ctx', 'mcp:ssh']),
        () => (config.model = { provider: 'faux', modelId: 'faux-2' })
      ]
      let previous = requestTools(t.kit, 0)
      for (const [index, step] of steps.entries()) {
        step()
        expect((await reconfigure(session, `reconfigure ${index}`)).applied).toBe(true)
        await sendNext(t, session, `u${index}`)
        const now = requestTools(t.kit, index + 1)
        expect(names(now)).toEqual(session.lock!.toolNames)
        const unchanged = previous
          .filter((tool) => {
            const next = now.find((candidate) => candidate.name === tool.name)
            return next !== undefined && JSON.stringify(next) === JSON.stringify(tool)
          })
          .map((tool) => tool.name)
        const delta = await lastDelta(session)
        for (const name of unchanged) expect(delta.toolsRemoved).not.toContain(name)
        previous = now
      }
    },
    TIMEOUT
  )
})
