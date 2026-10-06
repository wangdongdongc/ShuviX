/**
 * 派生 agent 路由 · 运行时快照（P3-06-32）：`getRuntimeInfo(agentId)` 按索引找到会话与子对话，读会话的
 * `agentInfo`。不认识 / 会话关着 / 已销毁 → null；从不打开会话（也不 peek）。
 */
import { describe, expect, it } from 'vitest'
import type { DurableSession } from '../../durable/durableSession'
import { answer } from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import {
  fakeAgentInfo,
  fakeSession,
  hostR,
  routerKit,
  toolParams
} from '../../durable/__tests__/support/router'
import { callAgent, childOf, dispatchTask } from '../../durable/__tests__/support/spawn'

registerHostCleanup()

describe('router · getRuntimeInfo (P3-06-32)', () => {
  it('P3-06-32 a known agentId on an open session reads agentInfo of its child conversation; unknown → null', async () => {
    const fc = fakeSession()
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    await kit.router.runTask(toolParams())
    expect(await kit.router.getRuntimeInfo('sub-a1')).toEqual(fakeAgentInfo(2))
    expect(fc.infoCalls).toEqual([2])
    expect(await kit.router.getRuntimeInfo('sub-x')).toBeNull()
    expect(fc.infoCalls).toEqual([2])
    expect(kit.peeks).toEqual([])
  })

  it('P3-06-32 a closed session (not in the host, or a closed handle) → null; never peeks', async () => {
    const fc = fakeSession()
    let open: DurableSession | undefined = fc.session
    const kit = routerKit({ get: () => open, peek: async () => fc.session })
    await kit.router.runTask(toolParams())
    open = undefined
    expect(await kit.router.getRuntimeInfo('sub-a1')).toBeNull()
    open = { ...fc.session, closed: true } as DurableSession
    expect(await kit.router.getRuntimeInfo('sub-a1')).toBeNull()
    expect(fc.infoCalls).toEqual([])
    expect(kit.peeks).toEqual([])
  })

  it('P3-06-32 after destroy(agentId) → null (the index entry is gone; PIN-06)', async () => {
    const fc = fakeSession()
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    await kit.router.runTask(toolParams())
    await kit.router.destroy('sub-a1')
    expect(await kit.router.getRuntimeInfo('sub-a1')).toBeNull()
    expect(fc.infoCalls).toEqual([])
  })

  it('P3-06-32 through the real host: equals session.agentInfo(child); LRU-closed → null without opening; destroyed → null', async () => {
    const r = await hostR()
    r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    const A = r.registers()[0]!.sessionId
    const [C] = await childOf(r.session, await dispatchTask(r.session))
    const info = await r.router.getRuntimeInfo(A)
    expect(info).toEqual(await r.session.agentInfo(C!))
    expect(info!.systemPrompt).toBe('You are M1 explorer')
    expect(info!.isStreaming).toBe(false)

    await r.t.host.close('s1')
    expect(await r.router.getRuntimeInfo(A)).toBeNull()
    expect(r.peeks).toEqual([])
    expect(r.t.host.get('s1')).toBeUndefined()

    const session = await r.t.open('s1')
    expect(await r.router.getRuntimeInfo(A)).toEqual(await session.agentInfo(C!))
    await r.router.destroy(A)
    expect(await r.router.getRuntimeInfo(A)).toBeNull()
  })
})
