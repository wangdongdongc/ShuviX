/**
 * 派生 agent 路由 · 打开时重建索引（P3-14 runtime 段，01–09；docs/pi-durable/p3-1314-test-design.md）：
 *
 *   P3-14-01 重建：新进程里打开会话、`indexSession` 之后 A（深度 1）/ B（A 的子，深度 2）/ H（hook）都认得；
 *            之前一个都不认得；父 = 会话 id（A、H）/ A 的 agentId（B）；展示名 / 档案 / 深度与记录相同
 *   P3-14-02 重建是惰性的：不提交、不装扩展、不调模型、不广播、不登记任务；不算忙
 *   P3-14-03 写坏的记录：其余照样认得、它不在；打开不抛；路由不记警告（目录已经警告过一次）
 *   P3-14-04 不覆盖活条目：onCreated 在前 → 重建不动它（连同运行标记）；重建在前 → onCreated 赢（FC）
 *            TITLE-4：onCreated 赢的也包括行标题的显示名 + 描述 —— 任务条目被清掉之后追问重建，用的是它那一份
 *   P3-14-05 重启之后追问：continue 一次、扩展懒装一次、任务条目按记录建、sub_session_end 带回答、没有 user_message
 *   P3-14-06 重建之后的读与动作：getRuntimeInfo = agentInfo（不装扩展）；空闲中断无事；销毁丢条目、卸扩展
 *   P3-14-07 销毁墓碑（PIN-11）：同进程关了再开不收回；新进程又可路由
 *   P3-14-08 关闭原因：remove 留着（关着时 getRuntimeInfo 为 null、重开之后有）；destroy 只丢这条会话的
 *   P3-14-09 两条会话：各自重建、删一条不碰另一条、agentId 从不映错会话
 *   P3-14-12（运行时一半）追问 / 宿主派发在驱动会话之前等宿主的 `sessionReady`（桌面整合那一半在
 *            sessionSignalsIntegration：没有它，peek 刚开的会话上这一轮的 agent_start 会丢）
 *
 * 派发卡的 call id（`parentToolCallId`，记录里是 `ownerCallId`）熬过重建：
 *   RB-1 （并在 P3-14-01 / 05 里）重启之后追问重建的任务行带回派发它的那次 tool_call id：A = 根里那次、B = A 对话
 *        里那次（不是根的）；hook agent H 没有这个键
 *   RB-2 按记录重建（FC）：带 ownerCallId 的记录 → subject 有它；早于这个字段的记录、hook 记录 → 没有这个键；
 *        清掉再追问一次还在
 *   RB-3 真存储里的旧记录（没有 ownerCallId）：照样认得、不算写坏、追问照常，subject 没有这个键
 *   RB-4 （即 P3-14-03 的各行）ownerCallId 写坏（42 / null / 空串）与删掉 depth 一样：那条不进索引，其余照样，
 *        路由不记警告、目录警告一次
 *   RB-5 （并在 TITLE-4 / P3-14-04 (a) 里）派发的值是权威：先重建后派发、先派发后重建，清掉再追问用的都是派发
 *        的那个 call id，不是记录里过期的
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../../durable/context'
import { AgentStateDoc } from '../../durable/docs'
import type { DurableSession } from '../../durable/durableSession'
import { answer, held } from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import { recordPublications } from '../../durable/__tests__/support/commits'
import { extensionTools } from '../../durable/__tests__/support/scenario'
import { callAgent, hookRec, PROFILES, rec } from '../../durable/__tests__/support/spawn'
import { deferred, withTimeout } from '../../durable/__tests__/support/wait'
import {
  CALL,
  createdInfo,
  fakeSession,
  hostR,
  routerKit,
  toolParams,
  type HostR
} from '../../durable/__tests__/support/router'
import type { SpawnOutcome } from '../../durable/spawn'

registerHostCleanup()

const RESTART_TIMEOUT = 30000

interface Agent {
  agentId: string
  conversationId: ConversationId
}

/** 进程 1：根派发 nester（A），A 再派发 explore（B）；再由宿主派发一个 hook agent（H）。全部答完 */
async function threeAgents(r: HostR): Promise<{ A: Agent; B: Agent; H: Agent }> {
  r.t.kit.queue(
    callAgent('nester', 'mid'),
    callAgent('explore', 'leaf', { id: 'call-g' }),
    answer('leaf done'),
    answer('mid done'),
    answer('done')
  )
  expect(await r.session.submitUser('go')).toEqual({})
  r.t.kit.queue(answer('titled'))
  const hook = await r.router.runTask({
    sessionId: 's1',
    owner: { anchor: true },
    agentType: PROFILES.explore,
    prompt: 'title it',
    description: 'title',
    hook: { name: 'auto-title', runId: 'r1' }
  })
  expect(hook.result).toBe('titled')
  const [a, b, h] = r.registers().map((event) => event.sessionId)
  const of = (agentId: string): Agent => ({
    agentId,
    conversationId: r.router.locate(agentId)!.conversationId as ConversationId
  })
  return { A: of(a!), B: of(b!), H: of(h!) }
}

