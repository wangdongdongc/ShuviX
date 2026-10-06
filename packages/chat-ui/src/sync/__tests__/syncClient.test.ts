/**
 * syncClient（P3-08-01…10）—— chat-ui 的视图同步客户端，对着一个**真的** chord 服务端（`fakeServer`）跑：
 *
 *   01 先登记订阅再发调用、回复前到的帧缓存到激活：快照先于每一条更新交给使用方
 *   02 每个订阅一个解码器：两个目标交错改同一条路径，互不串
 *   03 孤儿帧 / 退订之后迟到的帧：不抛、不交、不报错
 *   04 订阅失败带 `.code`：状态 error + code，只订一次（不重试）；没有码 → code undefined
 *   05 同一订阅上的 reset：值换成快照，不重订，之后的更新照常解码
 *   06 replaced（none 视图 → durable 视图）：门面不变，不重订
 *   07 unavailable（删除）：状态 unavailable，不抛；之后 replaced → 重新 live
 *   08 引用计数：两个使用方一次订阅；都放手才退订一次；onFrame 最后才注销；之后的帧不交
 *   09 快速切换 A → B → A：最终是 A 的值；B 放手之后不再交出 B 的值
 *   10 断档 / 解码失败（PIN-15）：丢掉绑定、重订恰一次、收敛到服务端的值、记一条警告
 *
 * 不起 jsdom：直接驱动客户端（钩子那一层在 useSessionView.dom.test.tsx）。
 */
import { describe, expect, it } from 'vitest'
import type { SyncTarget } from '@shuvix/chat-protocol/sync'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { createSyncClient, type ViewEvent } from '../syncClient'
import { fakeServer } from './support/fakeServer'
import { V, liveCard, text, user } from '../../__tests__/support/views'

const S1: SyncTarget = { kind: 'session', sessionId: 's1' }
const S2: SyncTarget = { kind: 'session', sessionId: 's2' }

function streaming(sessionId: string, content = 'He'): SessionView {
  return V(sessionId, {
    messages: [user('u1', 'hi', sessionId)],
    live: liveCard(7, [text(content)], undefined, sessionId),
    run: { state: 'busy' }
  })
}

function quietLogger(): { warn(message: string): void; warnings: string[] } {
  const warnings: string[] = []
  return { warn: (message) => warnings.push(message), warnings }
}

/** 记下一个持有交出的全部事件 */
function record<V>(sub: { subscribe(l: (e: ViewEvent<V>) => void): () => void }): ViewEvent<V>[] {
  const events: ViewEvent<V>[] = []
  sub.subscribe((event) => events.push(event))
  return events
}

const values = <V>(events: ViewEvent<V>[]): Array<{ delivery: string; value: V }> =>
  events.flatMap((e) => (e.kind === 'value' ? [{ delivery: e.delivery, value: e.value }] : []))

