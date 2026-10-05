/**
 * 派生 agent 路由 · 会话映射与 agentId 索引（P2-05 A 段，01–07）：runTask 按会话找到协调器；子 agent 建好的那一刻
 * 广播 register、登记任务、记下索引；索引在完成与 LRU 关闭之后仍在、从不为查询打开会话；非工具拥有者在 P2-08
 * 之前以 PhasePendingError 拒绝（PIN-03）。
 */
import type { JsonValue } from '@earendil-works/chord'
import type { DurableSession } from '../../durable/durableSession'
import { describe, expect, it, vi } from 'vitest'
import { isPhasePendingError } from '../../errors/phasePending'
import { backgroundContext as BG } from '../../durable/context'
import { spawnedAgentRecordOf } from '../../durable/agentRecord'
import { answer } from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import {
  callAgent,
  childOf,
  dispatchTask,
  PROFILES
} from '../../durable/__tests__/support/spawn'
import {
  CALL,
  fakeSession,
  hostR,
  routerKit,
  toolParams,
  type HostR
} from '../../durable/__tests__/support/router'
import type { RunTaskParams, SubAgentManager } from '../manager'

registerHostCleanup()

/** -01 的形状：一次派发跑完；交回 agentId 与子对话 */
async function headline(r: HostR): Promise<{ A: string; C: number }> {
  r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
  expect(await r.session.submitUser('go')).toEqual({})
  const A = r.registers()[0]!.sessionId
  const [C] = await childOf(r.session, await dispatchTask(r.session))
  return { A, C: C! }
}