/** 只派发一个 explore（A）并答完 */
async function headline(r: HostR, session: DurableSession = r.session): Promise<Agent> {
  r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
  expect(await session.submitUser('go')).toEqual({})
  const agentId = r.registers().at(-1)!.sessionId
  return {
    agentId,
    conversationId: r.router.locate(agentId)!.conversationId as ConversationId
  }
}

const spawnedRebuilds = (r: HostR, agentId: string): number =>
  r.t.toolHost.rebuildCalls.filter(
    (record) => record.kind === 'spawned' && 'agentId' in record && record.agentId === agentId
  ).length

describe('router · rebuild at open', () => {
  it(
    'P3-14-01 a new process: A, B and H are routable after indexSession, none before; parents, names, profiles, depths from the records',
    async () => {
      const first = await hostR()
      const { A, B, H } = await threeAgents(first)
      const r2 = await first.reopen()
      for (const agent of [A, B, H]) {
        expect(r2.router.has(agent.agentId)).toBe(false)
        expect(r2.router.locate(agent.agentId)).toBeUndefined()
      }

      r2.router.indexSession(r2.session)
      for (const agent of [A, B, H]) {
        expect(r2.router.has(agent.agentId)).toBe(true)
        expect(r2.router.locate(agent.agentId)).toEqual({
          sessionId: 's1',
          conversationId: agent.conversationId
        })
      }

      // 条目里的父 / 展示名 / 档案 / 深度只在追问时露面：sub_session_end 的父、追问重建的任务条目
      r2.t.kit.queue(answer('a again'), answer('b again'), answer('h again'))
      for (const agent of [A, B, H]) {
        await withTimeout(
          r2.router.continueTask({ subSessionId: agent.agentId, text: 'more' }),
          5000,
          `continue ${agent.agentId}`
        )
      }
      expect(r2.ends().map((end) => [end.sessionId, end.parentSessionId])).toEqual([
        [A.agentId, 's1'],
        [B.agentId, A.agentId],
        [H.agentId, 's1']
      ])
      expect(r2.task(A.agentId)).toMatchObject({
        title: 'Nester · look',
        sessionId: 's1',
        subject: { kind: 'agent', profileName: 'nester', depth: 1 }
      })
      expect(r2.task(B.agentId)).toMatchObject({
        title: 'Explorer · look',
        sessionId: 's1',
        subject: { kind: 'agent', profileName: 'explore', depth: 2 }
      })
      expect(r2.task(H.agentId)).toMatchObject({
        title: 'Explorer · title',
        sessionId: 's1',
        subject: { kind: 'agent', profileName: 'explore', depth: 1 }
      })
      // RB-1：派发卡的 call id 随记录回来 —— A 是根里那次调用，B 是 A 对话里那次（不是根的）；hook 派发没有
      expect(r2.task(A.agentId)!.subject).toEqual({
        kind: 'agent',
        profileName: 'nester',
        depth: 1,
        parentToolCallId: CALL
      })
      expect(r2.task(B.agentId)!.subject).toEqual({
        kind: 'agent',
        profileName: 'explore',
        depth: 2,
        parentToolCallId: 'call-g'
      })
      expect('parentToolCallId' in r2.task(H.agentId)!.subject).toBe(false)
    },
    RESTART_TIMEOUT
  )

  it(
    'P3-14-02 the rebuild is inert: no commit, no install / tool rebuild, no LLM call, no broadcast, no task; not busy',
    async () => {
      const first = await hostR()
      const { A } = await threeAgents(first)
      const r2 = await first.reopen()
      const commits = recordPublications(r2.session.harness)
      const ensure = vi.spyOn(r2.session.agents, 'ensureInstalled')
      const rebuilds = r2.t.toolHost.rebuildCalls.length
      const resolves = r2.t.toolHost.resolveCalls.length
      const requests = r2.t.kit.requests.length
      const broadcasts = r2.t.broadcasts.length

      r2.router.indexSession(r2.session)
      await Promise.resolve()

      expect(commits.publications).toEqual([])
      commits.stop()
      expect(ensure).not.toHaveBeenCalled()
      expect(r2.t.toolHost.rebuildCalls).toHaveLength(rebuilds)
      expect(r2.t.toolHost.resolveCalls).toHaveLength(resolves)
      expect(r2.t.kit.requests).toHaveLength(requests)
      expect(r2.t.broadcasts).toHaveLength(broadcasts)
      expect(r2.events).toEqual([])
      expect(r2.taskBroadcasts).toEqual([])
      expect(r2.tasks!.list('s1')).toEqual([])
      // 运行标记是空的：追问不被当成忙
      r2.t.kit.queue(answer('again'))
      await expect(
        withTimeout(r2.router.continueTask({ subSessionId: A.agentId, text: 'more' }), 5000)
      ).resolves.toBeUndefined()
    },
    RESTART_TIMEOUT
  )

  // RB-4：ownerCallId 给了就得是非空串 —— 写坏它与删掉 depth 同一个下场
  const corruptions: [string, (state: Record<string, unknown>) => void][] = [
    ['depth deleted', (state) => void delete state.depth],
    ['ownerCallId = 42', (state) => void (state.ownerCallId = 42)],
    ['ownerCallId = null', (state) => void (state.ownerCallId = null)],
    ['ownerCallId = ""', (state) => void (state.ownerCallId = '')]
  ]

  it.each(corruptions)(
    'P3-14-03 a malformed record (%s): the others are indexed, it is absent; open does not throw; the router logs nothing',
    async (_row, corrupt) => {
      const first = await hostR()
      const { A, B, H } = await threeAgents(first)
      await first.session.harness.commit(async (tx) => {
        corrupt((await tx.doc(AgentStateDoc, B.conversationId)) as Record<string, unknown>)
      }, BG)
      const warn = vi.fn()
      const r2 = await first.reopen({ logger: { info: () => {}, warn, error: warn } })
      r2.router.indexSession(r2.session)
      expect(r2.router.has(A.agentId)).toBe(true)
      expect(r2.router.has(H.agentId)).toBe(true)
      expect(r2.router.has(B.agentId)).toBe(false)
      expect(warn).not.toHaveBeenCalled()
      // 目录在打开时警告过一次（那是目录的事，不是路由的）
      expect(r2.t.warnings.filter((line) => line.includes('malformed'))).toHaveLength(1)
    },
    RESTART_TIMEOUT
  )

  it('P3-14-04 (a) onCreated before the rebuild: the live entry and its running flag survive (FC)', async () => {
    const release = deferred<SpawnOutcome>()
    const fc = fakeSession({
      spawn: async (params) => {
        params.onCreated?.(createdInfo({ agentId: 'sub-a1', conversationId: 2 as ConversationId }))
        return release.promise
      },
      records: () => [
        rec({ agentId: 'sub-a1', conversationId: 9 as ConversationId, ownerCallId: 'stale' })
      ]
    })
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    const running = kit.router.runTask(toolParams())
    await vi.waitFor(() => expect(kit.router.has('sub-a1')).toBe(true))

    kit.router.indexSession(fc.session)
    expect(kit.router.locate('sub-a1')).toEqual({ sessionId: 's1', conversationId: 2 })
    await expect(kit.router.continueTask({ subSessionId: 'sub-a1', text: 'x' })).rejects.toThrow(
      /Sub-session is busy: sub-a1/
    )
    release.resolve({ result: 'found', conversationId: 2 as ConversationId, agentId: 'sub-a1' })
    await running
    expect(kit.router.locate('sub-a1')).toEqual({ sessionId: 's1', conversationId: 2 })

    // RB-5：清掉再追问，重建的行带的是派发的 call id（tc-1），不是记录里过期的那个
    expect(kit.tasks!.dismiss('sub-a1')).toBe(true)
    await kit.router.continueTask({ subSessionId: 'sub-a1', text: 'more' })
    expect(kit.task('sub-a1')!.subject).toEqual({
      kind: 'agent',
      profileName: 'explore',
      depth: 1,
      parentToolCallId: 'tc-1'
    })
  })

  it('P3-14-04 (b) the rebuild first, then onCreated: the onCreated values win (FC)', async () => {
    const fc = fakeSession({
      spawn: async (params) => {
        params.onCreated?.(
          createdInfo({ agentId: 'sub-a1', conversationId: 2 as ConversationId, depth: 1 })
        )
        return { result: 'found', conversationId: 2 as ConversationId, agentId: 'sub-a1' }
      },
      records: () => [
        rec({ agentId: 'sub-a1', conversationId: 9 as ConversationId, displayName: 'Stale' })
      ]
    })
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    kit.router.indexSession(fc.session)
    expect(kit.router.locate('sub-a1')).toEqual({ sessionId: 's1', conversationId: 9 })
    await kit.router.runTask(toolParams())
    expect(kit.router.locate('sub-a1')).toEqual({ sessionId: 's1', conversationId: 2 })
    // 追问按 onCreated 的那份走：对话 2
    await kit.router.continueTask({ subSessionId: 'sub-a1', text: 'more' })
    expect(fc.continueCalls).toEqual([[2, 'more']])
  })

  it('TITLE-4 the rebuild first, then onCreated: a row recreated after dismiss is titled from onCreated, not the stale record (FC)', async () => {
    const fc = fakeSession({
      spawn: async (params) => {
        params.onCreated?.(createdInfo())
        return { result: 'found', conversationId: 2 as ConversationId, agentId: 'sub-a1' }
      },
      records: () => [
        rec({
          agentId: 'sub-a1',
          conversationId: 9 as ConversationId,
          displayName: 'Stale',
          description: 'stale desc',
          ownerCallId: 'stale-call'
        })
      ]
    })
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    kit.router.indexSession(fc.session)
    await kit.router.runTask(toolParams())
    expect(kit.task('sub-a1')?.title).toBe('Explorer · look')

    // 面板清掉这条，再追问：重建出来的行标题取 onCreated 记下的显示名 + 描述（Explorer / look）
    expect(kit.tasks!.dismiss('sub-a1')).toBe(true)
    expect(kit.task('sub-a1')).toBeUndefined()
    await kit.router.continueTask({ subSessionId: 'sub-a1', text: 'more' })
    expect(fc.continueCalls).toEqual([[2, 'more']])
    expect(kit.task('sub-a1')).toMatchObject({ title: 'Explorer · look', status: 'done' })
    expect(kit.task('sub-a1')?.title).not.toBe('Stale · stale desc')
    // RB-5：call id 也取派发的（toolParams 的 tc-1），不是过期记录里的 stale-call
    expect(kit.task('sub-a1')!.subject).toEqual({
      kind: 'agent',
      profileName: 'explore',
      depth: 1,
      parentToolCallId: 'tc-1'
    })
  })

  it('RB-2 indexed from records (FC): a record with ownerCallId → the recreated subject carries it; a legacy record and a hook record → no key; still there after another dismiss', async () => {
    const fc = fakeSession({
      records: () => [
        rec({ ownerCallId: 'call-x' }),
        rec({ agentId: 'sub-a2', conversationId: 3 as ConversationId }),
        hookRec({ conversationId: 4 as ConversationId })
      ]
    })
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    kit.router.indexSession(fc.session)
    for (const agentId of ['sub-a1', 'sub-a2', 'sub-h1']) {
      await kit.router.continueTask({ subSessionId: agentId, text: 'more' })
    }
    expect(fc.continueCalls).toEqual([
      [2, 'more'],
      [3, 'more'],
      [4, 'more']
    ])
    expect(kit.task('sub-a1')!.subject).toEqual({
      kind: 'agent',
      profileName: 'explore',
      depth: 1,
      parentToolCallId: 'call-x'
    })
    // 早于这个字段的记录：不连回派发卡，别的照常（标题照旧）
    expect(kit.task('sub-a2')).toMatchObject({ title: 'Explorer · look around', status: 'done' })
    expect(kit.task('sub-a2')!.subject).toEqual({ kind: 'agent', profileName: 'explore', depth: 1 })
    expect('parentToolCallId' in kit.task('sub-a2')!.subject).toBe(false)
    // hook 派发：没有派发卡
    expect(kit.task('sub-h1')!.subject).toEqual({ kind: 'agent', profileName: 'titler', depth: 1 })
    expect('parentToolCallId' in kit.task('sub-h1')!.subject).toBe(false)

    // 再清掉一次、再追问：索引条目还记得它
    expect(kit.tasks!.dismiss('sub-a1')).toBe(true)
    await kit.router.continueTask({ subSessionId: 'sub-a1', text: 'again' })
    expect(kit.task('sub-a1')!.subject).toEqual({
      kind: 'agent',
      profileName: 'explore',
      depth: 1,
      parentToolCallId: 'call-x'
    })
  })

  it(
    'P3-14-05 a follow-up after a restart: one continue on A, the extension installed once lazily, the task from the record, end carries the reply, no user_message',
    async () => {
      const first = await hostR({ indexOnOpen: true })
      const A = await headline(first)
      const r2 = await first.reopen()
      expect(r2.router.has(A.agentId)).toBe(true)
      expect(spawnedRebuilds(r2, A.agentId)).toBe(0)
      const spy = vi.spyOn(r2.session.agents, 'continue')

      r2.t.kit.queue(answer('more ok'))
      await withTimeout(
        r2.router.continueTask({ subSessionId: A.agentId, text: 'more' }),
        5000,
        'continue'
      )
      expect(spy.mock.calls).toEqual([[A.conversationId, 'more']])
      expect(spawnedRebuilds(r2, A.agentId)).toBe(1)
      expect(r2.task(A.agentId)).toMatchObject({
        title: 'Explorer · look',
        sessionId: 's1',
        status: 'done',
        // RB-1：宿主接线的重建（indexOnOpen）也把派发卡的 call id 带回来
        subject: { kind: 'agent', profileName: 'explore', depth: 1, parentToolCallId: CALL }
      })
      expect(r2.ends()).toEqual([
        {
          type: 'sub_session_end',
          sessionId: A.agentId,
          parentSessionId: 's1',
          result: 'more ok',
          isError: false
        }
      ])
      expect(r2.userMessages()).toEqual([])
      expect(r2.registers()).toEqual([])
    },
    RESTART_TIMEOUT
  )

  it(
    'RB-3 a legacy record without ownerCallId (real storage): routable, not malformed, the follow-up works; the subject has no parentToolCallId',
    async () => {
      const first = await hostR()
      const A = await headline(first)
      // 这一版写下的记录有它；删掉 = 早于这个字段的那类记录
      const written = await first.session.harness.snapshot(AgentStateDoc, A.conversationId, BG)
      expect(written?.ownerCallId).toBe(CALL)
      await first.session.harness.commit(async (tx) => {
        delete (await tx.doc(AgentStateDoc, A.conversationId)).ownerCallId
      }, BG)
      const warn = vi.fn()
      const r2 = await first.reopen({ logger: { info: () => {}, warn, error: warn } })
      r2.router.indexSession(r2.session)
      expect(r2.router.locate(A.agentId)).toEqual({
        sessionId: 's1',
        conversationId: A.conversationId
      })
      expect(warn).not.toHaveBeenCalled()
      expect(r2.t.warnings.filter((line) => line.includes('malformed'))).toEqual([])

      const spy = vi.spyOn(r2.session.agents, 'continue')
      r2.t.kit.queue(answer('more ok'))
      await withTimeout(
        r2.router.continueTask({ subSessionId: A.agentId, text: 'more' }),
        5000,
        'continue'
      )
      expect(spy.mock.calls).toEqual([[A.conversationId, 'more']])
      const task = r2.task(A.agentId)!
      expect(task).toMatchObject({ title: 'Explorer · look', sessionId: 's1', status: 'done' })
      expect(task.subject).toEqual({ kind: 'agent', profileName: 'explore', depth: 1 })
      expect(r2.ends().map((end) => [end.sessionId, end.parentSessionId])).toEqual([
        [A.agentId, 's1']
      ])
    },
    RESTART_TIMEOUT
  )

  it(
    'P3-14-06 reads and actions after a rebuild: runtime info = agentInfo without installing; idle interrupt is a no-op; destroy drops the entry and uninstalls',
    async () => {
      const first = await hostR({ indexOnOpen: true })
      const A = await headline(first)
      const r2 = await first.reopen()
      const info = await r2.router.getRuntimeInfo(A.agentId)
      expect(info).not.toBeNull()
      expect(info).toEqual(await r2.session.agentInfo(A.conversationId))
      expect(spawnedRebuilds(r2, A.agentId)).toBe(0)
      expect(extensionTools(r2.t, `shuvix.agent.${A.conversationId}`)).toBeUndefined()

      await r2.router.interrupt(A.agentId)
      expect(r2.events).toEqual([])
      expect(r2.taskBroadcasts).toEqual([])

      // 装上（一次追问），再销毁：条目、任务、扩展一起走
      r2.t.kit.queue(answer('more ok'))
      await withTimeout(r2.router.continueTask({ subSessionId: A.agentId, text: 'more' }), 5000)
      expect(extensionTools(r2.t, `shuvix.agent.${A.conversationId}`)).toBeDefined()
      await r2.router.destroy(A.agentId)
      expect(r2.router.has(A.agentId)).toBe(false)
      expect(r2.task(A.agentId)).toBeUndefined()
      expect(extensionTools(r2.t, `shuvix.agent.${A.conversationId}`)).toBeUndefined()
    },
    RESTART_TIMEOUT
  )

  it(
    'P3-14-06 destroy without a task entry and without the extension installed: still drops the entry',
    async () => {
      const first = await hostR({ indexOnOpen: true })
      const A = await headline(first)
      const r2 = await first.reopen()
      expect(r2.task(A.agentId)).toBeUndefined()
      await r2.router.destroy(A.agentId)
      expect(r2.router.has(A.agentId)).toBe(false)
      expect(r2.task(A.agentId)).toBeUndefined()
    },
    RESTART_TIMEOUT
  )

  it(
    'P3-14-07 the destroy tombstone (PIN-11): close and reopen in the same process does not bring it back; a new process does',
    async () => {
      const first = await hostR({ indexOnOpen: true })
      const A = await headline(first)
      await first.router.destroy(A.agentId)
      expect(first.router.has(A.agentId)).toBe(false)
      await first.t.host.close('s1')
      await first.t.host.open('s1')
      expect(first.router.has(A.agentId)).toBe(false)

      const r2 = await first.reopen()
      expect(r2.router.locate(A.agentId)).toEqual({
        sessionId: 's1',
        conversationId: A.conversationId
      })
    },
    RESTART_TIMEOUT
  )

  it(
    'P3-14-08 close reasons: remove keeps the entries (info null while closed, back after reopen); destroy drops only that session; continue then rejects without a peek',
    async () => {
      const r = await hostR({ indexOnOpen: true })
      const A = await headline(r)
      const s2 = await r.open('s2')
      const A2 = await headline(r, s2)

      await r.t.host.close('s1')
      expect(r.router.locate(A.agentId)).toEqual({
        sessionId: 's1',
        conversationId: A.conversationId
      })
      expect(await r.router.getRuntimeInfo(A.agentId)).toBeNull()
      await r.t.host.open('s1')
      expect(await r.router.getRuntimeInfo(A.agentId)).not.toBeNull()

      await r.t.host.delete('s1')
      expect(r.router.has(A.agentId)).toBe(false)
      expect(r.router.locate(A2.agentId)).toEqual({
        sessionId: 's2',
        conversationId: A2.conversationId
      })
      const peeks = r.peeks.length
      await expect(r.router.continueTask({ subSessionId: A.agentId, text: 'x' })).rejects.toThrow(
        new RegExp(`Sub-session not found: ${A.agentId}`)
      )
      expect(r.peeks).toHaveLength(peeks)
    },
    RESTART_TIMEOUT
  )

  it('P3-14-08 the router hook directly: remove is a no-op, destroy drops every entry of that session only (FC)', async () => {
    const records = [
      rec({ agentId: 'sub-a1', conversationId: 2 as ConversationId }),
      rec({ agentId: 'sub-a2', conversationId: 3 as ConversationId })
    ]
    const s1 = fakeSession({ records: () => records })
    const s2 = fakeSession({
      records: () => [rec({ agentId: 'sub-b1', conversationId: 2 as ConversationId })]
    })
    ;(s2.session as { sessionId: string }).sessionId = 's2'
    const kit = routerKit({
      get: (id) => (id === 's1' ? s1.session : s2.session),
      peek: async (id) => (id === 's1' ? s1.session : s2.session)
    })
    kit.router.indexSession(s1.session)
    kit.router.indexSession(s2.session)
    kit.router.onSessionClosed('s1', 'remove')
    expect(['sub-a1', 'sub-a2', 'sub-b1'].map((id) => kit.router.has(id))).toEqual([
      true,
      true,
      true
    ])
    kit.router.onSessionClosed('s1', 'destroy')
    expect(['sub-a1', 'sub-a2', 'sub-b1'].map((id) => kit.router.has(id))).toEqual([
      false,
      false,
      true
    ])
    expect(kit.router.locate('sub-b1')).toEqual({ sessionId: 's2', conversationId: 2 })
  })

  it(
    'P3-14-09 two sessions: independent rebuilds; deleting s2 leaves s1; an agentId never maps to the wrong session',
    async () => {
      const first = await hostR({ indexOnOpen: true })
      const A1 = await headline(first)
      const s2 = await first.open('s2')
      const A2 = await headline(first, s2)

      const r2 = await first.reopen()
      expect(r2.router.has(A1.agentId)).toBe(true)
      // s2 还没在这个进程里打开过：它的 agent 认不得
      expect(r2.router.has(A2.agentId)).toBe(false)
      await r2.t.host.open('s2')
      expect(r2.router.locate(A1.agentId)).toEqual({
        sessionId: 's1',
        conversationId: A1.conversationId
      })
      expect(r2.router.locate(A2.agentId)).toEqual({
        sessionId: 's2',
        conversationId: A2.conversationId
      })

      await r2.t.host.delete('s2')
      expect(r2.router.has(A2.agentId)).toBe(false)
      expect(r2.router.locate(A1.agentId)).toEqual({
        sessionId: 's1',
        conversationId: A1.conversationId
      })
    },
    RESTART_TIMEOUT
  )
})

