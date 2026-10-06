/**
 * 派生 agent 的 ToolHost 契约（P2-02）：请求的平铺可选字段（PIN-01/02）、`canSpawn` 闸门、按派生 agent
 * 记录重建（`next` 由运行时按结果契约造好、经重建上下文交给宿主，PIN-03 R）、工具次序、root 锁的回归、
 * 会话锁里出现 spawned 当写坏了（PIN-08）、测试替身的派生支持。
 *
 * A/B/C/E/G 段直接调测试 ToolHost 与纯函数；F 段跑在真 Harness 上（重启用 SQLite）。用例编号 P2-02-xx。
 */
import { ROOT_CONVERSATION_ID, type ToolRegistration } from '@earendil-works/pi-durable'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { NextTool, resultContractTools, type ResultContract } from '../../subagent/nextTool'
import { invokeTool, resultText } from '../../tools/testing/invokeTool'
import { canSpawnAt, MAX_AGENT_DEPTH, type SpawnedAgentRecord } from '../agentRecord'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import { AgentCreationError, composeAgentTools, lockRecordJson } from '../lock'
import type {
  AgentToolSet,
  AgentToolsRebuildContext,
  AgentToolsRequest,
  ResolvedAgentTools
} from '../seams'
import { DECL_DOCS, DECL_RESOLVE, scenarioToolHost, testProfile } from './support/agentConfig'
import { registerHostCleanup } from './support/host'
import { mcpDecl } from './support/mcpFake'
import { extensionTools, lockW, scenarioW, storedLock } from './support/scenario'
import { rec } from './support/spawn'
import {
  makeTestToolHost,
  scenarioBuiltins,
  type TestToolHost,
  type TestToolHostOptions
} from './support/toolHost'
import { holdTool } from './support/tools'
import { aborted } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000

// ─────────────────────────── 夹具 ───────────────────────────

const S = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }

const nextOf = (schema: Record<string, unknown> = S): NextTool => new NextTool(schema)

const probe = holdTool('probe', Promise.resolve())

const B = scenarioBuiltins('darwin', true)

const names = (tools: readonly { name: string }[] | undefined): string[] =>
  (tools ?? []).map((tool) => tool.name)

/** 一个测试 ToolHost（场景 W 的技能 / 假 MCP，按 agent 的工具 = [probe]） */
function makeT(overrides: Partial<TestToolHostOptions> = {}): {
  T: TestToolHost
  pushed: ChatEvent[]
} {
  const pushed: ChatEvent[] = []
  const T = makeTestToolHost(scenarioToolHost({ agentTools: [probe], ...overrides }), (event) =>
    pushed.push(event)
  )
  return { T, pushed }
}

/** 派生 agent 的解析请求（没有 conversationId，PIN-01） */
function spawnReq(overrides: Partial<AgentToolsRequest> = {}): AgentToolsRequest {
  return {
    sessionId: 's1',
    kind: 'spawned',
    rootSessionId: 's1',
    selfSessionId: 'sub-a1',
    agentId: 'sub-a1',
    canSpawn: true,
    profile: testProfile({ name: 'explore' }),
    names: ['read', 'ls', 'grep', 'agent', 'skill:pdf', 'mcp:ctx'],
    model: { provider: 'faux', modelId: 'faux-2' },
    cwd: '',
    ...overrides
  }
}

const SP_TOOL_NAMES = [
  'read',
  'ls',
  'grep',
  'agent',
  'skill',
  'mcp__ctx__resolve',
  'mcp__ctx__docs',
  'probe',
  'next'
]

/** 派生 agent 记录（P2-01 的 rec() + 能派生 / 技能 pdf / MCP ctx / 结果契约） */
function SP(overrides: Partial<SpawnedAgentRecord> = {}): SpawnedAgentRecord {
  return rec({
    toolNames: [...SP_TOOL_NAMES],
    canSpawn: true,
    skills: ['pdf'],
    mcp: { ctx: [DECL_RESOLVE, DECL_DOCS] },
    resultContract: { schema: S },
    ...overrides
  })
}

