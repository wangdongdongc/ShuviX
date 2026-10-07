/**
 * DurableSession · monitorSnapshot（P3-13 runtime：01–12，外加 17 的运行时那一半）—— 设置页「监视器 →
 * 智能体」每秒轮询的那份快照。
 *
 *  01 没锁也没派生 → [] · 02 根的一行（身份、模型、活的思考档位、工具数、闲着、空队列；模型从注册表里没了
 *  → 窗口 0）· 03 相位与在跑的工具（turn / 工具槽 / 询问 / compaction / 回到 idle；从不 branch_summary）·
 *  04 被中断（PIN-05）· 05 列哪些派生（PIN-02：装着扩展或有活任务，hook 也算；销毁的不列；重开之后闲着的
 *  不列，ensureInstalled 之后回来；崩在半路的子 agent 重开后列为 interrupted）· 06 缓存、上下文、自己的花费 ·
 *  07 重试 / 压缩 / 中止都算花费（Q-P3-08）· 08 会话花费含起标题与审查 · 09 回退 fork 之后 · 10 队列计数 ·
 *  11 只读且廉价（不提交、不挂投影、不调重建 seam、不开启调度器、不改 evictable、不刷新 LRU）· 12 已关的句柄 ·
 *  17 lastActivityAt（PIN-07：在跑 = 此刻；否则最新一条条目的消息时间，没有就是 startedAt）
 *
 * 精确的用量与花费靠 `support/usage.ts` 给 faux 盖章（faux 自己的估算花费恒为 0）。
 */
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import {
  ROOT_CONVERSATION_ID,
  UsageDoc,
  type ConversationId,
  type UsageState
} from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionClosedError, type DurableSession } from '../durableSession'
import type { AgentMonitorRow } from '../monitorSnapshot'
import { recordPublications } from './support/commits'
import { crashWith } from './support/crash'
import { answer, callTool, held, modelError, stalled } from './support/faux'
import { hookRig, promptPayload, queueRoles, roleOf, type Role } from './support/hookRig'
import { makeHost, registerHostCleanup, TEST_SETTINGS_OVERRIDES } from './support/host'
import { threeTurns } from './support/rollback'
import { W_NOW } from './support/scenario'
import { callAgent, firstChild, hostD, PROFILES, probeTool } from './support/spawn'
import { askingTool, holdTool } from './support/tools'
import { allEntries } from './support/transcript'
import { stampUsage } from './support/usage'
import { deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const ROOT = ROOT_CONVERSATION_ID

function rootRow(rows: readonly AgentMonitorRow[]): AgentMonitorRow {
  const row = rows.find((candidate) => candidate.kind === 'root')
  if (row === undefined) throw new Error(`no root row in ${JSON.stringify(rows)}`)
  return row
}

async function rootOf(session: DurableSession): Promise<AgentMonitorRow> {
  return rootRow(await session.monitorSnapshot())
}

/** 一个对话的 `pi.usage` 两种桶的花费合计 */
function costOf(state: Readonly<UsageState> | undefined): number {
  let total = 0
  for (const usage of Object.values(state?.models ?? {})) total += usage.cost.total
  for (const usage of Object.values(state?.tools ?? {})) total += usage.cost.total
  return total
}

/** 全部对话的 id */
async function conversationIds(session: DurableSession): Promise<ConversationId[]> {
  return session.harness.commit(
    async (tx) => (await tx.scanConversations({}, 256)).items.map((record) => record.id),
    BG
  )
}

describe('P3-13 runtime · root row', () => {
  it('P3-13-01 an open session with no lock and no spawn → []', async () => {
    const t = await makeHost()
    const session = await t.open()
    expect(await session.monitorSnapshot()).toEqual([])
    expect(session.lock).toBeUndefined()
    expect(t.configCalls).toEqual([])
  })

  it('P3-13-02 the root row of a locked, idle session; a model gone from the registry reads window 0', async () => {
    const d = await hostD()
    const { session, t } = d
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    await session.setThinkingLevel('high')
    const lock = session.lock!
    const rows = await session.monitorSnapshot()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      kind: 'root',
      agentId: 's1',
      rootSessionId: 's1',
      conversationId: lock.conversationId,
      depth: 0,
      profileName: lock.profileName,
      model: {
        provider: 'faux',
        id: 'faux-1',
        contextWindow: t.kit.models.getModel('faux', 'faux-1')!.contextWindow
      },
      thinkingLevel: 'high',
      toolCount: lock.toolNames.length,
      phase: 'idle',
      startedAt: lock.createdAt
    })
    expect(row.model.contextWindow).toBe(40000)
    expect(lock.thinkingLevel).toBe('low')
    expect(lock.toolNames.length).toBeGreaterThan(0)
    expect(row.queue).toEqual({ steer: 0, followUp: 0 })
    expect(row.parentAgentId).toBeUndefined()
    expect(row.dispatch).toBeUndefined()
    expect(row.activeToolName).toBeUndefined()

    t.kit.models.deleteProvider('faux')
    const gone = await rootOf(session)
    expect(gone.model).toEqual({ provider: 'faux', id: 'faux-1', contextWindow: 0 })
  })

  it('P3-13-03 phase and active tool: held → turn; a running tool → turn + its name; an ask → turn; compaction → compaction; settled → idle; never branch_summary', async () => {
    const ref: { session?: DurableSession } = {}
    const toolGate = deferred()
    const t = await makeHost({
      tools: [holdTool('slow', toolGate.promise), askingTool('askme', () => ref.session!)],
      settingsOverrides: {
        ...TEST_SETTINGS_OVERRIDES,
        compaction: { enabled: false, keepRecentTokens: 200 }
      }
    })
    const session = (ref.session = await t.open())
    await session.createAgent()
    const phases: string[] = []
    const read = async (): Promise<AgentMonitorRow> => {
      const row = await rootOf(session)
      phases.push(row.phase)
      return row
    }

    const gate = held(answer('streamed'))
    t.kit.queue(gate.step)
    const first = session.submitUser('go')
    await gate.reached
    const streaming = await read()
    expect(streaming.phase).toBe('turn')
    expect(streaming.activeToolName).toBeUndefined()
    gate.release()
    expect(await first).toEqual({})
    expect((await read()).phase).toBe('idle')

    t.kit.queue(callTool('slow'), answer('slow done'))
    const second = session.submitUser('run slow')
    await waitFor(async () => (await rootOf(session)).activeToolName === 'slow', 3000, 'slow runs')
    expect(await read()).toMatchObject({ phase: 'turn', activeToolName: 'slow' })
    toolGate.resolve()
    expect(await second).toEqual({})
    const afterTool = await read()
    expect(afterTool.phase).toBe('idle')
    expect(afterTool.activeToolName).toBeUndefined()

    t.kit.queue(callTool('askme'), answer('asked'))
    const third = session.submitUser('ask')
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    expect((await read()).phase).toBe('turn')
    expect(session.respondToInput('call-askme', { kind: 'ask', allowed: true })).toBe(true)
    expect(await third).toEqual({})

    t.kit.queue(answer(`a4 ${'details '.repeat(150)}`))
    expect(await session.submitUser(`u4 ${'details '.repeat(150)}`)).toEqual({})
    const summary = held(answer('SUMMARY'))
    t.kit.queue(summary.step)
    const conversation = await session.currentConversation()
    const task = await conversation.compact(undefined, BG)
    await summary.reached
    expect((await read()).phase).toBe('compaction')
    summary.release()
    await withTimeout(session.harness.waitForTask(task, BG), 5000, 'compaction')
    expect((await read()).phase).toBe('idle')
    expect(phases).not.toContain('branch_summary')
  })

  it('P3-13-04 interrupted (PIN-05): the root reads interrupted; reading resumes nothing', async () => {
    const { t } = await crashWith()
    const session = await t.open()
    expect(session.isInterrupted()).toBe(true)
    const row = await rootOf(session)
    expect(row.phase).toBe('interrupted')
    expect(row.lastActivityAt).not.toBe(0)
    expect(session.isInterrupted()).toBe(true)
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    expect(t.kit.callCount).toBe(0)
  })
})

