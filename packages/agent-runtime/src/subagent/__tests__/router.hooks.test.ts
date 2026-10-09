/**
 * 派生 agent 路由 · hook 调用方（P2-05-53，P2-08 翻转）：hook runner 经真路由派发 —— 观察型交 `{anchor: true}`，
 * 判定型带了 ownerTaskId 交 `{task}`、没带交锚；路由把它们原样交给协调器（`{anchor}` / `{task}` 拥有者），带上
 * 宿主派发的参数（基准模型 = modelConfig 译成 LockModel、hook 名、requestId `hook:<runId>`），登记 / 广播与
 * 工具派发同一套，只是 register 里没有 `parentToolCallId`。
 *
 * TITLE-2：hook 派发拿 hook 的显示名当描述，面板行读作 `<agent 显示名> · <hook 显示名>`；两者相同只写一次。
 * RT-2：hook agent 的行被清掉之后追问重建，subject 照样没有 `parentToolCallId`（没有派发卡，也不凭空长出一个）。
 */
import { describe, expect, it } from 'vitest'
import {
  entryOf,
  fileOf,
  makeRunner,
  MODEL,
  permissionPayload,
  promptPayload,
  verdict
} from '../../hook/__tests__/harness'
import { createdInfo, fakeSession, hostR, routerKit } from '../../durable/__tests__/support/router'
import { answer } from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import { PROFILES } from '../../durable/__tests__/support/spawn'

registerHostCleanup()

function realRouter(script: Parameters<typeof fakeSession>[0] = {}): ReturnType<
  typeof routerKit
> & {
  fc: ReturnType<typeof fakeSession>
} {
  const fc = fakeSession(script)
  const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
  return { ...kit, fc }
}

describe('router · hook callers (P2-08)', () => {
  it('P2-05-53 an observe hook: anchor owner → the coordinator gets {anchor} + hosted params; ok:true; register has no parentToolCallId', async () => {
    const kit = realRouter()
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      runTask: (params) => kit.router.runTask(params)
    })
    h.runner.fire('session.prompt-accepted', promptPayload())
    await h.waitEnd()
    expect(h.call().owner).toEqual({ anchor: true })
    expect(h.ends()).toEqual([expect.objectContaining({ ok: true })])
    const runId = h.starts()[0]!.run.runId
    expect(kit.fc.spawnCalls).toHaveLength(1)
    const call = kit.fc.spawnCalls[0]!
    expect(call.owner).toEqual({ anchor: true })
    expect(call.hosted).toEqual({
      model: { provider: MODEL.provider, modelId: MODEL.model },
      hook: 'hk',
      requestId: `hook:${runId}`
    })
    const [register] = kit.registers()
    expect(register).toMatchObject({ sessionId: 'sub-a1', parentSessionId: 's1' })
    expect('parentToolCallId' in register!).toBe(false)
    expect(kit.ends()).toEqual([expect.objectContaining({ sessionId: 'sub-a1', isError: false })])
  })

  it('P2-05-53 a decide hook with ownerTaskId → {task}; the captured verdict comes back', async () => {
    const V = verdict('allow')
    const kit = realRouter({
      spawn: async (params) => {
        const info = createdInfo()
        params.onCreated?.(info)
        return {
          result: JSON.stringify(V),
          structured: V,
          conversationId: info.conversationId,
          agentId: info.agentId
        }
      }
    })
    const h = makeRunner({
      entries: [entryOf(fileOf({ bindings: [{ trigger: 'permission.request' }] }))],
      runTask: (params) => kit.router.runTask(params)
    })
    expect(
      await h.runner.decide('permission.request', permissionPayload(), { ownerTaskId: 9 })
    ).toEqual({ result: V, hook: 'hk' })
    expect(h.call().owner).toEqual({ task: 9 })
    expect(kit.fc.spawnCalls[0]!.owner).toEqual({ task: 9 })
    expect(kit.fc.spawnCalls[0]!.resultContract?.sourceLabel).toBe('hk')
  })

  it('P2-05-53 a decide hook without ownerTaskId → {anchor}', async () => {
    const kit = realRouter()
    const h = makeRunner({
      entries: [entryOf(fileOf({ bindings: [{ trigger: 'permission.request' }] }))],
      runTask: (params) => kit.router.runTask(params)
    })
    // 会话桩只答 'found'（没有结构化结果）：没有意见
    expect(await h.runner.decide('permission.request', permissionPayload())).toBeNull()
    expect(h.call().owner).toEqual({ anchor: true })
    expect(kit.fc.spawnCalls[0]!.owner).toEqual({ anchor: true })
    expect(h.ends()).toEqual([expect.objectContaining({ ok: false, error: 'no valid result' })])
  })
})

describe('router · hook-dispatched row titles', () => {
  it.each([
    ['Explorer', 'Explorer'],
    ['Automatic Session Titles', 'Explorer · Automatic Session Titles']
  ])(
    'TITLE-2 a hook run described as %j → row title %j; the subject has no parentToolCallId',
    async (description, title) => {
      const r = await hostR()
      r.t.kit.queue(answer('titled'))
      const outcome = await r.router.runTask({
        sessionId: 's1',
        owner: { anchor: true },
        agentType: PROFILES.explore,
        prompt: 'title it',
        description,
        hook: { name: 'auto-title', runId: 'r1' }
      })
      expect(outcome.result).toBe('titled')
      const H = r.registers()[0]!.sessionId
      const task = r.task(H)!
      // 哪个 agent、由哪个 hook 派的；hook 显示名与 agent 显示名相同就不重复
      expect(task.title).toBe(title)
      expect(task.subject).toMatchObject({ kind: 'agent', profileName: 'explore', depth: 1 })
      // 宿主派发：没有那张派发卡可挂
      expect('parentToolCallId' in task.subject).toBe(false)
    }
  )

  it('RT-2 a hook row dismissed, then a follow-up: the recreated subject still has no parentToolCallId', async () => {
    const r = await hostR()
    r.t.kit.queue(answer('titled'))
    const outcome = await r.router.runTask({
      sessionId: 's1',
      owner: { anchor: true },
      agentType: PROFILES.explore,
      prompt: 'title it',
      description: 'title',
      hook: { name: 'auto-title', runId: 'r1' }
    })
    expect(outcome.result).toBe('titled')
    const H = r.registers()[0]!.sessionId

    // 面板上清掉这条，再追问：任务条目从索引条目重建
    expect(r.tasks!.dismiss(H)).toBe(true)
    expect(r.task(H)).toBeUndefined()
    r.t.kit.queue(answer('more'))
    await r.router.continueTask({ subSessionId: H, text: 'more' })
    const task = r.task(H)!
    expect(task.subject).toEqual({ kind: 'agent', profileName: 'explore', depth: 1 })
    expect('parentToolCallId' in task.subject).toBe(false)
    expect(task.status).toBe('done')
  })
})