/** 运行时给派生 agent 的重建上下文（PIN-03 R：next 按结果契约现造） */
function rebuildCtx(record: SpawnedAgentRecord): AgentToolsRebuildContext {
  return { sessionId: 's1', extraTools: resultContractTools(record.resultContract) }
}

const signal = (): AbortSignal => new AbortController().signal

async function resolveSpawned(
  T: TestToolHost,
  overrides: Partial<AgentToolsRequest> = {}
): Promise<ResolvedAgentTools> {
  return T.resolveAgentTools(spawnReq(overrides), { signal: signal() })
}

async function rebuild(
  T: TestToolHost,
  record: SpawnedAgentRecord = SP(),
  context: AgentToolsRebuildContext = rebuildCtx(record)
): Promise<AgentToolSet> {
  return T.rebuildAgentTools(record, context)
}

// ─────────────────────────── A. 请求形状 ───────────────────────────

describe('spawned tools · request shape', () => {
  it('P2-02-01 type contract: flat optional fields; rebuild takes a record and a context with extras; AgentToolSet takes extras', () => {
    const r: AgentToolsRequest = spawnReq()
    expect(r.kind).toBe('spawned')
    expectTypeOf<AgentToolsRequest['canSpawn']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<AgentToolsRequest['agentId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<AgentToolsRequest['extraTools']>().toEqualTypeOf<
      readonly ToolRegistration[] | undefined
    >()
    const { T } = makeT()
    // 两种记录都收（编译期检查；调用本身也不抛）
    expect(() => T.rebuildAgentTools(SP(), rebuildCtx(SP()))).not.toThrow()
    expect(() => T.rebuildAgentTools(lockW(), { sessionId: 's1' })).not.toThrow()
    const set: AgentToolSet = { extraTools: [nextOf()] }
    expect(names(set.extraTools)).toEqual(['next'])
  })

  it('P2-02-02 the root request is unchanged: no agentId / canSpawn / extraTools keys (PIN-02)', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    const request = t.toolHost.resolveCalls[0]!
    expect(Object.keys(request).sort()).toEqual([
      'conversationId',
      'cwd',
      'kind',
      'model',
      'names',
      'profile',
      'rootSessionId',
      'selfSessionId',
      'sessionId',
      'thinkingLevel'
    ])
    expect(request.conversationId).toBe(1)
    expect(request.selfSessionId).toBe('s1')
    expect(request.kind).toBe('root')
  })

  it('P2-02-03 the double records a spawned request verbatim (extras are the same objects; no conversationId)', async () => {
    const { T } = makeT()
    const n1 = nextOf()
    const request = spawnReq({ extraTools: [n1] })
    await T.resolveAgentTools(request, { signal: signal() })
    expect(T.resolveCalls[0]).toEqual(request)
    expect(T.resolveCalls[0]!.extraTools![0]).toBe(n1)
    expect('conversationId' in T.resolveCalls[0]!).toBe(false)
    expect(T.resolveCalls[0]!.selfSessionId).toBe('sub-a1')
    expect(T.resolveCalls[0]!.agentId).toBe('sub-a1')
  })
})

// ─────────────────────────── B. canSpawn 闸门 ───────────────────────────

