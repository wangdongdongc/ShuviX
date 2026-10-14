/**
 * syncClient（pi 1.2 / chord2）—— 真的客户端对着 `fakeServer`（一个真的 chord 服务端，值由测试摆布），中间是
 * 进程内的链路渠道（`linkChannel`：帧 JSON 往返、微任务送达；能断传输、能结束 / 拒绝链路、能扣帧、能让 send
 * 抛错，客户端发出的每一帧都记在 `sent`）。涉及退避时长的用例用假定时器。
 *
 * 状态映射
 *  - SC-1  loading → 先一个 live 状态、再恰好一个 hydrate（= 服务端的值）→ 之后的变化按序是 update
 *  - SC-2  withdraw → unavailable、值清空、不抛；replace（又可用了）→ live + 一个 hydrate
 *  - SC-3  订阅失败：not_found / forbidden / 没码的错误（→ unavailable 码）；只持有一次、不重试；还持有着时再 acquire
 *          共用出错的绑定；全放掉之后再 acquire → 新的持有，能成功
 *  - SC-4  活过之后服务端关停（gone）→ unavailable，不是 error；值清空
 *  - SC-5  reset(holdId) → 值整份换掉、没有新持有、之后的增量照样对
 *  - SC-6  replace → 新值，没有新持有，中间不经过 loading / unavailable
 *  - SC-7  两个目标交替改同一路径 → 各自等于自己的服务端值
 *  - SC-8  每次（重新）订阅恰好一个 hydrate，不管视图与可用性谁先到
 *  - SC-9  抛错的监听器 → 一条警告，别的监听器照常；同一个函数订两次 → 两份，各自的退订只摘一份
 *  - SC-10 每个事件之后：`value()` 有值当且仅当状态是 live
 * 共享
 *  - SC-20 两次 acquire → 一个持有；第一次 release → false、没有 release 帧；第二次 → true、一个 release；放掉的
 *          订阅的监听器不再被调；release 幂等
 *  - SC-21 同一个 tick 里 A→B→A → 最终是 A 的值；B 从没交过值；服务端不为 B 留任何持有
 *  - SC-22 改动传给 acquire 的目标对象不影响 `sub.target`
 * 链路
 *  - SC-30 链路 id = `<idPrefix>.<n>`、逐条递增；同一条渠道上两个不同前缀的客户端只吃自己链路的帧
 *  - SC-31 最后一个放手 → 一个宏任务之后链路带 bye 关掉、服务端链路与活着的帧监听器归零；同一宏任务里再 acquire
 *          复用链路（没有新 hello）；空闲关掉之后再 acquire → 新 id、新 hello
 *  - SC-32 旧链路 id 上塞进来的帧（空闲关掉 / resetAll 之后）被忽略：没有事件、没有警告
 *  - SC-33 （假定时器）服务端结束链路（带 / 不带 bye）而绑定还在：当场 loading、值清空、换一条新链路；250ms 之前
 *          什么都不发，之后 hello 与持有；断线期间服务端改了值 → 下一个值 = 服务端此刻的值，断线前的值不再交
 *  - SC-34 （假定时器）新链路一帧都收不到的连续失败 → 250, 500, 1000, 2000, 4000, 5000, 5000；某条链路收到第一帧 →
 *          回到 250
 *  - SC-35 （假定时器）每条新链路都被 bye 拒掉（refuseAllLinks）→ 退避照样增长（bye 不算应答）
 *  - SC-36 （假定时器）传输断开 → 链路结束、loading；新链路断着时攒着帧（退避到了也不发）；恢复 → 先 hello，
 *          再 live + 一份新快照
 *  - SC-37 没有任何绑定时链路关了 → 不重连；下一次 acquire 立刻开链路（不退避）
 *  - SC-38 resetAll → 旧链路发 bye（服务端放掉它的持有）、新链路 id；每个绑定 loading 再 live；退避复位；没有链路时
 *          resetAll 什么帧都不发
 *  - SC-39 dispose → 放掉绑定、链路带 bye 关掉、之后 acquire 抛错、resetAll 什么都不做、定时器一个不剩
 *  - SC-40 渠道的 send 抛错 → 'transport error' → 重连（直接发的帧、退避之后攒着一起发的帧、空闲窗口里新 acquire
 *          的第一个 hold 三条路）
 *  - SC-41 syncClientFor：同一条渠道 → 同一个客户端；选项只在第一次生效；另一条渠道 → 另一个客户端
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import {
  emptySessionView,
  type AgentView,
  type SessionView
} from '@shuvix/chat-protocol/types/sessionView'
import {
  createSyncClient,
  syncClientFor,
  type SyncClient,
  type SyncClientOptions,
  type ViewEvent,
  type ViewSubscription
} from '../syncClient'
import {
  fakeServer,
  linkChannel,
  microtasks,
  type FakeServer,
  type WireFrame
} from './support/fakeServer'

const S1: SyncTarget = { kind: 'session', sessionId: 's1' }
const S2: SyncTarget = { kind: 'session', sessionId: 's2' }
const A1: SyncTarget = { kind: 'agent', agentId: 'a1' }

function sessionView(sessionId: string, patch: Partial<SessionView> = {}): SessionView {
  return { ...emptySessionView(sessionId), source: 'durable', conversationId: 1, ...patch }
}

function agentView(agentId: string, patch: Partial<AgentView> = {}): AgentView {
  return {
    v: 1,
    agentId,
    sessionId: 's1',
    conversationId: 2,
    messages: [],
    live: null,
    toolRuns: {},
    run: { state: 'idle' },
    context: { usedTokens: null },
    ...patch
  }
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await tick()
  }
  throw new Error(`timeout: ${what}`)
}

interface Warning {
  readonly message: string
  readonly at: number
}

interface Rig {
  readonly server: FakeServer
  readonly client: SyncClient
  readonly warnings: Warning[]
}

const disposers: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

/** 一个服务端 + 一个客户端（前缀 `t`）；警告带着时刻记下 */
function rig(options: Partial<SyncClientOptions> = {}, server = fakeServer()): Rig {
  const warnings: Warning[] = []
  const client = createSyncClient({
    channel: server.channel,
    idPrefix: 't',
    logger: { warn: (message) => warnings.push({ message, at: Date.now() }) },
    ...options
  })
  disposers.push(() => client.dispose())
  return { server, client, warnings }
}