describe('syncClient', () => {
  it('P3-08-01 订阅先登记、回复前到的两帧不当孤儿；快照先交，再按序交两条更新；值 = 服务端', async () => {
    const server = fakeServer({ framesBeforeReply: 2 })
    server.serve(S1, streaming('s1'))
    const logger = quietLogger()
    const client = createSyncClient({ channel: server.channel, logger, idPrefix: 't1' })
    const sub = client.acquire<SessionView>(S1)
    const events = record(sub)
    await server.settle()

    const subscribeCalls = server.calls.filter((c) => c.startsWith('subscribe:'))
    expect(subscribeCalls).toHaveLength(1)
    const id = subscribeCalls[0].slice('subscribe:'.length)
    // 早到的两帧确实是这个订阅的，而且在回复之前就送出了
    expect(server.frames.filter((f) => f.subscriptionId === id)).toHaveLength(2)
    expect(sub.state()).toEqual({ status: 'live' })
    expect(logger.warnings).toEqual([])
    const delivered = values(events)
    expect(delivered.map((d) => d.delivery)).toEqual(['hydrate', 'update', 'update'])
    expect(
      delivered.map((d) => (d.value.live?.message.blocks[0] as { text: string }).text)
    ).toEqual(['He', 'He.', 'He..'])
    expect(sub.value()).toEqual(server.value(S1))
  })

  it('P3-08-02 两个目标交错改同一条路径：各自等于各自的服务端值，零解码错误', async () => {
    const server = fakeServer()
    server.serve(S1, streaming('s1', 'a'))
    server.serve(S2, streaming('s2', 'b'))
    const logger = quietLogger()
    const client = createSyncClient({ channel: server.channel, logger })
    const one = client.acquire<SessionView>(S1)
    const two = client.acquire<SessionView>(S2)
    await server.settle()
    for (let i = 0; i < 5; i++) {
      for (const [target, ch] of [
        [S1, 'x'],
        [S2, 'y']
      ] as const) {
        server.change(target, (draft) => {
          const d = draft as unknown as SessionView
          d.messages[0].content += ch
        })
      }
    }
    await server.settle()
    expect(one.value()).toEqual(server.value(S1))
    expect(two.value()).toEqual(server.value(S2))
    expect((one.value() as SessionView).messages[0].content).toBe('hixxxxx')
    expect((two.value() as SessionView).messages[0].content).toBe('hiyyyyy')
    expect(logger.warnings).toEqual([])
  })

  it('P3-08-03 孤儿帧与退订后迟到的帧：不抛、不交出值、不报错', async () => {
    const server = fakeServer()
    server.serve(S1, streaming('s1'))
    server.serve(S2, streaming('s2'))
    const logger = quietLogger()
    const client = createSyncClient({ channel: server.channel, logger })
    const keep = client.acquire<SessionView>(S2)
    const keepEvents = record(keep)
    const sub = client.acquire<SessionView>(S1)
    const events = record(sub)
    await server.settle()
    const [closedId] = server.subscriptions(S1)
    events.length = 0
    keepEvents.length = 0
    const lateFrame = { target: S1, subscriptionId: closedId, update: { type: 'unavailable' } }
    sub.release()
    await server.settle()
    // 退订之后才到的帧（同一个订阅 id），以及一个从没有过的订阅 id
    server.inject(lateFrame)
    server.inject({ target: S1, subscriptionId: 'never-was', update: { type: 'unavailable' } })
    server.inject({ target: S2, subscriptionId: 'garbage', update: { nonsense: true } })
    await server.settle()
    expect(events).toEqual([])
    expect(keepEvents).toEqual([])
    expect(logger.warnings).toEqual([])
    expect(keep.state()).toEqual({ status: 'live' })
    expect(keep.value()).toEqual(server.value(S2))
  })

  it('P3-08-04 订阅失败带 code：error + code，只订一次；不带码 → code undefined', async () => {
    const server = fakeServer()
    server.serve(S1, streaming('s1'))
    server.serve(S2, streaming('s2'))
    const client = createSyncClient({ channel: server.channel, logger: quietLogger() })
    server.failSubscribe('service_not_found')
    const sub = client.acquire<SessionView>(S1)
    const events = record(sub)
    await server.settle()
    expect(sub.state()).toEqual({ status: 'error', code: 'service_not_found' })
    expect(server.calls.filter((c) => c.startsWith('fail:') || c.startsWith('subscribe:'))).toEqual(
      [expect.stringMatching(/^fail:/)]
    )
    expect(values(events)).toEqual([])
    expect(sub.value()).toBeUndefined()

    server.failSubscribe(undefined)
    const other = client.acquire<SessionView>(S2)
    await server.settle()
    expect(other.state().status).toBe('error')
    expect(other.state().code).toBeUndefined()
  })

  it('P3-15-CB1 渠道以纯对象 {code, message} 拒绝（preload 过 contextBridge 的形状）→ 状态仍带 code；没码 → undefined', async () => {
    const server = fakeServer()
    server.serve(S1, streaming('s1'))
    server.serve(S2, streaming('s2'))
    // contextBridge 拷一个 Error 只留 message：preload 改以纯对象拒绝，客户端负责还原
    let plain: { code?: string; message: string } | undefined = {
      code: 'service_not_found',
      message: 'Unknown agent a1'
    }
    const channel = {
      invoke: (target: Parameters<typeof server.channel.invoke>[0], call: Parameters<typeof server.channel.invoke>[1]) =>
        plain === undefined ? server.channel.invoke(target, call) : Promise.reject(structuredClone(plain)),
      onFrame: server.channel.onFrame
    }
    const client = createSyncClient({ channel, logger: quietLogger() })
    const sub = client.acquire<SessionView>(S1)
    await server.settle()
    expect(sub.state()).toEqual({ status: 'error', code: 'service_not_found' })
    expect(sub.value()).toBeUndefined()

    plain = { message: 'no code here' }
    const other = client.acquire<SessionView>(S2)
    await server.settle()
    expect(other.state().status).toBe('error')
    expect(other.state().code).toBeUndefined()
  })

  it('P3-08-05 同一订阅上的 reset：值换成快照，不重订，之后的更新照常解码', async () => {
    const server = fakeServer()
    server.serve(S1, streaming('s1'))
    const logger = quietLogger()
    const client = createSyncClient({ channel: server.channel, logger })
    const sub = client.acquire<SessionView>(S1)
    await server.settle()
    const [id] = server.subscriptions(S1)
    // 服务端改了内容，但把这次改动吞掉，换成一帧整份 reset
    server.dropNext(id)
    server.change(S1, (draft) => {
      ;(draft as unknown as SessionView).messages[0].content = 'changed'
    })
    server.reset(id)
    await server.settle()
    expect((sub.value() as SessionView).messages[0].content).toBe('changed')
    for (const ch of ['1', '2', '3']) {
      server.change(S1, (draft) => {
        ;(draft as unknown as SessionView).messages[0].content += ch
      })
    }
    await server.settle()
    expect(sub.value()).toEqual(server.value(S1))
    expect(server.calls.filter((c) => c.startsWith('subscribe:'))).toHaveLength(1)
    expect(logger.warnings).toEqual([])
  })

  it('P3-08-06 replaced（none → durable）：交出新值，不重订', async () => {
    const server = fakeServer()
    server.serve(S1, { ...V('s1'), source: 'none' })
    const client = createSyncClient({ channel: server.channel, logger: quietLogger() })
    const sub = client.acquire<SessionView>(S1)
    const events = record(sub)
    await server.settle()
    expect((sub.value() as SessionView).source).toBe('none')
    server.replace(S1, V('s1', { messages: [user('7', 'first')] }))
    await server.settle()
    expect((sub.value() as SessionView).source).toBe('durable')
    expect((sub.value() as SessionView).messages.map((m) => m.id)).toEqual(['7'])
    expect(values(events).at(-1)?.delivery).toBe('hydrate')
    expect(server.calls.filter((c) => c.startsWith('subscribe:'))).toHaveLength(1)
    expect(sub.state()).toEqual({ status: 'live' })
  })

  it('P3-08-07 unavailable：状态 unavailable、值清空、不抛；之后 replaced → 重新 live、交出新值', async () => {
    const server = fakeServer()
    server.serve(S1, streaming('s1'))
    const client = createSyncClient({ channel: server.channel, logger: quietLogger() })
    const sub = client.acquire<SessionView>(S1)
    const events = record(sub)
    await server.settle()
    server.withdraw(S1)
    await server.settle()
    expect(sub.state()).toEqual({ status: 'unavailable' })
    expect(sub.value()).toBeUndefined()
    expect(events.at(-1)).toEqual({ kind: 'status', state: { status: 'unavailable' } })

    server.replace(S1, V('s1', { messages: [user('9', 'again')] }))
    await server.settle()
    expect(sub.state()).toEqual({ status: 'live' })
    expect((sub.value() as SessionView).messages[0].id).toBe('9')
  })

  it('P3-08-08 两个使用方共用一个订阅；放手一个不退订；都放手退订恰一次、onFrame 注销一次；之后的帧不交', async () => {
    const server = fakeServer()
    server.serve(S1, streaming('s1'))
    const client = createSyncClient({ channel: server.channel, logger: quietLogger() })
    const a = client.acquire<SessionView>(S1)
    const b = client.acquire<SessionView>(S1)
    const eventsB = record(b)
    await server.settle()
    expect(server.calls.filter((c) => c.startsWith('subscribe:'))).toHaveLength(1)
    expect(a.release()).toBe(false)
    await server.settle()
    expect(server.calls.filter((c) => c.startsWith('unsubscribe:'))).toHaveLength(0)
    expect(server.frameListeners.unregistered).toBe(0)
    expect(b.release()).toBe(true)
    await server.settle()
    expect(server.calls.filter((c) => c.startsWith('unsubscribe:'))).toHaveLength(1)
    expect(server.frameListeners).toMatchObject({ registered: 1, unregistered: 1, active: 0 })
    const before = eventsB.length
    server.change(S1, (draft) => {
      ;(draft as unknown as SessionView).messages[0].content = 'after'
    })
    await server.settle()
    expect(eventsB).toHaveLength(before)
  })

  it('P3-08-09 A → B → A 一拍之内：最终是 A 的值；B 放手之后不再交出 B 的值；订阅 / 退订次数对得上', async () => {
    const A: SyncTarget = { kind: 'session', sessionId: 'A' }
    const B: SyncTarget = { kind: 'session', sessionId: 'B' }
    const server = fakeServer()
    server.serve(A, streaming('A', 'aa'))
    server.serve(B, streaming('B', 'bb'))
    const client = createSyncClient({ channel: server.channel, logger: quietLogger() })
    const a1 = client.acquire<SessionView>(A)
    a1.release()
    const b = client.acquire<SessionView>(B)
    const eventsB = record(b)
    b.release()
    const a2 = client.acquire<SessionView>(A)
    await server.settle()
    expect((a2.value() as SessionView).sessionId).toBe('A')
    expect(values(eventsB)).toEqual([])
    const subscribes = server.calls.filter((c) => c.startsWith('subscribe:')).length
    const unsubscribes = server.calls.filter((c) => c.startsWith('unsubscribe:')).length
    expect([subscribes, unsubscribes]).toEqual([3, 2])
    expect(server.subscriptions(B)).toEqual([])
  })

  it('P3-08-10 断档（丢一帧）：丢掉绑定、重订恰一次、收敛到服务端的值、一条警告', async () => {
    const server = fakeServer()
    server.serve(S1, streaming('s1'))
    const logger = quietLogger()
    const client = createSyncClient({ channel: server.channel, logger })
    const sub = client.acquire<SessionView>(S1)
    await server.settle()
    const [id] = server.subscriptions(S1)
    server.dropNext(id)
    for (const ch of ['1', '2', '3']) {
      server.change(S1, (draft) => {
        ;(draft as unknown as SessionView).messages[0].content += ch
      })
    }
    await server.settle()
    await server.settle()
    expect(server.calls.filter((c) => c.startsWith('subscribe:'))).toHaveLength(2)
    expect(server.calls.filter((c) => c.startsWith('unsubscribe:'))).toHaveLength(1)
    expect(sub.value()).toEqual(server.value(S1))
    expect(sub.state()).toEqual({ status: 'live' })
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toMatch(/resubscribing/)
  })
})