describe('spawned tools · the canSpawn gate', () => {
  it.each([
    ['true', true, true],
    ['false', false, false],
    ['absent (fail closed)', undefined, false]
  ] as const)(
    'P2-02-04 canSpawn %s → agent tool %s; skills and MCP are resolved either way',
    async (_label, canSpawn, offered) => {
      const { T } = makeT()
      const request = spawnReq()
      if (canSpawn === undefined) delete request.canSpawn
      else request.canSpawn = canSpawn
      const resolved = await T.resolveAgentTools(request, { signal: signal() })
      if (offered) expect(resolved.agent?.name).toBe('agent')
      else expect('agent' in resolved).toBe(false)
      expect(resolved.skill?.description).toBe('skill: load a skill (pdf)')
      expect(resolved.skills).toEqual(['pdf'])
      expect(
        (resolved.mcp ?? []).map((entry) => ({
          server: entry.server,
          declarations: entry.declarations,
          tools: names(entry.tools)
        }))
      ).toEqual([
        {
          server: 'ctx',
          declarations: [DECL_RESOLVE, DECL_DOCS],
          tools: ['mcp__ctx__resolve', 'mcp__ctx__docs']
        }
      ])
      expect(T.mcp('ctx').connects).toBe(1)
    }
  )

  it('P2-02-05 names without agent → no agent tool even with canSpawn', async () => {
    const { T } = makeT()
    const resolved = await resolveSpawned(T, { names: ['read'], canSpawn: true })
    expect('agent' in resolved).toBe(false)
  })

  it('P2-02-06 root ignores canSpawn (PIN-02): names with agent + canSpawn false → agent tool', async () => {
    const { T } = makeT()
    const resolved = await T.resolveAgentTools(
      {
        sessionId: 's1',
        conversationId: ROOT_CONVERSATION_ID,
        kind: 'root',
        rootSessionId: 's1',
        selfSessionId: 's1',
        canSpawn: false,
        profile: testProfile({ name: 'work' }),
        names: ['read', 'agent'],
        model: { provider: 'faux', modelId: 'faux-1' },
        cwd: ''
      },
      { signal: signal() }
    )
    expect(resolved.agent?.name).toBe('agent')
  })

  it('P2-02-07 compose never brings agent back from names (pure): leaving set.agent out is a sufficient gate', () => {
    const x = holdTool('skill', Promise.resolve())
    const composed = composeAgentTools({ names: ['read', 'agent'], builtin: B, set: { skill: x } })
    expect(composed.toolNames).toEqual(['read', 'skill'])
  })

  it.each([
    [0, 2, true],
    [1, 2, true],
    [2, 2, false],
    [3, 2, false],
    [2, 3, true],
    [1, 1, false]
  ] as const)('P2-02-08 canSpawnAt(%i, %i) → %s', (depth, max, expected) => {
    expect(canSpawnAt(depth, max)).toBe(expected)
  })

  it('P2-02-08 the default max is MAX_AGENT_DEPTH = 2 (the legacy DEFAULT_MAX_AGENT_DEPTH is gone, P2-05)', () => {
    expect(MAX_AGENT_DEPTH).toBe(2)
    expect(canSpawnAt(1)).toBe(true)
    expect(canSpawnAt(2)).toBe(false)
  })
})

// ─────────────────────────── C. 按记录重建 ───────────────────────────