function record<V>(sub: ViewSubscription<V>): ViewEvent<V>[] {
  const events: ViewEvent<V>[] = []
  sub.subscribe((event) => events.push(event))
  return events
}

const valuesOf = <V>(events: ViewEvent<V>[]): { value: V; delivery: string }[] =>
  events.flatMap((e) => (e.kind === 'value' ? [{ value: e.value, delivery: e.delivery }] : []))

const statusesOf = <V>(events: ViewEvent<V>[]): string[] =>
  events.flatMap((e) => (e.kind === 'status' ? [e.state.status] : []))

const LIVE_EVENT = { kind: 'status', state: { status: 'live' } }
const LOADING_EVENT = { kind: 'status', state: { status: 'loading' } }

/** 某条链路上客户端发出的帧 */
const framesOn = (server: FakeServer, linkId: string): WireFrame[] =>
  server.sent.filter(([id]) => id === linkId).map(([, frame]) => frame)

/** 客户端发出 hello 的链路，按先后 */
const hellos = (server: FakeServer): string[] =>
  server.sent.filter(([, frame]) => frame.t === 'hello').map(([id]) => id)

/** 某条链路上的 hello 是什么时刻发出的（没有 → undefined） */
const helloAt = (server: FakeServer, linkId: string): number | undefined =>
  server.sent.find(([id, frame]) => id === linkId && frame.t === 'hello')?.[2]

/** 某条链路上某个成员（`view` / `availability`）的订阅 id（客户端的 `sub` 帧） */
const subIds = (server: FakeServer, linkId: string, member: string): unknown[] =>
  framesOn(server, linkId)
    .filter((frame) => frame.t === 'sub' && frame.member === member)
    .map((frame) => frame.id)

const holdsSent = (server: FakeServer): number =>
  server.calls.filter((call) => call.startsWith('subscribe:')).length

// ═══ 状态映射 ═══════════════════════════════════════════

