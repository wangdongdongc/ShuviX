/**
 * 身份缓存（P2-01）：`DurableSession.agentIdentity(对话)` —— 同步、按调用认人。
 *
 *  - 派生 agent 的对话按它 `AgentStateDoc` 里的记录（提交发布同步喂养；打开时扫描每个任务拥有的
 *    对话，PIN-03）；记录写坏了也绝不认成根（PIN-04）。
 *  - 其余对话（锁所在的、fork、旁支、任务拥有但没有记录的、不认识的 id）都认成根，根的身份随锁现取
 *    （PIN-05：销毁 / 重建之后立刻是新的；派生条目跨销毁保留）。
 *  - 句柄已关 → undefined（PIN-10）。
 */
import { ROOT_CONVERSATION_ID, type ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../agentRecord'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { writeSpawnedAgentRecord } from '../agentRecord'
import { answer, callTool, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { scenarioW, wKit } from './support/scenario'
import {
  hookRec,
  identityProbe,
  liveTasks,
  rec,
  seedAgent,
  startRun,
  TEST_SPAWN_EXTENSION,
  TestAnchor
} from './support/spawn'
import { allEntries } from './support/transcript'
import { withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000

function expectRoot(identity: AgentIdentity | undefined, profileName: string, model: string): void {
  expect(identity).toMatchObject({ profileName, kind: 'root' })
  expect(identity).not.toHaveProperty('callerId')
  expect(identity!.getModelConfig!()).toEqual({ provider: 'faux', model, capabilities: {} })
}

function expectSpawned(
  identity: AgentIdentity | undefined,
  expected: { profileName: string; callerId: string; model: string }
): void {
  expect(identity).toMatchObject({
    profileName: expected.profileName,
    kind: 'spawned',
    callerId: expected.callerId
  })
  expect(identity!.getModelConfig!()).toEqual({
    provider: 'faux',
    model: expected.model,
    capabilities: {}
  })
}

/** 一个任务拥有、但没有派生记录的对话（锚 + 对话，一个提交） */
async function plainTaskOwned(session: DurableSession): Promise<ConversationId> {
  return session.harness.commit(async (tx) => {
    const anchor = await tx.createTask(TestAnchor, null, {
      ownership: { kind: 'conversation' },
      conversationId: ROOT_CONVERSATION_ID,
      background: true
    })
    return (await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } })).id
  }, BG)
}

/** 根上一轮问答之后，在用户条目处 fork 一个旁支（ownerless） */
async function forkRoot(
  session: DurableSession,
  kitQueue: (text: string) => void
): Promise<ConversationId> {
  kitQueue('a1')
  expect(await session.submitUser('u1')).toEqual({})
  const root = (await session.harness.conversation(ROOT_CONVERSATION_ID, BG))!
  const user = (await allEntries(root)).find((entry) => entry.kind === 'pi.user')!
  return (await root.fork(user.id, { ownership: { kind: 'ownerless' } }, BG)).id
}

describe('agent identity · root and fallback', () => {
  it('P2-01-17 the root identity follows the lock live (unlocked, created, destroyed, recreated)', async () => {
    const { t, config } = await scenarioW()
    const session = await t.open()
    expect(session.agentIdentity(ROOT_CONVERSATION_ID)).toBeUndefined()
    await session.createAgent()
    expectRoot(session.agentIdentity(ROOT_CONVERSATION_ID), 'work', 'faux-1')
    await session.destroyAgent()
    expect(session.agentIdentity(ROOT_CONVERSATION_ID)).toBeUndefined()
    config.model = { provider: 'faux', modelId: 'faux-2' }
    await session.createAgent()
    expectRoot(session.agentIdentity(ROOT_CONVERSATION_ID), 'work', 'faux-2')
  })

  it('P2-01-18 non-spawned conversations get the root identity: a side conversation, a fork, a plain task-owned one, an unknown id', async () => {
    const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    await session.createAgent()
    const root = session.agentIdentity(ROOT_CONVERSATION_ID)
    expectRoot(root, 'work', 'faux-1')
    const side = await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    const fork = await forkRoot(session, (text) => t.kit.queue(answer(text)))
    const owned = await plainTaskOwned(session)
    for (const conversationId of [side.id, fork, owned, 999]) {
      expect(session.agentIdentity(conversationId)).toEqual(root)
    }
  })
})