describe('spawned tools · rebuild from the record', () => {
  it('P2-02-09 next is rebuilt from the stored schema (replay unsafe); it captures through details', async () => {
    const { T } = makeT()
    const set = await rebuild(T)
    expect(set.extraTools).toHaveLength(1)
    const next = set.extraTools![0]!
    expect(next.name).toBe('next')
    expect(next.replay).toBe('unsafe')
    expect(next.parameters).toMatchObject(S)
    // 非法的先调：同一实例捕获之后再调只会得到「已记录」（守卫在校验之前）
    const bad = await invokeTool(next, {})
    expect(bad.result.isError).toBe(true)
    const ok = await invokeTool(next, { title: 'x' })
    expect(ok.result.details).toEqual({ result: { title: 'x' } })
    expect(ok.result.control).toEqual({ terminate: true })

    const S2 = {
      type: 'object',
      required: ['verdict'],
      properties: { verdict: { type: 'string' } }
    }
    const contract: ResultContract = { schema: S2, nudges: 2, sourceLabel: 't' }
    const other = await rebuild(T, SP({ resultContract: contract }))
    expect(other.extraTools![0]!.parameters).toMatchObject(S2)
  })

  it('P2-02-10 next iff resultContract (PIN-09): toolNames do not decide it', async () => {
    const { T } = makeT()
    const without = await rebuild(T, SP({ resultContract: undefined }))
    expect('extraTools' in without).toBe(false)

    const notNamed = await rebuild(
      T,
      SP({ toolNames: SP_TOOL_NAMES.filter((name) => name !== 'next') })
    )
    expect(names(notNamed.extraTools)).toEqual(['next'])

    const namedOnly = await rebuild(T, SP({ resultContract: undefined }))
    expect(SP({ resultContract: undefined }).toolNames).toContain('next')
    expect(names(namedOnly.extraTools)).not.toContain('next')
    expect(resultContractTools(undefined)).toEqual([])
  })

  it('P2-02-11 no connect at rebuild; the MCP tools connect on their first call; an unknown server rebuilds fine', async () => {
    const { T } = makeT()
    const set = await rebuild(T)
    expect(
      (set.mcp ?? []).map((entry) => ({ server: entry.server, tools: names(entry.tools) }))
    ).toEqual([{ server: 'ctx', tools: ['mcp__ctx__resolve', 'mcp__ctx__docs'] }])
    expect(T.mcp('ctx').connects).toBe(0)
    expect(T.mcp('ctx').connected).toBe(false)
    const resolveTool = set.mcp![0]!.tools[0]!
    const inv = await invokeTool(resolveTool, {})
    expect(resultText(inv.result)).toBe('ctx.resolve:{}')
    expect(T.mcp('ctx').connects).toBe(1)

    await expect(
      Promise.resolve(rebuild(T, SP({ mcp: { gone: [mcpDecl('lost')] } })))
    ).resolves.toBeDefined()
  })

  it.each([
    [true, true, true],
    [false, true, false],
    [true, false, false],
    [false, false, false]
  ] as const)(
    'P2-02-12 rebuild: canSpawn %s, toolNames has agent %s → agent tool %s',
    async (canSpawn, named, offered) => {
      const { T } = makeT()
      const toolNames = named ? SP_TOOL_NAMES : SP_TOOL_NAMES.filter((name) => name !== 'agent')
      const set = await rebuild(T, SP({ canSpawn, toolNames }))
      if (offered) expect(set.agent?.name).toBe('agent')
      else expect('agent' in set).toBe(false)
    }
  )

  it('P2-02-13 skills: [pdf] → a skill tool listing pdf; [] → no skill key', async () => {
    const { T } = makeT()
    expect((await rebuild(T)).skill?.description).toBe('skill: load a skill (pdf)')
    expect('skill' in (await rebuild(T, SP({ skills: [] })))).toBe(false)
  })

  it('P2-02-14 host resources are looked up by the session id, never the agent id (PIN-10); the logs', async () => {
    const seen: string[] = []
    const { T } = makeT({
      agentTools: (sessionId) => {
        seen.push(sessionId)
        return [probe]
      }
    })
    const set = await rebuild(T)
    expect(seen).toEqual(['s1'])
    expect(seen).not.toContain('sub-a1')
    expect(names(set.tools)).toEqual(['probe'])
    expect(T.rebuildCalls).toEqual([SP()])
    expect(T.resolveCalls).toEqual([])
    expect(T.rebuildContexts).toEqual([rebuildCtx(SP())])
  })

  it('P2-02-15 the knobs apply to spawned rebuilds (failRebuild, omitOnRebuild on extras and agent)', async () => {
    const { T } = makeT()
    const boom = new Error('boom')
    T.failRebuild = boom
    expect(() => T.rebuildAgentTools(SP(), rebuildCtx(SP()))).toThrow(boom)
    expect(T.rebuildCalls).toEqual([SP()])
    T.failRebuild = undefined

    T.omitOnRebuild.add('next')
    expect(names((await rebuild(T)).extraTools)).not.toContain('next')
    T.omitOnRebuild.clear()
    T.omitOnRebuild.add('agent')
    expect('agent' in (await rebuild(T))).toBe(false)
  })
})

// ─────────────────────────── E. 次序 ───────────────────────────