describe('syncClient: status mapping', () => {
  it('SC-1 loading → a live status, then exactly one hydrate equal to the server value → later changes as updates in order', async () => {
    const { server, client } = rig()
    server.serve(S1, sessionView('s1'))
    const sub = client.acquire<SessionView>(S1)
    expect(sub.state()).toEqual({ status: 'loading' })
    expect(sub.value()).toBeUndefined()
    const events = record(sub)

    await until(() => sub.state().status === 'live', 'live')
    await server.settle()
    expect(events).toEqual([
      LIVE_EVENT,
      { kind: 'value', value: server.value(S1), delivery: 'hydrate' }
    ])
    expect(sub.value()).toEqual(server.value(S1))

    const expected: SessionView[] = []
    server.change(S1, (draft) => {
      draft.run = { state: 'busy' }
    })
    expected.push(json(server.value(S1) as SessionView))
    await server.settle()
    server.change(S1, (draft) => {
      draft.context.usedTokens = 42
    })
    expected.push(json(server.value(S1) as SessionView))
    await server.settle()
    server.change(S1, (draft) => {
      draft.run = { state: 'idle' }
    })
    expected.push(json(server.value(S1) as SessionView))
    await server.settle()

    expect(events.slice(2)).toEqual(
      expected.map((value) => ({ kind: 'value', value, delivery: 'update' }))
    )
    expect(sub.value()).toEqual(server.value(S1))
    expect(sub.state()).toEqual({ status: 'live' })
  })

  it('SC-2 withdraw → unavailable, value cleared, nothing thrown; replace → live plus one hydrate', async () => {
    const { server, client, warnings } = rig()
    server.serve(S1, sessionView('s1', { run: { state: 'busy' } }))
    const sub = client.acquire<SessionView>(S1)
    await until(() => sub.state().status === 'live', 'live')
    const events = record(sub)

    expect(() => server.withdraw(S1)).not.toThrow()
    await server.settle()
    expect(sub.state()).toEqual({ status: 'unavailable' })
    expect(sub.value()).toBeUndefined()
    expect(events).toEqual([{ kind: 'status', state: { status: 'unavailable' } }])

    events.length = 0
    const next = sessionView('s1', { conversationId: 7 })
    server.replace(S1, next)
    await server.settle()
    expect(events).toEqual([LIVE_EVENT, { kind: 'value', value: next, delivery: 'hydrate' }])
    expect(sub.value()).toEqual(next)
    expect(warnings).toEqual([])
  })

  it('SC-3 a failed subscription → error with the code, held once, never retried; shared while held; a new hold after full release', async () => {
    const cases: [string | undefined, string, SyncTarget][] = [
      ['not_found', 'not_found', S1],
      ['forbidden', 'forbidden', S2],
      [undefined, 'unavailable', A1]
    ]
    const { server, client } = rig()
    server.serve(S1, sessionView('s1'))
    server.serve(S2, sessionView('s2'))
    server.serve(A1, agentView('a1'))

    for (const [failWith, code, target] of cases) {
      const before = holdsSent(server)
      server.failSubscribe(failWith)
      const sub = client.acquire(target)
      const events = record(sub)
      await until(() => sub.state().status === 'error', `error for ${failWith ?? 'no code'}`)
      expect(sub.state()).toEqual({ status: 'error', code })
      expect(sub.value()).toBeUndefined()
      expect(events).toEqual([{ kind: 'status', state: { status: 'error', code } }])

      // 不重试：再等一阵，服务端只见过这一次持有
      await server.settle()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(holdsSent(server)).toBe(before + 1)

      // 还持有着时再 acquire：共用出错的绑定，不新持有
      const again = client.acquire(target)
      expect(again.state()).toEqual({ status: 'error', code })
      await server.settle()
      expect(holdsSent(server)).toBe(before + 1)

      // 全放掉之后再 acquire：新的持有，能成功
      expect(sub.release()).toBe(false)
      expect(again.release()).toBe(true)
      const fresh = client.acquire(target)
      expect(fresh.state()).toEqual({ status: 'loading' })
      await until(() => fresh.state().status === 'live', 'live after re-acquire')
      expect(fresh.value()).toEqual(server.value(target))
      expect(holdsSent(server)).toBe(before + 2)
      fresh.release()
    }
  })

  it('SC-4 gone after live (server closed) → unavailable, not error; value cleared', async () => {
    const { server, client } = rig({ reconnectDelayMs: 1 })
    server.serve(S1, sessionView('s1'))
    const sub = client.acquire<SessionView>(S1)
    await until(() => sub.state().status === 'live', 'live')
    const events = record(sub)

    await server.close()
    await until(() => sub.state().status !== 'live', 'not live')
    expect(sub.state()).toEqual({ status: 'unavailable' })
    expect(sub.value()).toBeUndefined()

    // 链路随后也关了、客户端换了新链路：句柄已经 gone，不会再被持有回来
    await new Promise((resolve) => setTimeout(resolve, 20))
    await server.settle()
    expect(sub.state()).toEqual({ status: 'unavailable' })
    expect(sub.value()).toBeUndefined()
    expect(events).toEqual([{ kind: 'status', state: { status: 'unavailable' } }])
  })

  it('SC-5 reset(holdId) → value replaced, no new hold, later updates correct', async () => {
    const { server, client } = rig()
    server.serve(S1, sessionView('s1', { run: { state: 'busy' } }))
    const sub = client.acquire<SessionView>(S1)
    await until(() => sub.state().status === 'live', 'live')
    await server.settle()
    const events = record(sub)
    const before = sub.value()
    const callsBefore = [...server.calls]
    const [holdId] = server.subscriptions(S1)

    server.reset(holdId)
    await server.settle()
    expect(valuesOf(events)).toEqual([{ value: server.value(S1), delivery: 'hydrate' }])
    expect(statusesOf(events)).toEqual([])
    expect(sub.value()).toEqual(server.value(S1))
    expect(sub.value()).not.toBe(before)
    expect(server.calls).toEqual(callsBefore)

    server.change(S1, (draft) => {
      draft.run = { state: 'interrupted' }
    })
    await server.settle()
    expect(valuesOf(events).at(-1)).toEqual({ value: server.value(S1), delivery: 'update' })
    expect(sub.value()).toEqual(server.value(S1))
    expect(server.calls).toEqual(callsBefore)
  })

  it('SC-6 replace → the new value, no new hold, never loading or unavailable in between', async () => {
    const { server, client } = rig()
    server.serve(S1, sessionView('s1'))
    const sub = client.acquire<SessionView>(S1)
    await until(() => sub.state().status === 'live', 'live')
    await server.settle()
    const events = record(sub)
    const callsBefore = [...server.calls]

    const next = sessionView('s1', { conversationId: 9, run: { state: 'busy' } })
    server.replace(S1, next)
    await server.settle()
    expect(statusesOf(events)).toEqual([])
    expect(valuesOf(events).length).toBeGreaterThan(0)
    expect(sub.value()).toEqual(next)
    expect(sub.state()).toEqual({ status: 'live' })
    expect(server.calls).toEqual(callsBefore)
  })

  it('SC-7 two targets changing the same path in alternation → each equals its own server value', async () => {
    const { server, client } = rig()
    server.serve(S1, sessionView('s1'))
    server.serve(S2, sessionView('s2'))
    server.serve(A1, agentView('a1'))
    const subs = [S1, S2, A1].map((target) => ({ target, sub: client.acquire(target) }))
    await until(() => subs.every(({ sub }) => sub.state().status === 'live'), 'all live')

    const states = ['busy', 'idle', 'interrupted'] as const
    for (let i = 0; i < 9; i++) {
      const { target } = subs[i % subs.length]
      server.change(target, (draft) => {
        draft.run = { state: states[i % states.length] }
        draft.context.usedTokens = i
      })
      await server.settle()
      for (const { target: t, sub } of subs) expect(sub.value()).toEqual(server.value(t))
    }

    // 同一个 tick 里交替改
    for (let i = 0; i < 6; i++) {
      server.change(subs[i % 2].target, (draft) => {
        draft.context.usedTokens = 100 + i
      })
    }
    await server.settle()
    for (const { target, sub } of subs) expect(sub.value()).toEqual(server.value(target))
    expect((subs[0].sub.value() as SessionView).context.usedTokens).toBe(104)
    expect((subs[1].sub.value() as SessionView).context.usedTokens).toBe(105)
  })

  it('SC-8 exactly one hydrate per (re)subscription, whichever of view and availability arrives first', async () => {
    const { server, client } = rig({ reconnectDelayMs: 1 })
    server.serve(S1, sessionView('s1'))
    server.serve(S2, sessionView('s2'))
    const stateOf = (member: string) => (linkId: string, frame: WireFrame) =>
      frame.t === 'state' && subIds(server, linkId, member).includes(frame.id)

    // 首次订阅，可用性先到（视图扣下）/ 视图先到（可用性扣下）
    for (const [target, held] of [
      [S1, 'view'],
      [S2, 'availability']
    ] as const) {
      server.delayDown(stateOf(held))
      const sub = client.acquire<SessionView>(target)
      const events = record(sub)
      await server.settle()
      expect(sub.state()).toEqual({ status: 'loading' })
      expect(events).toEqual([])
      server.delayDown(undefined)
      server.releaseDown()
      await until(() => sub.state().status === 'live', `live (${held} held back)`)
      await server.settle()
      expect(events).toEqual([
        LIVE_EVENT,
        { kind: 'value', value: server.value(target), delivery: 'hydrate' }
      ])
    }

    // 重新订阅（链路被服务端关掉、新链路上重新持有）：两种先后各来一次
    const sub = client.acquire<SessionView>(S1)
    const events = record(sub)
    for (const [round, held] of [
      [2, 'view'],
      [3, 'availability']
    ] as const) {
      events.length = 0
      server.delayDown(stateOf(held))
      server.endServerLink(`t.${round - 1}`, { bye: true })
      await until(() => framesOn(server, `t.${round}`).length > 0, `link t.${round}`)
      await server.settle()
      expect(sub.state()).toEqual({ status: 'loading' })
      expect(events).toEqual([LOADING_EVENT])
      server.delayDown(undefined)
      server.releaseDown()
      await until(() => sub.state().status === 'live', `live again (${held} held back)`)
      await server.settle()
      expect(events).toEqual([
        LOADING_EVENT,
        LIVE_EVENT,
        { kind: 'value', value: server.value(S1), delivery: 'hydrate' }
      ])
    }
  })

  it('SC-9 a throwing listener → a warning, other listeners still called; the same function twice → two deliveries, each unsubscribe removes one', async () => {
    const { server, client, warnings } = rig()
    server.serve(S1, sessionView('s1'))
    const sub = client.acquire<SessionView>(S1)
    sub.subscribe(() => {
      throw new Error('boom')
    })
    const seen: string[] = []
    sub.subscribe((event) => seen.push(event.kind))
    await until(() => sub.state().status === 'live', 'live')
    await server.settle()
    expect(seen).toEqual(['status', 'value'])
    expect(warnings.map((w) => w.message)).toEqual([
      '[sync] view listener failed for session:s1: boom',
      '[sync] view listener failed for session:s1: boom'
    ])

    const twice = vi.fn()
    const first = sub.subscribe(twice)
    const second = sub.subscribe(twice)
    const bump = async (tokens: number): Promise<void> => {
      server.change(S1, (draft) => {
        draft.context.usedTokens = tokens
      })
      await server.settle()
    }
    await bump(1)
    expect(twice).toHaveBeenCalledTimes(2)
    first()
    first()
    await bump(2)
    expect(twice).toHaveBeenCalledTimes(3)
    second()
    await bump(3)
    expect(twice).toHaveBeenCalledTimes(3)
    // 抛错的那个一直在抛，别的监听器一直收得到
    expect(seen.filter((kind) => kind === 'value')).toHaveLength(4)
  })

  it('SC-10 after every event, value() is defined exactly while the status is live', async () => {
    const { server, client } = rig({ reconnectDelayMs: 1 })
    server.serve(S1, sessionView('s1'))
    server.serve(S2, sessionView('s2'))
    const violations: string[] = []
    const seen = new Set<string>()
    const watch = (sub: ViewSubscription<SessionView>, name: string): void => {
      const check = (when: string): void => {
        const live = sub.state().status === 'live'
        seen.add(sub.state().status)
        if (live !== (sub.value() !== undefined)) {
          violations.push(
            `${name} ${when}: status ${sub.state().status}, value ${String(sub.value())}`
          )
        }
      }
      check('at acquire')
      sub.subscribe((event) => check(event.kind === 'value' ? event.delivery : event.state.status))
    }

    const sub = client.acquire<SessionView>(S1)
    watch(sub, 's1')
    await until(() => sub.state().status === 'live', 'live')
    // 另一个目标订阅失败（error）
    server.failSubscribe('forbidden')
    const failed = client.acquire<SessionView>(S2)
    watch(failed, 's2')
    await until(() => failed.state().status === 'error', 'error')

    server.change(S1, (draft) => {
      draft.run = { state: 'busy' }
    })
    await server.settle()
    server.withdraw(S1)
    await until(() => sub.state().status === 'unavailable', 'unavailable')
    server.replace(S1, sessionView('s1', { conversationId: 3 }))
    await until(() => sub.state().status === 'live', 'live after replace')
    server.endServerLink('t.1', { bye: true })
    await until(() => sub.state().status === 'loading', 'loading after link end')
    await until(() => sub.state().status === 'live', 'live after reconnect')
    server.setUp(false)
    await until(() => sub.state().status === 'loading', 'loading while down')
    server.setUp(true)
    await until(() => sub.state().status === 'live', 'live after up')
    await server.close()
    await until(() => sub.state().status === 'unavailable', 'unavailable after close')

    expect(violations).toEqual([])
    expect([...seen].sort()).toEqual(['error', 'live', 'loading', 'unavailable'])
  })
})

