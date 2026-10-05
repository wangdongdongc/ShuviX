/**
 * 派生 agent 路由 · hook 调用方（P2-05-53，PIN-03）：hook runner 经真路由派发时传 `{anchor: true}`，路由在 P2-08
 * 接上宿主派发之前以 PhasePendingError 拒绝 —— 观察型 run 以 ok:false 收尾（错误原话），判定型没有意见（null）；
 * 一个事件、一条任务都不留。
 */
import { describe, expect, it } from 'vitest'
import {
  entryOf,
  fileOf,
  makeRunner,
  permissionPayload,
  promptPayload
} from '../../hook/__tests__/harness'
import { fakeSession, routerKit } from '../../durable/__tests__/support/router'

const PENDING = 'host-dispatched agents is not available yet (pi-durable migration, phase 2)'

function realRouter(): ReturnType<typeof routerKit> & { spawns: () => number } {
  const fc = fakeSession()
  const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
  return { ...kit, spawns: () => fc.spawnCalls.length }
}

describe('router · hook callers until P2-08', () => {
  it('P2-05-53 an observe hook: anchor owner → ok:false with the PhasePendingError text; nothing registered', async () => {
    const kit = realRouter()
    const h = makeRunner({
      entries: [entryOf(fileOf())],
      runTask: (params) => kit.router.runTask(params)
    })
    h.runner.fire('session.prompt-accepted', promptPayload())
    await h.waitEnd()
    expect(h.call().owner).toEqual({ anchor: true })
    expect(h.ends()).toEqual([expect.objectContaining({ ok: false, error: PENDING })])
    expect(kit.events).toEqual([])
    expect(kit.taskBroadcasts).toEqual([])
    expect(kit.spawns()).toBe(0)
  })

  it('P2-05-53 a decide hook: the same rejection → no opinion (null)', async () => {
    const kit = realRouter()
    const h = makeRunner({
      entries: [entryOf(fileOf({ bindings: [{ trigger: 'permission.request' }] }))],
      runTask: (params) => kit.router.runTask(params)
    })
    expect(await h.runner.decide('permission.request', permissionPayload())).toBeNull()
    expect(h.call().owner).toEqual({ anchor: true })
    expect(h.ends()).toEqual([expect.objectContaining({ ok: false, error: PENDING })])
    expect(kit.events).toEqual([])
    expect(kit.spawns()).toBe(0)
  })
})