describe('spawned tools · composition and order', () => {
  const tool = (name: string): ToolRegistration => holdTool(name, Promise.resolve())

  it('P2-02-26 spawned golden order: builtins → agent → skill → MCP → host tools → next', () => {
    const agent = tool('agent')
    const skill = tool('skill')
    const resolve = tool('mcp__ctx__resolve')
    const docs = tool('mcp__ctx__docs')
    const n = nextOf()
    const set: AgentToolSet = {
      agent,
      skill,
      mcp: [{ server: 'ctx', tools: [resolve, docs] }],
      tools: [probe]
    }
    const composed = composeAgentTools({
      names: spawnReq().names,
      builtin: B,
      set,
      extraTools: [n]
    })
    expect(composed.toolNames).toEqual(SP_TOOL_NAMES)
    expect(names(composed.agentTools)).toEqual([
      'agent',
      'skill',
      'mcp__ctx__resolve',
      'mcp__ctx__docs',
      'probe',
      'next'
    ])
    expect(names(composed.tools)).toEqual(composed.toolNames)
    expect(composed.tools[8]).toBe(n)

    const { agent: _agent, ...withoutAgent } = set
    const gated = composeAgentTools({
      names: spawnReq().names,
      builtin: B,
      set: withoutAgent,
      extraTools: [n]
    })
    expect(gated.toolNames).toEqual(SP_TOOL_NAMES.filter((name) => name !== 'agent'))

    const empty = composeAgentTools({ names: spawnReq().names, builtin: B, set, extraTools: [] })
    const omitted = composeAgentTools({ names: spawnReq().names, builtin: B, set })
    expect(empty).toEqual(omitted)
    expect(names(empty.tools)).toEqual(names(omitted.tools))
  })

  it('P2-02-27 next collides with a builtin and a host tool: the extra is removed from both and appended', () => {
    const read = B.find((t) => t.name === 'read')!
    const bNext = tool('next')
    const hNext = tool('next')
    const n = nextOf()
    const composed = composeAgentTools({
      names: ['read', 'next'],
      builtin: [read, bNext],
      set: { tools: [hNext, probe] },
      extraTools: [n]
    })
    expect(composed.toolNames).toEqual(['read', 'probe', 'next'])
    expect(names(composed.agentTools)).toEqual(['probe', 'next'])
    expect(composed.tools[2]).toBe(n)
  })

  it('P2-02-28 duplicate extras get one slot, the last one wins (PIN-07)', () => {
    const nA = nextOf()
    const nB = nextOf()
    const composed = composeAgentTools({
      names: ['read'],
      builtin: B,
      set: {},
      extraTools: [nA, nB]
    })
    expect(composed.toolNames).toEqual(['read', 'next'])
    expect(names(composed.agentTools)).toEqual(['next'])
    expect(composed.agentTools[0]).toBe(nB)
    expect(composed.tools.at(-1)).toBe(nB)
  })

  it('P2-02-29 creation and rebuild produce the same tools', async () => {
    const { T } = makeT()
    const resolved = await resolveSpawned(T, { extraTools: [nextOf()] })
    const req = spawnReq()
    const c1 = composeAgentTools({
      names: req.names,
      builtin: B,
      set: resolved,
      ...(resolved.extraTools === undefined ? {} : { extraTools: resolved.extraTools })
    })
    const r = SP({
      toolNames: c1.toolNames,
      skills: [...(resolved.skills ?? [])],
      mcp: { ctx: [...resolved.mcp![0]!.declarations] }
    })
    const set = await rebuild(T, r)
    const c2 = composeAgentTools({
      names: r.toolNames,
      builtin: B,
      set,
      ...(set.extraTools === undefined ? {} : { extraTools: set.extraTools })
    })
    expect(c1.toolNames).toEqual(r.toolNames)
    expect(c2.toolNames).toEqual(c1.toolNames)
    expect(names(c2.agentTools)).toEqual(names(c1.agentTools))
    expect(c2.tools.find((t) => t.name === 'next')!.parameters).toMatchObject(S)
    expect(T.mcp('ctx').connects).toBe(1)
  })
})