// ═══ 共享 ═══════════════════════════════════════════════

describe('syncClient: sharing', () => {
  it('SC-20 two acquires share one hold; only the last release releases (once); released listeners are never called again; release is idempotent', async () => {
    const { server, client } = rig()
    server.serve(S1, sessionView('s1'))
    const first = client.acquire<SessionView>(S1)
    const second = client.acquire<SessionView>(S1)
    const firstEvents = record(first)
    const secondEvents = record(second)
    await until(() => first.state().status === 'live', 'live')
    await server.settle()
    expect(holdsSent(server)).toBe(1)
    expect(second.state()).toEqual({ status: 'live' })
    expect(second.value()).toEqual(server.value(S1))

    const releases = (): WireFrame[] =>
      framesOn(server, 't.1').filter((frame) => frame.t === 'release')
    expect(first.release()).toBe(false)
    expect(first.release()).toBe(false)
    await server.settle()
    expect(releases()).toEqual([])
    expect(server.calls.filter((call) => call.startsWith('unsubscribe:'))).toEqual([])

    const firstCount = firstEvents.length
    server.change(S1, (draft) => {
      draft.run = { state: 'busy' }
    })
    await server.settle()
    expect(firstEvents).toHaveLength(firstCount)
    expect(valuesOf(secondEvents).at(-1)).toEqual({ value: server.value(S1), delivery: 'update' })

    expect(second.release()).toBe(true)
    expect(second.release()).toBe(false)
    expect(releases()).toHaveLength(1)
    const secondCount = secondEvents.length
    await server.settle()
    expect(server.calls.filter((call) => call.startsWith('unsubscribe:'))).toHaveLength(1)
    expect(server.subscriptions(S1)).toEqual([])
    expect(firstEvents).toHaveLength(firstCount)
    expect(secondEvents).toHaveLength(secondCount)
    expect(first.release()).toBe(false)
  })

  it('SC-21 A→B→A within one tick → the final value is A’s; B never emitted a value; the server holds nothing for B', async () => {
    const { server, client } = rig()
    server.serve(S1, sessionView('s1', { conversationId: 1 }))
    server.serve(S2, sessionView('s2', { conversationId: 2 }))
    const a = client.acquire<SessionView>(S1)
    await until(() => a.state().status === 'live', 'A live')

    // 同一个 tick：放 A、拿 B、放 B、再拿 A（切会话时 React 先清理旧 effect、再跑新的）
    a.release()
    const b = client.acquire<SessionView>(S2)
    const bEvents = record(b)
    b.release()
    const again = client.acquire<SessionView>(S1)
    const events = record(again)

    await until(() => again.state().status === 'live', 'A live again')
    await server.settle()
    expect(again.value()).toEqual(server.value(S1))
    expect(valuesOf(events)).toEqual([{ value: server.value(S1), delivery: 'hydrate' }])
    expect(valuesOf(bEvents)).toEqual([])
    expect(b.value()).toBeUndefined()
    expect(server.subscriptions(S2)).toEqual([])
    expect(server.subscriptions(S1)).toHaveLength(1)
    // 一直是同一条链路
    expect(hellos(server)).toEqual(['t.1'])
    expect(server.links()).toEqual(['t.1'])
  })

  it('SC-22 mutating the target passed to acquire does not change sub.target', async () => {
    const { server, client } = rig()
    server.serve(S1, sessionView('s1'))
    const target = { kind: 'session', sessionId: 's1' } as { kind: 'session'; sessionId: string }
    const sub = client.acquire<SessionView>(target)
    target.sessionId = 'other'
    expect(sub.target).toEqual({ kind: 'session', sessionId: 's1' })
    expect(sub.target).not.toBe(target)
    await until(() => sub.state().status === 'live', 'live')
    expect(sub.value()?.sessionId).toBe('s1')
  })
})