describe('P3-13 runtime · spawned rows (PIN-02)', () => {
  it('P3-13-05 loaded spawned agents are listed (tool A, grandchild B, hook H), a destroyed one is not; after a reopen only ensureInstalled brings A back', async () => {
    const rig = await hookRig({
      dispatchProfiles: { nester: PROFILES.nester, explore: PROFILES.explore }
    })
    const session = rig.session
    // 根 → nester(A) → explore(B)；顺序请求，faux 按次序应答
    rig.kit.queue(
      callAgent('nester', 'pA'),
      callAgent('explore', 'pB', { id: 'call-b' }),
      answer('b done'),
      answer('a done'),
      answer('r1')
    )
    expect(await session.submitUser('spawn A')).toEqual({})
    // D：再派一个，然后销毁
    rig.kit.queue(callAgent('explore', 'pD', { id: 'call-d' }), answer('d done'), answer('r2'))
    expect(await session.submitUser('spawn D')).toEqual({})
    // H：宿主派发的 hook agent（起标题）
    queueRoles(rig.kit, { titler: [answer('A Title')] })
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await waitFor(() => rig.ends().length === 1, 5000, 'titler ended')

    const records = session.spawnedRecords()
    const A = records.find((record) => record.profileName === 'nester')!
    const B = records.find((record) => record.depth === 2)!
    const D = records.find((record) => record.profileName === 'explore' && record.depth === 1)!
    const H = records.find((record) => record.dispatch === 'hook')!
    expect([A, B, D, H].every((record) => record !== undefined)).toBe(true)
    await session.agents.destroy(D.conversationId)

    const rows = await session.monitorSnapshot()
    const spawned = rows.filter((row) => row.kind === 'spawned')
    expect(spawned.map((row) => row.agentId).sort()).toEqual(
      [A.agentId, B.agentId, H.agentId].sort()
    )
    expect(rows.map((row) => row.agentId)).not.toContain(D.agentId)
    for (const [record, parent, dispatch] of [
      [A, 's1', 'tool'],
      [B, A.agentId, 'tool'],
      [H, 's1', 'hook']
    ] as const) {
      const row = spawned.find((candidate) => candidate.agentId === record.agentId)!
      expect(row).toMatchObject({
        kind: 'spawned',
        rootSessionId: 's1',
        conversationId: record.conversationId,
        depth: record.depth,
        parentAgentId: parent,
        displayName: record.displayName,
        profileName: record.profileName,
        startedAt: record.createdAt,
        dispatch,
        phase: 'idle'
      })
    }
    expect(B.depth).toBe(2)
    expect(A.depth).toBe(1)

    // 换一个进程：闲着、没装扩展的历史 agent 都不列
    const next = await rig.reopen()
    const reopened = next.session
    const after = await reopened.monitorSnapshot()
    expect(after.filter((row) => row.kind === 'spawned')).toEqual([])
    expect(after.map((row) => row.kind)).toEqual(['root'])
    // 面板追问会先 ensureInstalled：A 回来
    await reopened.agents.ensureInstalled(A.conversationId)
    const back = (await reopened.monitorSnapshot()).filter((row) => row.kind === 'spawned')
    expect(back.map((row) => row.agentId)).toEqual([A.agentId])
    expect(back[0]!.phase).toBe('idle')
  })

  it('P3-13-05 a child that crashed mid-run is listed after the reopen, interrupted', async () => {
    const d = await hostD()
    const stall = stalled()
    d.t.kit.queue(callAgent('explore', 'p'), stall.step)
    const sent = d.session.submitUser('go').catch(() => undefined)
    await stall.reached
    const child = await firstChild(d.session)
    const next = await d.reopen()
    await sent
    const rows = await next.session.monitorSnapshot()
    const row = rows.find((candidate) => candidate.conversationId === child)
    expect(row).toMatchObject({ kind: 'spawned', phase: 'interrupted', dispatch: 'tool' })
    expect(rootRow(rows).phase).toBe('interrupted')
    expect(next.t.kit.callCount).toBe(0)
  })
})