describe('agent identity · spawned', () => {
  it('P2-01-19 a seeded record is visible synchronously after its commit; the root identity is unchanged', async () => {
    const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    await session.createAgent()
    const seeded = await seedAgent(session)
    expectSpawned(session.agentIdentity(seeded.conversationId), {
      profileName: 'explore',
      callerId: 'sub-a1',
      model: 'faux-2'
    })
    expectRoot(session.agentIdentity(ROOT_CONVERSATION_ID), 'work', 'faux-1')
  })

  it('P2-01-20 a hook agent is a spawned identity too', async () => {
    const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    const seeded = await seedAgent(session, { record: hookRec() })
    expectSpawned(session.agentIdentity(seeded.conversationId), {
      profileName: 'titler',
      callerId: 'sub-h1',
      model: 'faux-2'
    })
  })

  it('P2-01-21 synchronous and per call: a tool sees the root identity in the root run and the spawned one in the child run', async () => {
    const seen: unknown[] = []
    const holder: { session?: DurableSession } = {}
    const t = await makeHost({
      makeKit: wKit,
      tools: [identityProbe(() => holder.session!, seen)],
      extensions: [TEST_SPAWN_EXTENSION]
    })
    const session = await t.open()
    holder.session = session
    await primeRoot(session)
    t.kit.queue(callTool('probe', {}, 'root-call'), answer('root done'))
    expect(await session.submitUser('go')).toEqual({})
    const seeded = await seedAgent(session)
    t.kit.queue(callTool('probe', {}, 'child-call'), answer('child done'))
    const run = await startRun(session, seeded.conversationId, 'child go')
    expect((await withTimeout(run.wait(BG), 5000, 'child run')).status).toBe('done')

    expect(seen).toHaveLength(2)
    for (const value of seen) {
      expect(typeof (value as { then?: unknown } | undefined)?.then).not.toBe('function')
    }
    expectRoot(seen[0] as AgentIdentity, 'test', 'faux-1')
    expectSpawned(seen[1] as AgentIdentity, {
      profileName: 'explore',
      callerId: 'sub-a1',
      model: 'faux-2'
    })
  })

  it(
    'P2-01-22 init scan: a live child is a spawned identity right after open, and nothing resumed',
    async () => {
      const first = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION] })
      const session = await first.open()
      await primeRoot(session)
      const seeded = await seedAgent(session)
      const stall = stalled()
      first.kit.queue(stall.step)
      await startRun(session, seeded.conversationId, 'CHILD-Q')
      await stall.reached
      const t = await first.restart()
      const reopened = await t.open()
      expect((await liveTasks(reopened, seeded.conversationId)).length).toBeGreaterThan(0)
      expectSpawned(reopened.agentIdentity(seeded.conversationId), {
        profileName: 'explore',
        callerId: 'sub-a1',
        model: 'faux-2'
      })
      expect((await reopened.harness.inspect(BG)).scheduling).toBe('paused')
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-01-23 init scan: an idle child (no live tasks) is a spawned identity too (PIN-03)',
    async () => {
      const first = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION] })
      const session = await first.open()
      await primeRoot(session)
      const seeded = await seedAgent(session)
      const t = await first.restart()
      const reopened = await t.open()
      expect(await liveTasks(reopened, seeded.conversationId)).toEqual([])
      expectSpawned(reopened.agentIdentity(seeded.conversationId), {
        profileName: 'explore',
        callerId: 'sub-a1',
        model: 'faux-2'
      })
    },
    RESTART_TIMEOUT
  )

  it('P2-01-24 unrelated writes (date, persona, a root agent-state write) leave the child identity unchanged', async () => {
    const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    await session.createAgent()
    const seeded = await seedAgent(session)
    const child = seeded.conversationId
    const before = session.agentIdentity(child)
    await session.harness.commit(async (tx) => {
      const state = await tx.doc(AgentStateDoc, child)
      state.lastAnnouncedDate = '2026-10-04'
      state.persona = 'You are edited'
    }, BG)
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(AgentStateDoc, ROOT_CONVERSATION_ID)).lastAnnouncedDate = '2026-10-04'
    }, BG)
    const after = session.agentIdentity(child)
    expect(after).toEqual(before)
    expect(after!.getModelConfig!()).toEqual(before!.getModelConfig!())
  })

  it('P2-01-25 record changes follow storage: a rewrite updates at once; removing or retiring the record falls back to the root', async () => {
    const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    await session.createAgent()
    const root = session.agentIdentity(ROOT_CONVERSATION_ID)
    const seeded = await seedAgent(session)
    const child = seeded.conversationId

    await session.harness.commit(
      (tx) =>
        writeSpawnedAgentRecord(tx, child, {
          ...seeded.record,
          profileName: 'explore2',
          model: { provider: 'faux', modelId: 'faux-1' }
        }),
      BG
    )
    expectSpawned(session.agentIdentity(child), {
      profileName: 'explore2',
      callerId: 'sub-a1',
      model: 'faux-1'
    })

    await session.harness.commit(async (tx) => {
      const state = await tx.doc(AgentStateDoc, child)
      delete state.kind
      delete state.agentId
    }, BG)
    expect(session.agentIdentity(child)).toEqual(root)

    const other = await seedAgent(session, { record: rec({ agentId: 'sub-a2' }) })
    expect(session.agentIdentity(other.conversationId)?.callerId).toBe('sub-a2')
    await session.harness.commit((tx) => tx.retireDoc(AgentStateDoc, other.conversationId), BG)
    expect(session.agentIdentity(other.conversationId)).toEqual(root)
  })

  it('P2-01-26 a malformed spawned record is a minimal spawned identity, never the root; one warning (PIN-04)', async () => {
    const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    await session.createAgent()
    const child = await plainTaskOwned(session)
    await session.harness.commit(async (tx) => {
      const state = await tx.doc(AgentStateDoc, child)
      state.kind = 'spawned'
      state.profileName = 'explore'
      state.dispatch = 'tool'
      state.agentId = 'sub-x'
    }, BG)
    const identity = session.agentIdentity(child)
    expect(identity).toEqual({ kind: 'spawned', profileName: 'explore', callerId: 'sub-x' })
    expect(identity).not.toHaveProperty('getModelConfig')
    expect(identity).not.toEqual(session.agentIdentity(ROOT_CONVERSATION_ID))
    const malformed = t.warnings.filter((warning) => warning.includes('malformed'))
    expect(malformed).toHaveLength(1)
    expect(malformed[0]).toContain('s1')
    expect(malformed[0]).toContain(`conversation ${child}`)
  })
})