// ═══ 链路 ═══════════════════════════════════════════════

describe('syncClient: links', () => {
  it('SC-30 link ids are <idPrefix>.<n>, counting up; two prefixed clients on one channel each consume only their own frames', async () => {
    const { server, client } = rig({ idPrefix: 'p', reconnectDelayMs: 1 })
    server.serve(S1, sessionView('s1'))
    const sub = client.acquire<SessionView>(S1)
    await until(() => sub.state().status === 'live', 'live on p.1')
    sub.release()
    await until(() => server.links().length === 0, 'idle close')
    const again = client.acquire<SessionView>(S1)
    await until(() => again.state().status === 'live', 'live on p.2')
    server.endServerLink('p.2', { bye: true })
    await until(() => framesOn(server, 'p.3').length > 0, 'p.3')
    await until(() => again.state().status === 'live', 'live on p.3')
    expect(hellos(server)).toEqual(['p.1', 'p.2', 'p.3'])
    expect(server.sent.every(([id]) => id.startsWith('p.'))).toBe(true)
    again.release()

    // 同一条渠道上两个客户端
    const shared = fakeServer()
    shared.serve(S1, sessionView('s1'))
    const a = rig({ idPrefix: 'a', reconnectDelayMs: 1 }, shared)
    const b = rig({ idPrefix: 'b', reconnectDelayMs: 1 }, shared)
    const subA = a.client.acquire<SessionView>(S1)
    const subB = b.client.acquire<SessionView>(S1)
    await until(() => subA.state().status === 'live' && subB.state().status === 'live', 'both live')
    expect(shared.links().sort()).toEqual(['a.1', 'b.1'])
    expect(shared.subscriptions(S1)).toHaveLength(2)
    const bEvents = record(subB)

    // a 的链路上来一帧坏帧：a 的链路关掉、换 a.2；b 收到了这帧（同一条渠道），但不是它的链路，碰都不碰
    shared.inject('a.1', { t: 'not-a-frame' })
    await until(() => framesOn(shared, 'a.2').length > 0, 'a.2')
    await until(() => subA.state().status === 'live', 'a live on a.2')
    expect(b.warnings).toEqual([])
    expect(bEvents).toEqual([])
    expect(hellos(shared).filter((id) => id.startsWith('b.'))).toEqual(['b.1'])
    expect(shared.links().sort()).toEqual(['a.2', 'b.1'])

    shared.change(S1, (draft) => {
      draft.run = { state: 'busy' }
    })
    await shared.settle()
    expect(subA.value()).toEqual(shared.value(S1))
    expect(subB.value()).toEqual(shared.value(S1))
  })

  it('SC-31 last release → after one macrotask the link closes with a bye and everything drops to 0; reacquiring in the same macrotask reuses the link; after the idle close → a new id and a hello', async () => {
    const { server, client } = rig()
    server.serve(S1, sessionView('s1'))
    const sub = client.acquire<SessionView>(S1)
    await until(() => sub.state().status === 'live', 'live')
    await server.settle()
    expect(server.links()).toEqual(['t.1'])
    expect(server.frameListeners.active).toBe(1)

    // 同一个宏任务里放了又拿：复用链路
    sub.release()
    await microtasks()
    const reused = client.acquire<SessionView>(S1)
    await tick()
    await server.settle()
    expect(hellos(server)).toEqual(['t.1'])
    expect(framesOn(server, 't.1').some((frame) => frame.t === 'bye')).toBe(false)
    expect(reused.state()).toEqual({ status: 'live' })

    // 最后一个放手：当场还开着，一个宏任务之后带 bye 关掉
    reused.release()
    expect(framesOn(server, 't.1').some((frame) => frame.t === 'bye')).toBe(false)
    expect(server.frameListeners.active).toBe(1)
    await tick()
    const frames = framesOn(server, 't.1')
    expect(frames.at(-1)).toEqual({ t: 'bye', reason: 'idle' })
    expect(frames.at(-2)).toMatchObject({ t: 'release' })
    expect(server.frameListeners.active).toBe(0)
    await server.settle()
    expect(server.links()).toEqual([])
    expect(server.subscriptions()).toEqual([])

    // 空闲关掉之后再拿：新 id、当场发 hello（不退避）
    const fresh = client.acquire<SessionView>(S1)
    expect(hellos(server)).toEqual(['t.1', 't.2'])
    await until(() => fresh.state().status === 'live', 'live on t.2')
    expect(server.links()).toEqual(['t.2'])
  })

  it('SC-32 a frame injected for an old link id (after idle close or resetAll) is ignored: no event, no warning', async () => {
    const { server, client, warnings } = rig()
    server.serve(S1, sessionView('s1'))
    const first = client.acquire<SessionView>(S1)
    await until(() => first.state().status === 'live', 'live on t.1')
    first.release()
    await until(() => server.links().length === 0, 'idle close')
    const sub = client.acquire<SessionView>(S1)
    await until(() => sub.state().status === 'live', 'live on t.2')
    await server.settle()
    const events = record(sub)
    const value = sub.value()

    const forged = (linkId: string, viewSub: unknown): void => {
      server.inject(linkId, {
        t: 'state',
        id: viewSub,
        reset: sessionView('s1', { conversationId: 99 })
      })
      server.inject(linkId, { t: 'not-a-frame' })
      server.inject(linkId, { t: 'bye', reason: 'forged' })
    }

    // 空闲关掉的 t.1 上：用 t.2 上视图订阅的 id 伪造一帧（误投递就会换掉值）、一帧坏帧、一个 bye
    forged('t.1', subIds(server, 't.2', 'view')[0])
    await server.settle()
    expect(events).toEqual([])
    expect(sub.value()).toBe(value)
    expect(warnings).toEqual([])
    expect(hellos(server)).toEqual(['t.1', 't.2'])

    // resetAll 换掉的 t.2 上
    client.resetAll()
    await until(() => sub.state().status === 'live', 'live on t.3')
    await server.settle()
    events.length = 0
    const current = sub.value()
    forged('t.2', subIds(server, 't.3', 'view')[0])
    await server.settle()
    expect(events).toEqual([])
    expect(sub.value()).toBe(current)
    expect(warnings).toEqual([])
    expect(hellos(server)).toEqual(['t.1', 't.2', 't.3'])
    expect(server.links()).toEqual(['t.3'])

    // 对照：同一帧投到当前链路上就会换掉值（所以上面「没变」不是因为这帧本身无效）
    server.inject('t.3', {
      t: 'state',
      id: subIds(server, 't.3', 'view')[0],
      reset: sessionView('s1', { conversationId: 99 })
    })
    await server.settle()
    expect(sub.value()?.conversationId).toBe(99)
  })

  it('SC-41 syncClientFor: same channel → same client; options apply only on the first call; another channel → another client', async () => {
    const server = fakeServer()
    server.serve(S1, sessionView('s1'))
    const warn = (): void => {}
    const client = syncClientFor(server.channel, { idPrefix: 'first', logger: { warn } })
    disposers.push(() => client.dispose())
    expect(syncClientFor(server.channel, { idPrefix: 'second' })).toBe(client)
    expect(syncClientFor(server.channel)).toBe(client)

    const sub = client.acquire<SessionView>(S1)
    await until(() => sub.state().status === 'live', 'live')
    expect(hellos(server)).toEqual(['first.1'])

    const other = linkChannel(() => {})
    const otherClient = syncClientFor(other.channel, { idPrefix: 'other' })
    disposers.push(() => otherClient.dispose())
    expect(otherClient).not.toBe(client)
    expect(syncClientFor(other.channel)).toBe(otherClient)
    otherClient.acquire(S1)
    expect(other.sent.map(([id, frame]) => [id, frame.t])[0]).toEqual(['other.1', 'hello'])
  })
})