describe('P3-13 runtime · usage, cost and context', () => {
  it('P3-13-06 cache totals from pi.usage, last from the newest assistant entry, contextTokens (PIN-04), own cost', async () => {
    const t = await makeHost()
    const stamp = stampUsage(t.kit)
    const session = await t.open()
    await session.createAgent()
    const fresh = await rootOf(session)
    expect(fresh.cache).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, reported: false })
    expect('last' in fresh.cache).toBe(false)
    expect(fresh.contextTokens).toBe(0)
    expect(fresh.cost).toEqual({ total: 0 })

    stamp.queue(
      { input: 400, output: 5, cost: 0.001 },
      { input: 300, cacheRead: 300, output: 5, cost: 0.002 },
      { input: 500, output: 5, cost: 0.004 }
    )
    t.kit.queue(answer('a1'), answer('a2'), answer('a3'))
    for (const text of ['u1', 'u2', 'u3']) expect(await session.submitUser(text)).toEqual({})
    const row = await rootOf(session)
    expect(row.cache).toEqual({
      input: 1200,
      cacheRead: 300,
      cacheWrite: 0,
      reported: true,
      last: { input: 500, cacheRead: 0, cacheWrite: 0 }
    })
    expect(row.contextTokens).toBe(505)
    const usage = await session.harness.snapshot(UsageDoc, ROOT, BG)
    expect(row.cost.total).toBeCloseTo(costOf(usage), 12)
    expect(row.cost.total).toBeCloseTo(0.007, 12)
    expect('calls' in row.cache).toBe(false)
  })

  it('P3-13-07 failed retries, the compaction summary and an aborted partial all count as spend (Q-P3-08); no calls field', async () => {
    const PRICE = 0.001
    const t = await makeHost({
      settingsOverrides: {
        ...TEST_SETTINGS_OVERRIDES,
        retry: { enabled: true, baseDelayMs: 1, maxRetries: 3 },
        compaction: { enabled: false, keepRecentTokens: 200 }
      }
    })
    const stamp = stampUsage(t.kit)
    const session = await t.open()
    await session.createAgent()
    const tokens = [10, 10, 20, 5, 7, 3]
    stamp.queue(...tokens.map((input) => ({ input, cost: input * PRICE })))
    // 两次可重试的失败，然后成功
    t.kit.queue(modelError('overloaded'), modelError('overloaded'), answer('ok'))
    expect(await session.submitUser('u1')).toEqual({})
    // 一轮够长的，压缩才有东西可摘要
    t.kit.queue(answer(`a2 ${'details '.repeat(150)}`))
    expect(await session.submitUser(`u2 ${'details '.repeat(150)}`)).toEqual({})
    t.kit.queue(answer('SUMMARY'))
    const conversation = await session.currentConversation()
    const task = await conversation.compact(undefined, BG)
    await withTimeout(session.harness.waitForTask(task, BG), 5000, 'compaction')
    // provider 交回的中止半截（带用量）
    t.kit.queue(fauxAssistantMessage([fauxText('par')], { stopReason: 'aborted' }))
    await session.submitUser('u3')
    await waitFor(() => stamp.stamped.length === tokens.length, 3000, 'all six requests')
    await waitFor(async () => !session.isBusy(), 3000, 'idle')

    const row = await rootOf(session)
    const spent = tokens.reduce((sum, n) => sum + n, 0)
    expect(row.cost.total).toBeCloseTo(spent * PRICE, 12)
    expect(row.cache.input).toBe(spent)
    expect(row.sessionCost).toBeCloseTo(spent * PRICE, 12)
    expect('calls' in row.cache).toBe(false)
    expect(Object.keys(row)).not.toContain('calls')
    expect(Object.keys(row)).not.toContain('counters')
  })

  it('P3-13-08 sessionCost = harness.usage(): the root turn, a titler run and a task-owned reviewer run, on every row', async () => {
    const rig = await hookRig()
    const prices: Record<Role, number> = { root: 0.01, titler: 0.02, reviewer: 0.04 }
    const stamp = stampUsage(rig.kit)
    stamp.price((context) => ({ input: 10, cost: prices[roleOf(context.messages)] }))
    queueRoles(rig.kit, {
      root: [callTool('askOp'), answer('root done')],
      reviewer: [
        callTool('next', { decision: 'allow', risk: 'low', summary: 's', reason: 'r' }, 'call-next')
      ],
      titler: [answer('A Title')]
    })
    expect(await rig.session.submitUser('clean the build directory')).toEqual({})
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await waitFor(() => rig.ends().length >= 1 && stamp.stamped.length === 4, 5000, 'titler ran')

    const expected = 2 * prices.root + prices.titler + prices.reviewer
    const rows = await rig.session.monitorSnapshot()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.sessionCost).toBeCloseTo(expected, 12)
    let summed = 0
    for (const id of await conversationIds(rig.session)) {
      summed += costOf(await rig.session.harness.snapshot(UsageDoc, id, BG))
    }
    expect(rootRow(rows).sessionCost).toBeCloseTo(summed, 12)
    expect(rootRow(rows).cost.total).toBeCloseTo(2 * prices.root, 12)
  })

  it('P3-13-09 after a rollback: the root row is the fork with its own cost 0; sessionCost keeps the abandoned branch; context follows the fork', async () => {
    const t = await makeHost()
    const stamp = stampUsage(t.kit)
    const session = await t.open()
    await session.createAgent()
    stamp.queue(
      { input: 100, output: 1, cost: 0.01 },
      { input: 200, output: 1, cost: 0.02 },
      { input: 300, output: 1, cost: 0.03 }
    )
    const ids = await threeTurns(session, t)
    const before = await rootOf(session)
    expect(before.conversationId).toBe(ROOT)
    expect(before.cost.total).toBeCloseTo(0.06, 12)
    expect(before.contextTokens).toBe(301)

    const result = await session.rollbackTo(ids.u1)
    expect(result.ok).toBe(true)
    await session.createAgent()
    const fork = session.lock!.conversationId
    expect(fork).not.toBe(ROOT)
    const after = await rootOf(session)
    expect(after.conversationId).toBe(fork)
    expect(after.cost).toEqual({ total: 0 })
    expect(after.sessionCost).toBeCloseTo(0.06, 12)
    expect(after.contextTokens).toBe(0)

    stamp.queue({ input: 40, output: 2, cost: 0.005 })
    t.kit.queue(answer('F1'))
    expect(await session.submitUser('on the fork')).toEqual({})
    const later = await rootOf(session)
    expect(later.contextTokens).toBe(42)
    expect(later.cost.total).toBeCloseTo(0.005, 12)
    expect(later.sessionCost).toBeCloseTo(0.065, 12)
  })

  it('P3-13-10 queue counts: one steer and two follow-ups; a notice write and a notice-shaped steer do not count', async () => {
    const t = await makeHost()
    const session = await t.open()
    await session.createAgent()
    const gate = held(answer('first'))
    t.kit.queue(gate.step, answer('second'))
    const first = session.submitUser('go')
    await gate.reached
    await session.steer('a')
    await session.followUp('b')
    await session.followUp('c')
    await session.writeNotice({ text: 'a background thing finished', kind: 'test' })
    await session.steer('<background-task id="x">done</background-task>')
    const row = await rootOf(session)
    expect(row.queue).toEqual({ steer: 1, followUp: 2 })
    expect(Object.keys(row.queue).sort()).toEqual(['followUp', 'steer'])
    gate.release()
    await withTimeout(first, 5000, 'first')
  })
})

