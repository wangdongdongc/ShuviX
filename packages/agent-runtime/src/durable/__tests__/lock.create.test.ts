/**
 * 锁 · 创建（P1-09；裁决 K2–K6、K9、K11、K13、K15–K21）：第一次发送创建 agent、一个提交写全、
 * 并发合流、拒绝与失败什么都不写、各个自动创建入口、fork 上上锁、会话之间互不相干。
 *
 * 镜像（onLockChange）：K11 让每次打开都先对一次账（新会话 = `['s1', false]`），所以「创建之后的镜像」
 * 一律数打开之后的那几次调用。
 */
import { AgentDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, SessionStateDoc } from '../docs'
import { AgentCreationError, lockRecordJson, parseLockRecord } from '../lock'
import { E_W, scenarioConfig, scenarioToolHost, testProfile, W_CWD } from './support/agentConfig'
import { recordPublications } from './support/commits'
import { fauxProvider } from '@earendil-works/pi-ai'
import { createModelRegistry } from '../../models/modelRegistry'
import { customRow, fakePort, modelRow } from '../../models/__tests__/fakePort'
import { answer, modelError, requestTools } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  agentState,
  extensionTools,
  lockW,
  piAgent,
  scenarioW,
  storedLock,
  W_NOW,
  wExtensions
} from './support/scenario'
import { holdTool } from './support/tools'
import { allEntries, transcript } from './support/transcript'
import { sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const names = (tools: readonly { name: string }[]): string[] => tools.map((tool) => tool.name)

describe('lock · create', () => {
  it('LC-01 the first send creates the agent once: one config read, one tool resolution, the lock, the mirror, agent_created, and request 0 on faux-1 with E_W', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const mirrorAtOpen = t.mirror.length
    t.kit.queue(answer('hello'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(t.configCalls).toEqual(['s1'])
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    expect(session.lock).toEqual(lockW())
    expect(t.mirror.slice(0, mirrorAtOpen)).toEqual([['s1', false]])
    expect(t.mirror.slice(mirrorAtOpen)).toEqual([['s1', true]])
    expect(t.broadcastsOf('agent_created')).toEqual([{ type: 'agent_created', sessionId: 's1' }])
    expect(t.kit.requests[0]!.modelId).toBe('faux-1')
    expect(names(requestTools(t.kit, 0))).toEqual(E_W)
  })

  it('LC-02 createAgent() alone commits the lock without starting the scheduler; a second call returns the same record and touches nothing', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const first = await session.createAgent()
    expect(first).toEqual(lockW())
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    await sleep(30)
    expect(t.kit.callCount).toBe(0)

    const recorder = recordPublications(session.harness)
    const second = await session.createAgent()
    recorder.stop()
    expect(second).toEqual(first)
    expect(t.configCalls).toHaveLength(1)
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    expect(recorder.publications).toEqual([])
    expect(t.broadcastsOf('agent_created')).toHaveLength(1)
  })

  it('LC-03 concurrent first sends (B queues as a follow-up) share one creation and both run', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    t.kit.queue(answer('a'), answer('b'))
    const [a, b] = await Promise.all([
      session.submitUser('a'),
      session.submitUser('b', { whenBusy: 'followUp' })
    ])
    expect(a).toEqual({})
    expect(b).toEqual({})
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    expect(t.configCalls).toHaveLength(1)
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:a',
      'pi.assistant:a',
      'pi.user:b',
      'pi.assistant:b'
    ])
  })

  it('LC-04 three concurrent createAgent() calls: one creation, three equal records, one lock publication', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const recorder = recordPublications(session.harness)
    const records = await Promise.all([
      session.createAgent(),
      session.createAgent(),
      session.createAgent()
    ])
    recorder.stop()
    expect(records[1]).toEqual(records[0])
    expect(records[2]).toEqual(records[0])
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    expect(recorder.touching('shuvix.session-state')).toHaveLength(1)
    expect(t.broadcastsOf('agent_created')).toHaveLength(1)
  })

  it('LC-05 later turns on a locked session never touch the seams, the mirror or agent_created again', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    t.kit.queue(answer('1'), answer('2'), answer('3'))
    for (const text of ['u1', 'u2', 'u3']) expect(await session.submitUser(text)).toEqual({})
    expect(t.configCalls).toHaveLength(1)
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    // 打开一条空闲会话什么都不建（option A：内置工具是惰性的），创建时建一次
    expect(t.toolHost.builtinCalls).toHaveLength(1)
    expect(t.mirror).toEqual([
      ['s1', false],
      ['s1', true]
    ])
    expect(t.broadcastsOf('agent_created')).toHaveLength(1)
  })

  it('LC-06 atomicity: exactly one publication writes pi.agent#1, the agent state and the lock — and it precedes the user entry', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const recorder = recordPublications(session.harness)
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    recorder.stop()
    const lockCommits = recorder.touching('pi.agent#1')
    expect(lockCommits).toHaveLength(1)
    expect(lockCommits[0]!.docs).toEqual(
      expect.arrayContaining(['pi.agent#1', 'shuvix.agent-state#1', 'shuvix.session-state'])
    )
    expect(recorder.touching('shuvix.agent-state#1')).toEqual(lockCommits)
    const lockIndex = recorder.publications.indexOf(lockCommits[0]!)
    const userIndex = recorder.publications.findIndex((p) => p.entries.includes('pi.user'))
    expect(userIndex).toBeGreaterThan(lockIndex)
  })

  it('LC-07 pi.agent holds exactly the model, the live thinking level, the explicit extension list, the explicit tool list and the cwd (K6/K17)', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    expect(await piAgent(session)).toEqual({
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low',
      extensions: wExtensions(),
      tools: E_W,
      cwd: W_CWD
    })

    // 配置没给工作目录：不写 cwd
    const config = { ...scenarioConfig(), cwd: '' }
    const other = await scenarioW({ config })
    const bare = await other.t.open()
    await bare.createAgent()
    expect(await piAgent(bare)).not.toHaveProperty('cwd')
    expect(await piAgent(bare)).not.toHaveProperty('instructions')
  })

  it('LC-08 the agent state carries the frozen persona and the identity (K16/K21)', async () => {
    const { t, vars } = await scenarioW()
    vars.state.marker = 'Aria'
    const session = await t.open()
    await session.createAgent()
    expect(await agentState(session)).toEqual({
      kind: 'root',
      profileName: 'work',
      rootSessionId: 's1',
      persona: 'You are Aria',
      instructionFiles: ['AGENTS.md']
    })
    expect(vars.state.calls).toBe(1)
  })

  it('LC-09 the lock is plain JSON that round-trips; createdAt is the clock; the getter equals the document right after createAgent', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const record = await session.createAgent()
    const stored = await storedLock(session)
    expect(session.lock).toEqual(stored)
    expect(record.createdAt).toBe(W_NOW)
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored)
    expect(parseLockRecord(lockRecordJson(record))).toEqual(record)
  })

  it.each([
    ['a disabled provider', 'disabled' as const],
    ['an unknown model', 'unknown-model' as const]
  ])(
    'LC-10 refusal on %s: no_model naming the provider and the model, nothing written, nothing installed (K4)',
    async (_name, kind) => {
      const config = scenarioConfig()
      const { t } = await scenarioW({ config })
      if (kind === 'disabled') t.port.rows[0]!.isEnabled = false
      else config.model = { provider: 'faux', modelId: 'nope' }
      const session = await t.open()
      const mirrorAtOpen = t.mirror.length
      const result = await session.submitUser('hi')
      expect(result.code).toBe('no_model')
      expect(result.error).toContain('faux')
      expect(result.error).toContain(kind === 'disabled' ? 'faux-1' : 'nope')
      expect(await storedLock(session)).toBeUndefined()
      expect(session.lock).toBeUndefined()
      expect(await piAgent(session)).toEqual({})
      expect(await agentState(session)).toEqual({})
      expect(await transcript(await session.currentConversation())).toEqual([])
      expect(extensionTools(t, 'shuvix.agent.1')).toBeUndefined()
      expect(t.mirror.slice(mirrorAtOpen)).toEqual([])
      expect(t.broadcastsOf('agent_created')).toEqual([])
      expect(t.toolHost.resolveCalls).toEqual([])
      expect(t.kit.callCount).toBe(0)
      await expect(session.createAgent()).rejects.toMatchObject({ code: 'no_model' })

      // 改好配置：下一次发送照常创建
      t.port.rows[0]!.isEnabled = true
      config.model = { provider: 'faux', modelId: 'faux-1' }
      t.kit.queue(answer('ok'))
      expect(await session.submitUser('again')).toEqual({})
      expect(session.lock).toEqual(lockW())
    }
  )

  it('LC-11 a failure before the commit (tool resolution or promptVars throws) writes nothing; the next send retries the creation', async () => {
    const { t, vars } = await scenarioW()
    const session = await t.open()
    t.toolHost.failResolve = new Error('tools exploded')
    expect(await session.submitUser('one')).toEqual({ error: 'tools exploded' })
    expect(await storedLock(session)).toBeUndefined()
    expect(await piAgent(session)).toEqual({})
    expect(extensionTools(t, 'shuvix.agent.1')).toBeUndefined()

    t.toolHost.failResolve = undefined
    vars.state.fail = 'vars exploded'
    expect(await session.submitUser('two')).toEqual({ error: 'vars exploded' })
    expect(await storedLock(session)).toBeUndefined()
    expect(await agentState(session)).toEqual({})
    expect(t.broadcastsOf('agent_created')).toEqual([])

    vars.state.fail = undefined
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('three')).toEqual({})
    expect(t.toolHost.resolveCalls).toHaveLength(3)
    expect(session.lock).toBeDefined()
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:three',
      'pi.assistant:ok'
    ])
  })

  it('LC-12 a failure inside the commit (a non-JSON MCP declaration) leaves no partial state and uninstalls the agent extension again', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    t.toolHost.transformResolved = (resolved) => ({
      ...resolved,
      mcp: (resolved.mcp ?? []).map((entry) => ({
        ...entry,
        declarations: entry.declarations.map((decl) => ({
          ...decl,
          inputSchema: { ...decl.inputSchema, size: BigInt(1) as unknown as object }
        }))
      }))
    })
    const recorder = recordPublications(session.harness)
    const result = await session.submitUser('hi')
    recorder.stop()
    expect(result.error).toMatch(/bigint/i)
    expect(recorder.touching('shuvix.session-state')).toEqual([])
    expect(recorder.touching('pi.agent#1')).toEqual([])
    expect(await storedLock(session)).toBeUndefined()
    expect(extensionTools(t, 'shuvix.agent.1')).toBeUndefined()
    // shuvix.builtin 回到打开时的样子：没装（option A：空闲会话打开时不建内置工具）
    expect(t.registryOf('s1')!.snapshot().extension('shuvix.builtin')).toBeUndefined()
    expect(t.kit.callCount).toBe(0)
  })

  it('LC-13 a model error on the first request keeps the lock; the next send reuses it and succeeds', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    t.kit.queue(modelError('boom'))
    expect(await session.submitUser('u1')).toEqual({ error: 'boom', code: 'model_error' })
    expect(session.lock).toEqual(lockW())
    t.kit.queue(answer('fine'))
    expect(await session.submitUser('u2')).toEqual({})
    expect(t.toolHost.resolveCalls).toHaveLength(1)
  })

  it('LC-14 an idle steer and an idle followUp each create the agent first (K3)', async () => {
    const steered = await scenarioW()
    const a = await steered.t.open()
    steered.t.kit.queue(answer('ack'))
    expect((await a.steer('x')).submissionId).toBeDefined()
    expect(a.lock).toBeDefined()
    await withTimeout(a.harness.waitForIdle(BG), 5000, 'steer run')
    expect(await transcript(await a.currentConversation())).toEqual([
      'pi.user:x',
      'pi.assistant:ack'
    ])

    const followed = await scenarioW()
    const b = await followed.t.open()
    followed.t.kit.queue(answer('ack'))
    expect((await b.followUp('y')).submissionId).toBeDefined()
    expect(b.lock).toBeDefined()
    await withTimeout(b.harness.waitForIdle(BG), 5000, 'followUp run')
    expect(await transcript(await b.currentConversation())).toEqual([
      'pi.user:y',
      'pi.assistant:ack'
    ])
    expect(followed.t.toolHost.resolveCalls).toHaveLength(1)
  })

  it('LC-15 decision table, root row: the profile model and thinking level never apply — the session config does (K9)', async () => {
    const config = scenarioConfig()
    config.profile = { ...config.profile, model: 'other/x', thinkingLevel: 'high' }
    const { t } = await scenarioW({ config })
    const session = await t.open()
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(session.lock).toMatchObject({
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low'
    })
    expect(await piAgent(session)).toMatchObject({
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'low'
    })
    expect(t.kit.requests[0]!.options?.reasoning).toBe('low')

    // 配置不给思考档位：锁里不记，pi.agent 里没有（durable 缺省 off），请求不带 reasoning
    const plain = scenarioConfig()
    delete plain.thinkingLevel
    const other = await scenarioW({ config: plain })
    const bare = await other.t.open()
    await bare.harness.commit(async (tx) => {
      ;(await tx.doc(AgentDoc, ROOT_CONVERSATION_ID)).thinkingLevel = 'high'
    }, BG)
    other.t.kit.queue(answer('ok'))
    expect(await bare.submitUser('hi')).toEqual({})
    expect(bare.lock).not.toHaveProperty('thinkingLevel')
    expect(await piAgent(bare)).not.toHaveProperty('thinkingLevel')
    expect(other.t.kit.requests[0]!.options?.reasoning).toBeUndefined()
  })

  it('LC-16 a narrow (bot-like) profile: the overlay adds only mcp:/skill:, never builtins', async () => {
    const config = scenarioConfig()
    config.profile = {
      ...config.profile,
      name: 'bot',
      tools: ['read', 'ls', 'ask', 'edit', 'skill:builtin:drawing']
    }
    config.toolOverlay = ['mcp:ctx', 'bash', 'write', 'skill:pdf']
    const { t } = await scenarioW({ config })
    const session = await t.open()
    await session.createAgent()
    expect(t.toolHost.resolveCalls[0]!.names).toEqual([
      'read',
      'ls',
      'ask',
      'edit',
      'skill:builtin:drawing',
      'mcp:ctx',
      'skill:pdf'
    ])
    expect(session.lock!.toolNames).toEqual([
      'read',
      'ls',
      'ask',
      'edit',
      'skill',
      'mcp__ctx__resolve',
      'mcp__ctx__docs'
    ])
  })

  it('LC-17 an ephemeral (memory) session locks exactly like a persisted one (K19)', async () => {
    const { t } = await scenarioW({ ephemeral: ['s1'] })
    const session = await t.open()
    t.kit.queue(answer('hello'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(session.lock).toEqual(lockW())
    expect(names(requestTools(t.kit, 0))).toEqual(E_W)
    expect(t.broadcastsOf('agent_created')).toHaveLength(1)
  })

  it('LC-18 locking on a fork: pi.agent of the fork is configured, the extension is named after it, the root is untouched (K20)', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    expect((await session.writeNotice({ text: 'seed', kind: 'background' })).status).toBe(
      'submitted'
    )
    const root = await session.currentConversation()
    const seed = (await allEntries(root))[0]!
    const fork = await root.fork(seed.id, { ownership: { kind: 'ownerless' } }, BG)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
    }, BG)
    const record = await session.createAgent()
    expect(record.conversationId).toBe(fork.id)
    expect(record.extensions.at(-1)).toBe(`shuvix.agent.${fork.id}`)
    expect(await piAgent(session, fork.id)).toMatchObject({
      extensions: wExtensions(fork.id),
      tools: E_W
    })
    expect(extensionTools(t, `shuvix.agent.${fork.id}`)).toEqual([
      'agent',
      'skill',
      'mcp__ctx__resolve',
      'mcp__ctx__docs'
    ])
    expect(extensionTools(t, 'shuvix.agent.1')).toBeUndefined()
    expect(await piAgent(session, ROOT_CONVERSATION_ID)).toEqual({})
    expect(await session.harness.snapshot(AgentStateDoc, fork.id, BG)).toMatchObject({
      persona: 'You are M1'
    })
  })

  it('LC-19 sessions are isolated: both lock conversation 1, each offers its own tools, destroying one leaves the other alone (K1)', async () => {
    const probeA = holdTool('probeA', Promise.resolve())
    const probeB = holdTool('probeB', Promise.resolve())
    const { t } = await scenarioW({
      toolHost: scenarioToolHost({
        agentTools: (sessionId) => (sessionId === 's1' ? [probeA] : [probeB])
      })
    })
    const s1 = await t.open('s1')
    const s2 = await t.open('s2')
    t.kit.queue(answer('one'), answer('two'))
    expect(await s1.submitUser('hi')).toEqual({})
    expect(await s2.submitUser('hi')).toEqual({})
    expect(s1.lock!.conversationId).toBe(s2.lock!.conversationId)
    expect(names(requestTools(t.kit, 0))).toContain('probeA')
    expect(names(requestTools(t.kit, 0))).not.toContain('probeB')
    expect(names(requestTools(t.kit, 1))).toContain('probeB')
    expect(names(requestTools(t.kit, 1))).not.toContain('probeA')

    await s1.destroyAgent()
    expect(extensionTools(t, 'shuvix.agent.1', 's1')).toBeUndefined()
    expect(extensionTools(t, 'shuvix.agent.1', 's2')).toContain('probeB')
    expect(s2.lock).toBeDefined()
    t.kit.queue(answer('three'))
    expect(await s2.submitUser('again')).toEqual({})
    expect(names(requestTools(t.kit, 2))).toContain('probeB')
  })

  it('LC-20 a notice on an idle unlocked session with auto-resume on creates the agent, then runs (K3)', async () => {
    const { t } = await scenarioW({ noticeCoalesceMs: 10 })
    const session = await t.open()
    t.kit.queue(answer('noted'))
    await session.notify('bg done')
    await waitFor(
      async () => {
        const lines = await transcript(await session.currentConversation())
        return lines.includes('pi.assistant:noted')
      },
      5000,
      'auto-resume run'
    )
    expect(session.lock).toEqual(lockW())
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    expect(t.broadcastsOf('agent_created')).toHaveLength(1)
  })

  it('LC-21 abort() during a creation stuck on a slow MCP connect cancels it: nothing written, the send resolves {} (K13)', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const hold = t.toolHost.mcp('ctx').holdConnect()
    const sending = session.submitUser('hi')
    await hold.reached
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await withTimeout(sending, 5000, 'send')).toEqual({})
    expect(await storedLock(session)).toBeUndefined()
    expect(session.lock).toBeUndefined()
    expect(await piAgent(session)).toEqual({})
    expect(extensionTools(t, 'shuvix.agent.1')).toBeUndefined()
    expect(t.broadcastsOf('agent_created')).toEqual([])
    expect(await transcript(await session.currentConversation())).toEqual([])
    expect(t.kit.callCount).toBe(0)
    hold.release()

    // 之后照常能创建
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('again')).toEqual({})
    expect(session.lock).toBeDefined()
  })

  it('LC-22 createAgent() with extra tools is rejected for a root lock (K6)', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const extra = holdTool('next', Promise.resolve())
    await expect(session.createAgent({ extraTools: [extra] })).rejects.toBeInstanceOf(
      AgentCreationError
    )
    expect(t.toolHost.resolveCalls).toEqual([])
    expect(session.lock).toBeUndefined()
  })

  it('LC-24 the model catalog takes a real model registry (PIN-3): a provider registered under a custom row id', async () => {
    const rowId = '0193a7c2-0000-7000-8000-00000000c001'
    const port = fakePort([customRow(rowId)], [modelRow(rowId, 'alpha')])
    const registry = createModelRegistry({ port })
    const faux = fauxProvider({ provider: rowId, models: [{ id: 'alpha', contextWindow: 64000 }] })
    registry.mutable.setProvider(faux.provider)
    faux.appendResponses([answer('from the custom row')])
    const config = scenarioConfig()
    config.model = { provider: rowId, modelId: 'alpha' }
    const { t } = await scenarioW({
      config,
      port,
      models: registry.models,
      modelCatalog: { registry, port }
    })
    const session = await t.open()
    expect(await session.submitUser('hi')).toEqual({})
    expect(session.lock!.model).toEqual({ provider: rowId, modelId: 'alpha' })
    expect(await transcript(await session.currentConversation())).toEqual([
      'pi.user:hi',
      'pi.assistant:from the custom row'
    ])
    expect(session.effectiveSettings.compaction?.reserveTokens).toBe(16000)
    port.rows[0]!.isEnabled = false
    await session.destroyAgent()
    const refused = await session.submitUser('again')
    expect(refused.code).toBe('no_model')
    expect(refused.error).toContain('My Proxy')
    expect(refused.error).not.toContain(rowId)
  })

  it('LC-23 the test profile helpers: the default config (K15) locks the empty test profile with no system prompt', async () => {
    const { t } = await scenarioW({
      config: { profile: testProfile(), model: { provider: 'faux', modelId: 'faux-1' } }
    })
    const session = await t.open()
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(session.lock).toMatchObject({ profileName: 'test', toolNames: [] })
    expect(t.kit.requests[0]!.systemPrompt).toBe('')
    expect(session.lock!.mcp).toEqual({})
  })
})