describe('agent identity · lifecycle', () => {
  it('P2-01-27 destroyAgent clears only the root identity; spawned entries survive destroy and recreate (PIN-05)', async () => {
    const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    await session.createAgent()
    const tool = await seedAgent(session)
    const hook = await seedAgent(session, { record: hookRec() })
    await session.destroyAgent()
    expect(session.agentIdentity(ROOT_CONVERSATION_ID)).toBeUndefined()
    expect(session.agentIdentity(tool.conversationId)?.callerId).toBe('sub-a1')
    expect(session.agentIdentity(hook.conversationId)?.callerId).toBe('sub-h1')
    await session.createAgent()
    expectRoot(session.agentIdentity(ROOT_CONVERSATION_ID), 'work', 'faux-1')
    expect(session.agentIdentity(tool.conversationId)?.kind).toBe('spawned')
    expect(session.agentIdentity(hook.conversationId)?.kind).toBe('spawned')
  })

  it('P2-01-28 after the pointer moves to a fork and the agent is recreated there, the fork and the root share the new root identity', async () => {
    const { t, config } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
    const session = await t.open()
    await session.createAgent()
    const seeded = await seedAgent(session)
    const fork = await forkRoot(session, (text) => t.kit.queue(answer(text)))
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).currentConversation = fork
    }, BG)
    await session.destroyAgent()
    config.model = { provider: 'faux', modelId: 'faux-2' }
    const lock = await session.createAgent()
    expect(lock.conversationId).toBe(fork)
    expectRoot(session.agentIdentity(fork), 'work', 'faux-2')
    expect(session.agentIdentity(ROOT_CONVERSATION_ID)).toEqual(session.agentIdentity(fork))
    expect(session.agentIdentity(seeded.conversationId)?.kind).toBe('spawned')
  })

  it('P2-01-29 identities are per session: the same conversation id is spawned in s1 and plain in s2', async () => {
    const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
    const s1 = await t.open('s1')
    const s2 = await t.open('s2')
    await s1.createAgent()
    await s2.createAgent()
    const seeded = await seedAgent(s1)
    // 同一串取号（锚任务、对话）：两个存储里的对话 id 相同
    const plain = await s2.harness.commit(async (tx) => {
      await tx.createTask(TestAnchor, null, {
        ownership: { kind: 'conversation' },
        conversationId: ROOT_CONVERSATION_ID,
        background: true
      })
      return (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id
    }, BG)
    expect(plain).toBe(seeded.conversationId)
    expect(s1.agentIdentity(plain)?.kind).toBe('spawned')
    expect(s2.agentIdentity(plain)).toEqual(s2.agentIdentity(ROOT_CONVERSATION_ID))
    expectRoot(s2.agentIdentity(plain), 'work', 'faux-1')
  })

  it(
    'P2-01-30 a closed handle answers undefined without throwing; the reopened instance answers spawned (PIN-10)',
    async () => {
      const { t } = await scenarioW({ extensions: [TEST_SPAWN_EXTENSION] })
      const session = await t.open()
      await session.createAgent()
      const seeded = await seedAgent(session)
      await t.host.close('s1')
      expect(session.agentIdentity(seeded.conversationId)).toBeUndefined()
      expect(session.agentIdentity(ROOT_CONVERSATION_ID)).toBeUndefined()
      const reopened = await t.open()
      expect(reopened).not.toBe(session)
      expect(reopened.agentIdentity(seeded.conversationId)?.callerId).toBe('sub-a1')
    },
    RESTART_TIMEOUT
  )
})