// ═══ 链路（假定时器：退避、断开、关停） ═══════════════════════

describe('syncClient: links over time (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
    vi.useRealTimers()
  })

  const drain = (): Promise<void> => microtasks(100)

  /** 一点一点往前拨，直到这条链路发出 hello（最多 `limitMs`）；返回 hello 的时刻 */
  async function advanceUntilHello(
    server: FakeServer,
    linkId: string,
    limitMs = 10_000
  ): Promise<number> {
    for (let spent = 0; spent <= limitMs; spent += 10) {
      const at = helloAt(server, linkId)
      if (at !== undefined) return at
      await vi.advanceTimersByTimeAsync(10)
    }
    throw new Error(`no hello on ${linkId} within ${limitMs} ms`)
  }

  async function liveRig(
    options: Partial<SyncClientOptions> = {}
  ): Promise<Rig & { sub: ViewSubscription<SessionView>; events: ViewEvent<SessionView>[] }> {
    const r = rig(options)
    r.server.serve(S1, sessionView('s1'))
    const sub = r.client.acquire<SessionView>(S1)
    const events = record(sub)
    await drain()
    expect(sub.state()).toEqual({ status: 'live' })
    return { ...r, sub, events }
  }

  it('SC-33 the server ends the link with a bye while bindings are held → loading now, nothing sent before 250 ms, then hello and the holds; the next value is the current server value', async () => {
    const { server, sub, events, warnings } = await liveRig()
    const preOutage = sub.value()
    const registered = server.frameListeners.registered
    events.length = 0

    server.endServerLink('t.1', { bye: true })
    await drain()
    expect(sub.state()).toEqual({ status: 'loading' })
    expect(sub.value()).toBeUndefined()
    expect(events).toEqual([LOADING_EVENT])
    // 一条新链路已经建好（它的帧监听器登记了），只是还没发帧
    expect(server.frameListeners.registered).toBe(registered + 1)
    expect(server.frameListeners.active).toBe(1)
    expect(warnings.map((w) => w.message)).toEqual([
      '[sync] link t.1 closed (server ended the link); reconnecting'
    ])

    // 断线期间服务端改了值
    server.change(S1, (draft) => {
      draft.run = { state: 'busy' }
    })
    const mark = server.sent.length
    await vi.advanceTimersByTimeAsync(249)
    expect(server.sent.slice(mark)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    const out = server.sent.slice(mark)
    expect(out.every(([id]) => id === 't.2')).toBe(true)
    expect(out.map(([, frame]) => frame.t).slice(0, 2)).toEqual(['hello', 'hold'])

    await drain()
    expect(sub.state()).toEqual({ status: 'live' })
    expect(sub.value()).toEqual(server.value(S1))
    expect(valuesOf(events)).toEqual([{ value: server.value(S1), delivery: 'hydrate' }])
    expect(
      valuesOf(events).some((e) => JSON.stringify(e.value) === JSON.stringify(preOutage))
    ).toBe(false)
    expect(statusesOf(events)).toEqual(['loading', 'live'])
  })

  it('SC-33 the server ends the link without a bye → once the client notices (ping timeout): loading, a new link 250 ms later, the current server value', async () => {
    const { server, sub, events, warnings } = await liveRig()
    const preOutage = sub.value()
    events.length = 0

    server.endServerLink('t.1', { bye: false })
    await drain()
    // 客户端还不知道
    expect(sub.state()).toEqual({ status: 'live' })
    server.change(S1, (draft) => {
      draft.run = { state: 'busy' }
    })

    for (let i = 0; i < 180 && sub.state().status !== 'loading'; i++) {
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(sub.state()).toEqual({ status: 'loading' })
    expect(sub.value()).toBeUndefined()
    const closed = warnings.find((w) => w.message.startsWith('[sync] link t.1 closed'))
    expect(closed).toBeDefined()

    const at = await advanceUntilHello(server, 't.2')
    expect(at - closed!.at).toBe(250)
    expect(server.sent.filter(([id, , sentAt]) => id === 't.2' && sentAt < at)).toEqual([])
    await drain()
    expect(sub.state()).toEqual({ status: 'live' })
    expect(sub.value()).toEqual(server.value(S1))
    expect(valuesOf(events)).toEqual([{ value: server.value(S1), delivery: 'hydrate' }])
    expect(
      valuesOf(events).some((e) => JSON.stringify(e.value) === JSON.stringify(preOutage))
    ).toBe(false)
  })

  it('SC-34 consecutive failures where the new link never receives a frame → 250, 500, 1000, 2000, 4000, 5000, 5000; back to 250 after a first frame', async () => {
    const { server, sub } = await liveRig()
    server.setDeaf(true)
    const delays: number[] = []
    let link = 1
    for (let i = 0; i < 7; i++) {
      const failedAt = Date.now()
      server.setUp(false)
      server.setUp(true)
      await drain()
      link += 1
      delays.push((await advanceUntilHello(server, `t.${link}`)) - failedAt)
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000])
    expect(sub.state()).toEqual({ status: 'loading' })

    // 服务端又听得见了：下一条链路（还按 5000 退避）收到第一帧 → 活过来，退避复位
    server.setDeaf(false)
    let failedAt = Date.now()
    server.setUp(false)
    server.setUp(true)
    await drain()
    link += 1
    expect((await advanceUntilHello(server, `t.${link}`)) - failedAt).toBe(5000)
    await drain()
    expect(sub.state()).toEqual({ status: 'live' })

    failedAt = Date.now()
    server.setUp(false)
    server.setUp(true)
    await drain()
    link += 1
    expect((await advanceUntilHello(server, `t.${link}`)) - failedAt).toBe(250)
    await drain()
    expect(sub.state()).toEqual({ status: 'live' })
  })

  it('SC-35 every new link refused with a bye → the backoff still grows 250→500→1000→2000→4000→5000→5000', async () => {
    const { server, sub } = await liveRig()
    server.refuseAllLinks()
    server.endServerLink('t.1', { bye: true })
    await drain()
    let closedAt = Date.now()
    const delays: number[] = []
    for (let link = 2; link <= 8; link++) {
      const at = await advanceUntilHello(server, `t.${link}`)
      delays.push(at - closedAt)
      await drain()
      // 被拒：bye 当场到了，这条链路已经关掉
      expect(server.links()).toEqual([])
      closedAt = at
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000])
    expect(sub.state()).toEqual({ status: 'loading' })

    // 不再拒：下一条链路收到真正的应答 → 活过来，退避复位
    server.refuseAllLinks(false)
    expect((await advanceUntilHello(server, 't.9')) - closedAt).toBe(5000)
    await drain()
    expect(sub.state()).toEqual({ status: 'live' })
    server.endServerLink('t.9', { bye: true })
    await drain()
    const endedAt = Date.now()
    expect((await advanceUntilHello(server, 't.10')) - endedAt).toBe(250)
  })

  it('SC-36 transport down → link ended, loading; the new link holds its frames while down (even past its backoff); up → hello first, then live with a fresh snapshot', async () => {
    const { server, sub, events } = await liveRig()
    events.length = 0
    const registered = server.frameListeners.registered

    server.setUp(false)
    await drain()
    expect(sub.state()).toEqual({ status: 'loading' })
    expect(sub.value()).toBeUndefined()
    expect(events).toEqual([LOADING_EVENT])
    expect(server.links()).toEqual([])
    expect(server.frameListeners.registered).toBe(registered + 1)

    server.change(S1, (draft) => {
      draft.run = { state: 'busy' }
      draft.context.usedTokens = 7
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(framesOn(server, 't.2')).toEqual([])
    expect(sub.state()).toEqual({ status: 'loading' })

    server.setUp(true)
    const out = framesOn(server, 't.2')
    expect(out[0]).toMatchObject({ t: 'hello' })
    expect(out.slice(1).map((frame) => frame.t)).toContain('hold')
    await drain()
    expect(sub.state()).toEqual({ status: 'live' })
    expect(sub.value()).toEqual(server.value(S1))
    expect(events).toEqual([
      LOADING_EVENT,
      LIVE_EVENT,
      { kind: 'value', value: server.value(S1), delivery: 'hydrate' }
    ])
  })

  it('SC-37 a link that closes with no bindings held → no reconnect; the next acquire opens a link at once', async () => {
    const { server, client, sub, warnings } = await liveRig()

    // 放手之后、空闲关闭之前，服务端带 bye 关了链路
    sub.release()
    server.endServerLink('t.1', { bye: true })
    await drain()
    expect(server.frameListeners.active).toBe(0)
    const mark = server.sent.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.sent.slice(mark)).toEqual([])
    expect(warnings.filter((w) => w.message.includes('reconnecting'))).toEqual([])

    const next = client.acquire<SessionView>(S1)
    expect(hellos(server)).toEqual(['t.1', 't.2'])
    await drain()
    expect(next.state()).toEqual({ status: 'live' })

    // 同样：空闲窗口里传输断了 → 不重连；恢复也不发；下一次 acquire 当场开新链路
    next.release()
    server.setUp(false)
    await drain()
    server.setUp(true)
    const mark2 = server.sent.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.sent.slice(mark2)).toEqual([])
    const third = client.acquire<SessionView>(S1)
    expect(hellos(server)).toEqual(['t.1', 't.2', 't.3'])
    await drain()
    expect(third.state()).toEqual({ status: 'live' })
  })

  it('SC-38 resetAll → the old link says bye (holds released), a new link starts; every binding goes loading then live; the backoff resets; with no link → no frames', async () => {
    const { server, client, sub, events } = await liveRig()
    server.serve(S2, sessionView('s2'))
    const sub2 = client.acquire<SessionView>(S2)
    const events2 = record(sub2)
    await drain()
    expect(sub2.state()).toEqual({ status: 'live' })
    events.length = 0
    events2.length = 0

    client.resetAll()
    expect(framesOn(server, 't.1').at(-1)).toMatchObject({ t: 'bye' })
    expect(framesOn(server, 't.2')[0]).toMatchObject({ t: 'hello' })
    await drain()
    expect(server.links()).toEqual(['t.2'])
    expect(server.subscriptions(S1)).toHaveLength(1)
    expect(server.subscriptions(S2)).toHaveLength(1)
    for (const [target, recorded] of [
      [S1, events],
      [S2, events2]
    ] as const) {
      expect(recorded).toEqual([
        LOADING_EVENT,
        LIVE_EVENT,
        { kind: 'value', value: server.value(target), delivery: 'hydrate' }
      ])
    }
    expect(sub.state()).toEqual({ status: 'live' })

    // 退避复位：连续失败把退避拉到 1000（t.5 还在等），resetAll → 当场开 t.6；它也一帧收不到地失败了 → 250
    server.setDeaf(true)
    for (let link = 3; link <= 5; link++) {
      server.setUp(false)
      server.setUp(true)
      await drain()
      if (link < 5) await advanceUntilHello(server, `t.${link}`)
    }
    client.resetAll()
    expect(framesOn(server, 't.5')).toEqual([])
    expect(framesOn(server, 't.6')[0]).toMatchObject({ t: 'hello' })
    const failedAt = Date.now()
    server.setUp(false)
    server.setUp(true)
    await drain()
    expect((await advanceUntilHello(server, 't.7')) - failedAt).toBe(250)

    // 没有链路时：什么帧都不发、不开链路
    const idle = rig({ idPrefix: 'idle' })
    idle.client.resetAll()
    expect(idle.server.sent).toEqual([])
    expect(idle.server.frameListeners.registered).toBe(0)
    idle.server.serve(S1, sessionView('s1'))
    const once = idle.client.acquire<SessionView>(S1)
    await drain()
    once.release()
    await vi.advanceTimersByTimeAsync(0)
    await drain()
    expect(idle.server.links()).toEqual([])
    const mark = idle.server.sent.length
    idle.client.resetAll()
    expect(idle.server.sent.slice(mark)).toEqual([])
    expect(idle.server.frameListeners.active).toBe(0)
  })

  it('SC-39 dispose → bindings released, the link closes with a bye, acquire throws, resetAll does nothing, no timers left', async () => {
    const { server, client, events } = await liveRig()
    server.serve(S2, sessionView('s2'))
    const sub2 = client.acquire<SessionView>(S2)
    await drain()
    expect(sub2.state()).toEqual({ status: 'live' })
    events.length = 0
    const mark = server.sent.length

    client.dispose()
    const out = server.sent.slice(mark)
    expect(out.every(([id]) => id === 't.1')).toBe(true)
    // 每个绑定：先退订它的两个状态成员（unsub），再放掉持有；最后链路带 bye 关掉
    expect(out.map(([, frame]) => frame.t).filter((t) => t !== 'unsub')).toEqual([
      'release',
      'release',
      'bye'
    ])
    expect(out.at(-1)?.[1]).toEqual({ t: 'bye', reason: 'client disposed' })
    const sentAfterDispose = server.sent.length
    expect(() => client.acquire(S1)).toThrow('sync client is disposed')
    client.resetAll()
    client.dispose()
    expect(server.sent.length).toBe(sentAfterDispose)
    expect(server.frameListeners.registered).toBe(1)

    await drain()
    expect(server.links()).toEqual([])
    expect(server.subscriptions()).toEqual([])
    expect(server.frameListeners.active).toBe(0)
    server.change(S1, (draft) => {
      draft.run = { state: 'busy' }
    })
    await drain()
    expect(events).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('SC-39 dispose while a reconnect is pending → nothing ever goes out on the new link, no timers left', async () => {
    const { server, client } = await liveRig()
    server.endServerLink('t.1', { bye: true })
    await drain()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    client.dispose()
    await drain()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(framesOn(server, 't.2')).toEqual([])
    expect(server.frameListeners.active).toBe(0)
  })

  it('SC-40 channel.send throws on a frame sent directly → transport error → reconnect', async () => {
    const { server, client, sub, warnings } = await liveRig()
    server.serve(S2, sessionView('s2'))
    server.throwOnSend((linkId, frame) => linkId === 't.1' && frame.t === 'hold')

    const sub2 = client.acquire<SessionView>(S2)
    expect(sub.state()).toEqual({ status: 'loading' })
    expect(warnings.map((w) => w.message)).toEqual([
      '[sync] link t.1 closed (transport error); reconnecting'
    ])
    server.throwOnSend(undefined)

    await advanceUntilHello(server, 't.2')
    await drain()
    expect(sub.state()).toEqual({ status: 'live' })
    expect(sub2.state()).toEqual({ status: 'live' })
    expect(sub2.value()).toEqual(server.value(S2))
  })

  it('SC-40 channel.send throws while a held-back link flushes after its backoff → transport error → reconnect', async () => {
    const { server, sub, warnings } = await liveRig()
    server.endServerLink('t.1', { bye: true })
    await drain()
    server.throwOnSend((linkId) => linkId === 't.2')

    // 退避到了、攒着的帧一起发出去时传输抛错：同样是「传输断了」—— 不能从定时器里漏出去
    let escaped: unknown
    try {
      await vi.advanceTimersByTimeAsync(250)
    } catch (error) {
      escaped = error
    }
    expect(escaped).toBeUndefined()
    expect(warnings.map((w) => w.message)).toContain(
      '[sync] link t.2 closed (transport error); reconnecting'
    )
    server.throwOnSend(undefined)
    await advanceUntilHello(server, 't.3')
    await drain()
    expect(sub.state()).toEqual({ status: 'live' })
  })

  it('SC-40 channel.send throws on the first hold of an acquire made in the idle window → transport error → reconnect', async () => {
    const { server, client, sub, warnings } = await liveRig()
    server.serve(S2, sessionView('s2'))
    // 最后一个放手了、链路还没空闲关掉（同一个宏任务）：这时拿新目标，它的 hold 发出去时传输抛错
    sub.release()
    server.throwOnSend((linkId, frame) => linkId === 't.1' && frame.t === 'hold')
    const sub2 = client.acquire<SessionView>(S2)
    server.throwOnSend(undefined)
    expect(sub2.state()).toEqual({ status: 'loading' })

    await vi.advanceTimersByTimeAsync(10_000)
    await drain()
    expect(sub2.state()).toEqual({ status: 'live' })
    expect(hellos(server)).toContain('t.2')
    expect(warnings.map((w) => w.message)).toContain(
      '[sync] link t.1 closed (transport error); reconnecting'
    )
  })
})