describe('router · rebuild under a held follow-up', () => {
  it(
    'P3-14-04 (a, real host) a follow-up in flight keeps its busy flag across a reopen-triggered rebuild',
    async () => {
      const first = await hostR({ indexOnOpen: true })
      const A = await headline(first)
      const r2 = await first.reopen()
      const step = held(answer('more ok'))
      r2.t.kit.queue(step.step)
      const continued = r2.router.continueTask({ subSessionId: A.agentId, text: 'more' })
      await step.reached
      // 同一条会话再报一次打开（别的监听者扇出、或另一次 peek）：重建不碰在跑的条目
      r2.router.indexSession(r2.session)
      await expect(
        r2.router.continueTask({ subSessionId: A.agentId, text: 'again' })
      ).rejects.toThrow(new RegExp(`Sub-session is busy: ${A.agentId}`))
      step.release()
      await withTimeout(continued, 5000, 'continue')
    },
    RESTART_TIMEOUT
  )
})

describe('router · waiting for the host signals (P3-14-12)', () => {
  it('a follow-up waits for sessionReady before continuing; an unknown id never asks', async () => {
    const order: string[] = []
    const ready = deferred()
    const fc = fakeSession({
      continue: async (conversationId, text) => {
        order.push(`continue:${conversationId}:${text}`)
        return { result: 'more ok' }
      },
      records: () => [rec({ agentId: 'sub-a1', conversationId: 2 as ConversationId })]
    })
    const kit = routerKit(
      { get: () => undefined, peek: async () => fc.session },
      {
        sessionReady: async (sessionId) => {
          order.push(`ready:${sessionId}`)
          await ready.promise
        }
      }
    )
    kit.router.indexSession(fc.session)
    const continued = kit.router.continueTask({ subSessionId: 'sub-a1', text: 'more' })
    await vi.waitFor(() => expect(order).toEqual(['ready:s1']))
    ready.resolve()
    await continued
    expect(order).toEqual(['ready:s1', 'continue:2:more'])
    await expect(kit.router.continueTask({ subSessionId: 'sub-x', text: 'x' })).rejects.toThrow(
      /Sub-session not found/
    )
    expect(order).toHaveLength(2)
  })

  it('a host dispatch waits for sessionReady before spawning; a tool dispatch does not ask', async () => {
    const order: string[] = []
    const fc = fakeSession({
      spawn: async (params) => {
        order.push('spawn')
        params.onCreated?.(createdInfo())
        return { result: 'found', conversationId: 2 as ConversationId, agentId: 'sub-a1' }
      }
    })
    const kit = routerKit(
      { get: () => fc.session, peek: async () => fc.session },
      { sessionReady: async (sessionId) => void order.push(`ready:${sessionId}`) }
    )
    await kit.router.runTask(toolParams({ owner: { anchor: true } }))
    expect(order).toEqual(['ready:s1', 'spawn'])
    order.length = 0
    await kit.router.runTask(toolParams())
    expect(order).toEqual(['spawn'])
  })
})