describe('P3-13 runtime · read-only, cheap, closed', () => {
  it('P3-13-11 ten reads: no commit, no projector, no rebuild / persona seam, the scheduler stays paused, evictable unchanged, no broadcast, LRU recency untouched', async () => {
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'p'), answer('child done'), answer('root done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const next = await d.reopen()
    const session = next.session
    // option A：空闲重启清掉了根的锁 —— 在这个进程里重新创建，快照里才有根那一行
    expect(session.lock).toBeUndefined()
    await session.createAgent()
    const [record] = session.spawnedRecords()
    await session.agents.ensureInstalled(record!.conversationId)
    const rows = await session.monitorSnapshot()
    expect(rows.map((row) => row.kind)).toEqual(['root', 'spawned'])

    const ensure = vi.spyOn(session.agents, 'ensureInstalled')
    const rebuilds = next.t.toolHost.rebuildCalls.length
    const resolves = next.t.toolHost.resolveCalls.length
    const varCalls = next.vars.state.calls
    const broadcasts = next.t.broadcasts.length
    const evictable = (session as unknown as { evictable: boolean }).evictable
    const commits = recordPublications(session.harness)
    for (let index = 0; index < 10; index++) await session.monitorSnapshot()
    commits.stop()
    expect(commits.publications).toEqual([])
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    expect(ensure).not.toHaveBeenCalled()
    expect(next.t.toolHost.rebuildCalls).toHaveLength(rebuilds)
    expect(next.t.toolHost.resolveCalls).toHaveLength(resolves)
    expect(next.vars.state.calls).toBe(varCalls)
    expect(next.t.broadcasts).toHaveLength(broadcasts)
    expect((session as unknown as { evictable: boolean }).evictable).toBe(evictable)
    const internals = session as unknown as {
      projectorEntry: unknown
      agentProjectors: Map<string, unknown>
    }
    expect(internals.projectorEntry).toBeUndefined()
    expect(internals.agentProjectors.size).toBe(0)
    expect(next.t.kit.callCount).toBe(0)

    // LRU：两条闲着的会话，轮询较旧的那条；第三条打开时被修剪的仍是较旧的那条
    const lru = await makeHost({ maxIdleOpen: 2 })
    const older = await lru.open('a')
    await older.createAgent()
    const newer = await lru.open('b')
    await newer.createAgent()
    for (let index = 0; index < 5; index++) await older.monitorSnapshot()
    await lru.open('c')
    await waitFor(() => older.closed, 3000, 'the older session trimmed')
    expect(newer.closed).toBe(false)
  })

  it('P3-13-12 a closed handle rejects with SessionClosedError and never throws synchronously', async () => {
    const t = await makeHost()
    const session = await t.open()
    await session.createAgent()
    await t.host.close('s1')
    let pending: Promise<unknown> | undefined
    expect(() => {
      pending = session.monitorSnapshot()
    }).not.toThrow()
    await expect(pending).rejects.toBeInstanceOf(SessionClosedError)
    expect(session.spawnedRecords()).toEqual([])
  })

  it('P3-13-17 lastActivityAt (PIN-07): now while running; otherwise the newest entry timestamp; startedAt with no entry', async () => {
    const clock = { now: W_NOW }
    const t = await makeHost({ now: () => clock.now, tools: [probeTool()] })
    const session = await t.open()
    await session.createAgent()
    const fresh = await rootOf(session)
    expect(fresh.lastActivityAt).toBe(session.lock!.createdAt)
    expect(fresh.startedAt).toBe(W_NOW)

    const gate = held(answer('streamed'))
    t.kit.queue(gate.step)
    const sent = session.submitUser('go')
    await gate.reached
    clock.now = W_NOW + 5_000
    expect((await rootOf(session)).lastActivityAt).toBe(W_NOW + 5_000)
    gate.release()
    expect(await sent).toEqual({})
    clock.now = W_NOW + 60_000
    const entries = await allEntries(await session.currentConversation())
    const newest = [...entries]
      .reverse()
      .map((entry) => entry.model?.[0]?.timestamp)
      .find((ts): ts is number => typeof ts === 'number' && ts > 0)
    expect(newest).toBeDefined()
    expect((await rootOf(session)).lastActivityAt).toBe(newest)
  })
})