// ─────────────────────────── F. root 锁的回归 ───────────────────────────

describe('spawned tools · root-lock regressions', () => {
  it('P2-02-30 LT-06 with the new double: root extras are still rejected; the root request carries no extras', async () => {
    const next = holdTool('next', Promise.resolve())
    const { t } = await scenarioW({ toolHost: scenarioToolHost({ extraTools: [next] }) })
    const session = await t.open()
    const result = await session.submitUser('hi')
    expect(result.error).toMatch(/extra tools/)
    await expect(session.createAgent()).rejects.toMatchObject({ code: 'extra_tools' })
    await expect(session.createAgent({ extraTools: [next] })).rejects.toBeInstanceOf(
      AgentCreationError
    )
    await expect(session.createAgent({ extraTools: [next] })).rejects.toMatchObject({
      code: 'extra_tools'
    })
    expect('extraTools' in t.toolHost.resolveCalls[0]!).toBe(false)
    expect(t.kit.callCount).toBe(0)
  })

  it(
    'P2-02-31 a root rebuild never carries extras',
    async () => {
      const first = await scenarioW()
      const session = await first.t.open()
      await session.createAgent()
      const lock = session.lock!
      const t2 = await first.t.restart({
        toolHost: scenarioToolHost({ extraTools: [nextOf()] })
      })
      await t2.open()
      expect(t2.toolHost.rebuildCalls).toEqual([lock])
      expect(t2.toolHost.rebuildContexts).toEqual([{ sessionId: 's1' }])
      expect('extraTools' in t2.toolHost.rebuildContexts[0]!).toBe(false)
      expect(extensionTools(t2, 'shuvix.agent.1')).toEqual([
        'agent',
        'skill',
        'mcp__ctx__resolve',
        'mcp__ctx__docs'
      ])
      expect(t2.toolHost.mcp('ctx').connects).toBe(0)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-02-32 a spawned-kind lock in SessionStateDoc is malformed at reopen (PIN-08)',
    async () => {
      const first = await scenarioW()
      const session = await first.t.open()
      await session.harness.commit(async (tx) => {
        const state = await tx.doc(SessionStateDoc)
        state.lock = lockRecordJson(lockW({ kind: 'spawned' }))
      }, BG)
      const t2 = await first.t.restart()
      const reopened = await t2.open()
      expect(reopened.lock).toBeUndefined()
      expect(await storedLock(reopened)).toBeUndefined()
      expect(t2.warnings.some((warning) => warning.includes('malformed'))).toBe(true)
      expect(t2.mirror).toEqual([['s1', false]])
      expect(t2.toolHost.rebuildCalls).toEqual([])
    },
    RESTART_TIMEOUT
  )
})

// ─────────────────────────── G. 测试替身 ───────────────────────────

describe('spawned tools · the test double', () => {
  it('P2-02-34 spawned resolve: request extras first, then the host extras (same objects); lazy MCP; the sandbox pin; the hooks apply', async () => {
    const x = holdTool('extra', Promise.resolve())
    const n1 = nextOf()
    const { T } = makeT({ extraTools: [x] })
    const resolved = await resolveSpawned(T, { extraTools: [n1] })
    expect(resolved.extraTools).toHaveLength(2)
    expect(resolved.extraTools![0]).toBe(n1)
    expect(resolved.extraTools![1]).toBe(x)
    expect(T.mcp('ctx').connects).toBe(1)
    expect(resolved.sandboxed).toBe(T.sandbox)

    const transformed = makeT().T
    transformed.transformResolved = (r) => ({ ...r, sandboxed: !r.sandboxed })
    expect((await resolveSpawned(transformed)).sandboxed).toBe(!transformed.sandbox)

    const blocked = makeT().T
    blocked.beforeResolve = (s) => aborted(s)
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(
      blocked.resolveAgentTools(spawnReq(), { signal: controller.signal })
    ).rejects.toThrow('stop')
    expect(blocked.mcp('ctx').connects).toBe(0)
  })
})