describe('router · mapping and the index', () => {
  it('P2-05-01 headline through the router: one register, one end, the index', async () => {
    const memos: (JsonValue | undefined)[] = []
    const r = await hostR({
      wrapManager: (router) => ({
        ...router,
        runTask: async (params) => {
          const outcome = await router.runTask(params)
          const scope = (params.owner as Extract<RunTaskParams['owner'], { tool: unknown }>).tool
          memos.push(await scope.api.memo('agentId', scope.context))
          return outcome
        }
      })
    })
    const { A, C } = await headline(r)
    expect(r.registers()).toHaveLength(1)
    const [register] = r.registers()
    expect(register).toEqual({
      type: 'sub_session_register',
      sessionId: A,
      parentSessionId: 's1',
      parentToolCallId: CALL,
      subAgentName: 'explore',
      displayName: 'Explorer',
      description: 'look',
      systemPrompt: PROFILES.explore.systemPrompt,
      prompt: 'find X',
      depth: 1,
      rootSessionId: 's1'
    })
    expect('inlineTokens' in register!).toBe(false)
    expect('contextNote' in register!).toBe(false)
    expect(r.ends()).toEqual([
      { type: 'sub_session_end', sessionId: A, parentSessionId: 's1', result: 'found', isError: false }
    ])
    const record = await spawnedAgentRecordOf(r.session.harness, C as never, BG)
    expect(record?.agentId).toBe(A)
    expect(memos).toEqual([A])
    expect(r.router.locate(A)).toEqual({ sessionId: 's1', conversationId: C })
    expect(r.router.has(A)).toBe(true)
  })

  it('P2-05-02 register precedes the child run; no end before it answers', async () => {
    const r = await hostR()
    let snapshot: string[] | undefined
    r.t.kit.queue(callAgent('explore', 'find X'), async () => {
      snapshot = r.events.map((event) => event.type)
      return answer('found')
    }, answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    expect(snapshot).toEqual(['sub_session_register'])
  })

  it('P2-05-03 session routing: each dispatch goes to its own session coordinator', async () => {
    const r = await hostR()
    const s2 = await r.open('s2')
    const spies = [r.session, s2].map((session) => vi.spyOn(session.agents, 'spawn'))
    r.t.kit.queue(callAgent('explore', 'find 1'), answer('one'), answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    r.t.kit.queue(callAgent('explore', 'find 2'), answer('two'), answer('done'))
    expect(await s2.submitUser('go')).toEqual({})
    const sessions: DurableSession[] = [r.session, s2]
    for (const [index, spy] of spies.entries()) {
      expect(spy).toHaveBeenCalledTimes(1)
      const owner = spy.mock.calls[0]![0].owner.tool
      expect(owner.taskId).toBe(await dispatchTask(sessions[index]!))
      expect(owner.conversationId).toBe(1)
    }
    const [A1, A2] = r.registers().map((event) => event.sessionId)
    const [C1] = await childOf(r.session, await dispatchTask(r.session))
    const [C2] = await childOf(s2, await dispatchTask(s2))
    expect(r.router.locate(A1!)).toEqual({ sessionId: 's1', conversationId: C1 })
    expect(r.router.locate(A2!)).toEqual({ sessionId: 's2', conversationId: C2 })
    expect(r.task(A1!)?.sessionId).toBe('s1')
    expect(r.task(A2!)?.sessionId).toBe('s2')
  })

  it('P2-05-04 nested lineage: G hangs under C; everything stays in session s1', async () => {
    const inner: RunTaskParams[] = []
    const r = await hostR({
      wrapManager: (router): SubAgentManager => ({
        ...router,
        runTask: (params) => {
          inner.push(params)
          return router.runTask(params)
        }
      })
    })
    r.t.kit.queue(
      callAgent('nester', 'mid'),
      callAgent('explore', 'leaf', { id: 'call-g' }),
      answer('leaf done'),
      answer('mid done'),
      answer('done')
    )
    expect(await r.session.submitUser('go')).toEqual({})
    const [cReg, gReg] = r.registers()
    const A_C = cReg!.sessionId
    const A_G = gReg!.sessionId
    expect(cReg).toMatchObject({ parentSessionId: 's1', depth: 1, rootSessionId: 's1' })
    expect(gReg).toMatchObject({
      parentSessionId: A_C,
      rootSessionId: 's1',
      depth: 2,
      parentToolCallId: 'call-g'
    })
    const [C] = await childOf(r.session, await dispatchTask(r.session))
    const [G] = await childOf(r.session, await dispatchTask(r.session, 'call-g', C!))
    expect(r.router.locate(A_G)).toEqual({ sessionId: 's1', conversationId: G })
    expect(r.task(A_C)?.sessionId).toBe('s1')
    expect(r.task(A_G)?.sessionId).toBe('s1')
    expect(r.task(A_G)?.subject).toMatchObject({ kind: 'agent', depth: 2 })
    expect(inner.map((params) => params.sessionId)).toEqual(['s1', 's1'])
  })

  it('P2-05-05 the index outlives completion and LRU close; lookups never open the session', async () => {
    const r = await hostR()
    const { A, C } = await headline(r)
    await r.t.host.close('s1')
    expect(r.router.locate(A)).toEqual({ sessionId: 's1', conversationId: C })
    expect(r.router.has(A)).toBe(true)
    expect(r.t.host.get('s1')).toBeUndefined()
    expect(r.peeks).toEqual([])
  })

  it('P2-05-06 session not open for runTask: a text outcome, nothing registered, no peek (FC)', async () => {
    const fc = fakeSession()
    const kit = routerKit({ get: () => undefined, peek: async () => fc.session })
    const outcome = await kit.router.runTask(toolParams({ sessionId: 's9' }))
    const text = 'Session is not open: s9'
    expect(outcome).toEqual({ result: text, error: text })
    expect(kit.events).toEqual([])
    expect(kit.taskBroadcasts).toEqual([])
    expect(kit.router.has('sub-a1')).toBe(false)
    expect(kit.peeks).toEqual([])
    expect(fc.spawnCalls).toEqual([])
  })

  it('P2-05-07 non-tool owners reject with PhasePendingError(phase 2) until P2-08 (PIN-03)', async () => {
    const fc = fakeSession()
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    await kit.router.runTask(toolParams())
    const before = { events: kit.events.length, tasks: kit.taskBroadcasts.length }
    for (const owner of [{ anchor: true as const }, { task: 5 }]) {
      const error = await kit.router.runTask(toolParams({ owner })).catch((e: unknown) => e)
      expect(isPhasePendingError(error) && error.phase === 2).toBe(true)
    }
    expect(kit.events).toHaveLength(before.events)
    expect(kit.taskBroadcasts).toHaveLength(before.tasks)
    expect(fc.spawnCalls).toHaveLength(1)
    expect(await kit.router.getRuntimeInfo('sub-a1')).toBeNull()
    expect(await kit.router.getRuntimeInfo('sub-x')).toBeNull()
  })

  it('P2-05-07 a tool owner is still the default path (control): one spawn call with the scope api', async () => {
    const fc = fakeSession()
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    const params = toolParams()
    await kit.router.runTask(params)
    const scope = (params.owner as Extract<RunTaskParams['owner'], { tool: unknown }>).tool
    expect(fc.spawnCalls[0]!.owner.tool).toBe(scope.api)
  })
})
