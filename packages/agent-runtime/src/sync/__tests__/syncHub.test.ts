/**
 * P3-04 · SyncHub —— 真的会话宿主 + 假投影器（真的 chord `replicatedState`，P3-03 并行实现中）+
 * 回环传输 + 真的 chord 绑定客户端（`support/client.ts`）。编号对着设计稿 p3-0304-test-design.md。
 *
 * 与设计稿的出入（见各用例的注释）：
 *  - 清空（P1-10：`host.delete`）与删除共用宿主的 'destroy' 关闭；hub 分不出两者。于是 'destroy' 只表示
 *    「存储没了」→ 会话目标换成空视图（P3-04-09），会话本身被删由宿主显式调 `hub.deleteSession`
 *    （P3-04-10，PIN-14）。
 *  - 宿主的开 / 关钩子由 `support/rig.ts` 补上（SessionHost 的钩子是 P3-03 的活）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createServiceCatalogueCall,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  RemoteServiceError,
  type ServiceProviderUpdate
} from '@earendil-works/chord'
import { CHAT_VIEW_SERVICE_ID, type SyncTarget } from '@shuvix/chat-protocol/sync'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { emptySessionView } from '@shuvix/chat-protocol/types/sessionView'
import { isJsonOnly } from '@shuvix/chat-protocol/utils/jsonOnly'
import { describe, expect, it, vi } from 'vitest'
import { recordPublications, type PublicationRecorder } from '../../durable/__tests__/support/commits'
import { crashWith } from '../../durable/__tests__/support/crash'
import { answer } from '../../durable/__tests__/support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHostOptions
} from '../../durable/__tests__/support/host'
import { waitFor, withTimeout } from '../../durable/__tests__/support/wait'
import { TestClient, type TestBinding } from './support/client'
import {
  makeRig,
  opsOf,
  pinRef,
  sequenceOf,
  settle,
  stream,
  type Rig,
  type RigOptions
} from './support/rig'

registerHostCleanup()

const S1: SyncTarget = { kind: 'session', sessionId: 's1' }
const S2: SyncTarget = { kind: 'session', sessionId: 's2' }

async function rigWith(
  options: TestHostOptions = {},
  rigOptions: Omit<RigOptions, 'pins'> = {}
): Promise<Rig> {
  const pins = pinRef()
  const t = await makeHost({ ...options, isPinned: pins.isPinned })
  return makeRig(t, { ...rigOptions, pins })
}

function clientOf(rig: Rig, id: string): TestClient {
  return new TestClient(id, rig.hub, rig.transport)
}

async function bound(client: TestClient, target: SyncTarget): Promise<TestBinding> {
  const binding = client.bind(target)
  await withTimeout(binding.ready(), 5000, `binding ready ${client.id}`)
  return binding
}

function types(updates: readonly ServiceProviderUpdate[]): string[] {
  return updates.map((update) => update.type)
}

/** 某个客户端某个订阅收到的帧 */
function framesOf(rig: Rig, clientId: string, subscriptionId?: string): ReturnType<Rig['transport']['sentTo']> {
  return rig.transport
    .sentTo(clientId)
    .filter((frame) => subscriptionId === undefined || frame.subscriptionId === subscriptionId)
}

function codeOf(error: unknown): string | undefined {
  return error instanceof RemoteServiceError ? error.code : undefined
}

describe('P3-04 · SyncHub', () => {
  it('P3-04-01 · one client, round trip', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    const a = await bound(clientOf(rig, 'A'), S1)
    expect(a.value()).toEqual(projector.state.value)

    stream.answer(projector.state, ['He', 'llo', ' world'], 7)
    await settle()
    expect(a.value()).toEqual(projector.state.value)
    expect((a.value() as { messages: ChatMessage[] }).messages.at(-1)?.content).toBe('Hello world')

    const sent = rig.transport.sent
    expect(sent.length).toBeGreaterThan(0)
    for (const { frame } of sent) {
      expect(Object.keys(frame).sort()).toEqual(['subscriptionId', 'target', 'update'])
      expect(frame.target).toEqual(S1)
      expect(frame.subscriptionId).toBe(a.subscriptionIds[0])
      expect(JSON.parse(JSON.stringify(frame))).toEqual(frame)
    }
    expect(a.errors).toEqual([])
    expect(rig.logs).toEqual([])
  })

  it('P3-04-02 · two clients: converge, independent encoders, no cross delivery', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    const clientA = clientOf(rig, 'A')
    const a = await bound(clientA, S1)
    stream.start(projector.state)
    for (const part of ['a', 'b', 'c']) stream.append(projector.state, part)
    await settle()
    expect(a.value()).toEqual(projector.state.value)

    const clientB = clientOf(rig, 'B')
    const b = await bound(clientB, S1)
    for (const part of ['d', 'e', 'f']) stream.append(projector.state, part)
    stream.commit(projector.state, 3)
    await settle()
    expect(a.value()).toEqual(projector.state.value)
    expect(b.value()).toEqual(projector.state.value)

    // 每个客户端的编码器各自定义路径（B 订阅时 A 早已定义过 content 的路径）
    const defines = (clientId: string): unknown[] =>
      framesOf(rig, clientId)
        .flatMap((frame) => (frame.update.type === 'state' ? frame.update.ops : []))
        .filter((op) => op[0] === '#')
        .map((op) => op[2])
    expect(defines('A')).toContainEqual(['live', 'message', 'content'])
    expect(defines('B')).toContainEqual(['live', 'message', 'content'])

    // 一个客户端只收到自己订阅的帧
    expect(clientA.frames.every((frame) => frame.subscriptionId === a.subscriptionIds[0])).toBe(true)
    expect(clientB.frames.every((frame) => frame.subscriptionId === b.subscriptionIds[0])).toBe(true)
    expect(clientA.orphans).toEqual([])
    expect(clientB.orphans).toEqual([])
  })

  it('P3-04-03 · late join: snapshot at subscribe, then only newer frames', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    const a = await bound(clientOf(rig, 'A'), S1)
    stream.start(projector.state)
    for (let index = 0; index < 10; index++) stream.append(projector.state, `p${index} `)
    await settle()

    const atSubscribe = projector.state.value
    const b = await bound(clientOf(rig, 'B'), S1)
    expect(b.snapshots[0]!.value).toEqual(atSubscribe)
    expect(b.value()).toEqual(atSubscribe)

    for (let index = 10; index < 15; index++) stream.append(projector.state, `p${index} `)
    stream.commit(projector.state, 4)
    await settle()
    expect(b.value()).toEqual(projector.state.value)
    expect(a.value()).toEqual(projector.state.value)
    const snapshotSequence = b.snapshots[0]!.sequence
    const sequences = framesOf(rig, 'B').flatMap((frame) =>
      frame.update.type === 'state' ? [frame.update.sequence] : []
    )
    expect(sequences.length).toBe(6)
    expect(sequences.every((sequence) => sequence > snapshotSequence)).toBe(true)
  })

  it('P3-04-04 · codec compression: numeric PathRefs, decoded ops equal the provider ops', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    const a = await bound(clientOf(rig, 'A'), S1)
    const provider = opsOf(projector.state)
    stream.start(projector.state)
    for (let index = 0; index < 50; index++) stream.append(projector.state, `w${index} `)
    await settle()

    const wire = framesOf(rig, 'A').flatMap((frame) =>
      frame.update.type === 'state' ? [frame.update.ops] : []
    )
    expect(wire.length).toBe(51)
    // 第 1 个 append 帧内联路径，第 2 个先定义再引用，之后只剩数字引用
    for (const ops of wire.slice(3)) {
      for (const op of ops) expect(typeof op[1]).toBe('number')
    }
    const decoded = a.updates.flatMap((update) => (update.type === 'state' ? [update.ops] : []))
    expect(decoded).toEqual(provider.map((entry) => entry.ops))
    expect(a.value()).toEqual(projector.state.value)
  })

  it('P3-04-05 · an update inside the subscribe window is buffered behind the reply (PIN-11)', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    // 一个常驻订阅让目标常在（每一轮都走「已有目标」的订阅路径）
    await bound(clientOf(rig, 'base'), S1)
    stream.start(projector.state)
    let inWindow = 0
    for (let k = 0; k < 12; k++) {
      const client = clientOf(rig, `W${k}`)
      const binding = client.bind(S1)
      const subscriptionId = binding.subscriptionIds[0]!
      for (let tick = 0; tick < k; tick++) await Promise.resolve()
      const repliedBefore = client.events.includes(`reply:${subscriptionId}`)
      stream.append(projector.state, `k${k}`)
      const sequence = sequenceOf(projector.state)
      await withTimeout(binding.ready(), 5000, `ready W${k}`)
      await settle()
      expect(binding.value()).toEqual(projector.state.value)
      const ordered = client.events.filter((event) => event.includes(subscriptionId))
      expect(ordered[0]).toBe(`reply:${subscriptionId}`)
      const gotFrame = framesOf(rig, `W${k}`).some(
        (frame) => frame.update.type === 'state' && frame.update.sequence === sequence
      )
      if (!repliedBefore && gotFrame) inWindow++
      expect(binding.errors).toEqual([])
    }
    // 至少有一轮的更新落在「端点已订阅、回复还没交出」的窗口里
    expect(inWindow).toBeGreaterThan(0)
    expect(rig.logs).toEqual([])
  })

  it('P3-04-06 · unsubscribe; duplicate subscription ids', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    const a = await bound(clientOf(rig, 'A'), S1)
    const b = await bound(clientOf(rig, 'B'), S1)
    const spy = vi.spyOn(rig.hub, 'invoke')
    await a.dispose()
    expect(a.controlCalls).toContain(`unsubscribe:${a.subscriptionIds[0]}`)
    expect(spy.mock.calls.some(([clientId, , call]) => {
      const c = call as { serviceId: string; member: string }
      return clientId === 'A' && c.serviceId === '$chord.service' && c.member === 'unsubscribe'
    })).toBe(true)
    spy.mockRestore()
    const before = framesOf(rig, 'A').length
    stream.answer(projector.state, ['x', 'y'], 2)
    await settle()
    expect(framesOf(rig, 'A').length).toBe(before)
    expect(b.value()).toEqual(projector.state.value)

    // 同一客户端同一订阅 id 还活着时再订阅 → 拒绝；另一个客户端用同一个 id 没问题
    const call = createServiceSubscribeCall('dup', CHAT_VIEW_SERVICE_ID, 'singleton')
    await rig.hub.invoke('C', S1, call)
    await expect(rig.hub.invoke('C', S1, call)).rejects.toThrow(/already active/)
    await expect(rig.hub.invoke('D', S1, call)).resolves.toBeDefined()
    await rig.hub.invoke('C', S1, createServiceUnsubscribeCall('dup'))
    // 退订之后同一个 id 可以再用
    await expect(rig.hub.invoke('C', S1, call)).resolves.toBeDefined()
  })

  it('P3-04-07 · replace on open: none → durable, the facade survives', async () => {
    const rig = await rigWith()
    const clientA = clientOf(rig, 'A')
    const a = await bound(clientA, S2)
    expect(a.value()).toEqual(emptySessionView('s2'))
    expect((a.value() as { capabilities: unknown }).capabilities).toEqual({
      send: true,
      rollback: false,
      continue: false
    })
    const facade = a.facade()
    const view = facade.view

    await rig.open('s2')
    await waitFor(() => (a.value() as { source?: string } | undefined)?.source === 'durable', 3000, 'durable')
    expect(types(a.updates)).toContain('replaced')
    const projector = rig.projectorOf('s2')!
    expect(a.value()).toEqual(projector.state.value)

    stream.answer(projector.state, ['hi', ' there'], 5)
    await settle()
    expect(a.value()).toEqual(projector.state.value)
    expect(a.facade()).toBe(facade)
    expect(a.facade().view).toBe(view)
    expect(types(a.updates)).not.toContain('unavailable')
  })

  it('P3-04-08 · replace on close (PIN-13), and back to live on reopen', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    const a = await bound(clientOf(rig, 'A'), S1)
    stream.start(projector.state)
    stream.append(projector.state, 'half')
    await settle()
    const last = projector.state.value

    await rig.t.host.close('s1')
    await settle()
    expect(types(a.updates)).toEqual(['state', 'state', 'replaced'])
    expect(a.value()).toEqual(last)
    expect(projector.disposed).toBe(true)
    // 运行状态停在最后投影的样子（没有合成的 interrupted）
    expect((a.value() as { run: unknown }).run).toEqual({ state: 'busy' })

    await rig.open('s1')
    await waitFor(() => a.updates.filter((update) => update.type === 'replaced').length === 2, 3000, 'second replace')
    const reopened = rig.projectorOf('s1')!
    expect(reopened).not.toBe(projector)
    expect(a.value()).toEqual(reopened.state.value)
    stream.append(reopened.state, ' more')
    stream.commit(reopened.state, 9)
    await settle()
    expect(a.value()).toEqual(reopened.state.value)
    expect(types(a.updates)).not.toContain('unavailable')
  })

  it('P3-04-09 · replace on clear (host.delete = destroy): the none view, then live again', async () => {
    // 清空走 host.delete（存储被删、会话还在）—— 清空后的会话没有存储，它的「新挂载」就是空视图
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    const a = await bound(clientOf(rig, 'A'), S1)
    stream.answer(projector.state, ['old'], 2)
    await settle()

    await rig.t.host.delete('s1')
    await settle()
    expect(types(a.updates).at(-1)).toBe('replaced')
    expect(a.value()).toEqual(emptySessionView('s1'))
    expect(types(a.updates)).not.toContain('unavailable')
    expect(rig.hub.hasSubscribers('s1')).toBe(true)

    await rig.open('s1')
    await waitFor(() => (a.value() as { source?: string }).source === 'durable', 3000, 'durable again')
    const fresh = rig.projectorOf('s1')!
    expect(fresh.state.value.messages).toEqual([])
    expect(a.value()).toEqual(fresh.state.value)
  })

  it('P3-04-10 · withdraw on delete (PIN-14)', async () => {
    const rig = await rigWith()
    await rig.projector('s1')
    const a = await bound(clientOf(rig, 'A'), S1)
    const b = await bound(clientOf(rig, 'B'), S1)
    expect(rig.hub.hasSubscribers('s1')).toBe(true)

    rig.hub.deleteSession('s1')
    expect(rig.hub.hasSubscribers('s1')).toBe(false)
    await rig.t.host.delete('s1')
    await settle()
    expect(types(a.updates).at(-1)).toBe('unavailable')
    expect(types(b.updates).at(-1)).toBe('unavailable')
    expect(a.value()).toBeUndefined()
    expect(rig.hub.hasSubscribers('s1')).toBe(false)

    // 再订阅 → chord 自己的 service_not_found
    const c = clientOf(rig, 'C').bind(S1)
    const error = await c.ready().then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(codeOf(error)).toBe('service_not_found')
    // 已被服务端撤掉的订阅，前端随后的退订不算错
    await expect(a.dispose()).resolves.toBeUndefined()
  })

  it('P3-04-10b · delete after the storage was destroyed: replaced, then unavailable', async () => {
    const rig = await rigWith()
    await rig.projector('s1')
    const a = await bound(clientOf(rig, 'A'), S1)
    await rig.t.host.delete('s1')
    rig.hub.deleteSession('s1')
    await settle()
    expect(types(a.updates)).toEqual(['replaced', 'unavailable'])
    expect(a.value()).toBeUndefined()
  })

  it('P3-04-11 · legacy target: static, undefined stripped, never opened', async () => {
    const raw = {
      messages: [
        {
          id: 'u-1',
          sessionId: 'L1',
          role: 'user',
          type: 'text',
          content: 'old question',
          model: '',
          createdAt: 1,
          metadata: { images: undefined }
        },
        {
          id: 'a-1',
          sessionId: 'L1',
          role: 'assistant',
          type: 'message',
          content: 'old answer',
          model: 'm',
          createdAt: 2,
          blocks: [{ type: 'text', text: 'old answer' }],
          metadata: { usage: undefined }
        }
      ] as unknown as ChatMessage[]
    }
    const rig = await rigWith({}, { legacy: (sessionId) => (sessionId === 'L1' ? raw : undefined) })
    const open = vi.spyOn(rig.t.host, 'open')
    const peek = vi.spyOn(rig.t.host, 'peek')
    const a = await bound(clientOf(rig, 'A'), { kind: 'session', sessionId: 'L1' })
    const value = a.value() as ReturnType<typeof emptySessionView>
    expect(value.source).toBe('legacy')
    expect(value.capabilities).toEqual({ send: false, rollback: false, continue: false })
    expect(value.messages).toEqual(JSON.parse(JSON.stringify(raw.messages)))
    expect(Object.keys(value.messages[0]!.metadata!)).toEqual([])
    expect(isJsonOnly(value)).toBe(true)
    await settle()
    expect(open).not.toHaveBeenCalled()
    expect(peek).not.toHaveBeenCalled()
    expect(rig.calls).toEqual([])
    expect(framesOf(rig, 'A')).toEqual([])
    expect(a.updates).toEqual([])
  })

  it('P3-04-12 · subscribing never opens storage', async () => {
    // 不存在的会话：peek（storageExists=false），从不 open / openStorage
    const rig = await rigWith()
    const open = vi.spyOn(rig.t.host, 'open')
    const missing = await bound(clientOf(rig, 'A'), { kind: 'session', sessionId: 's9' })
    expect(missing.value()).toEqual(emptySessionView('s9'))
    expect(rig.calls).toEqual(['peek:s9'])
    expect(rig.t.events.filter((event) => event.startsWith('open:'))).toEqual([])
    expect(open).not.toHaveBeenCalled()

    // 已存在、已关闭、被中断的会话：peek 打开 Harness，从不 open，不 resume，订阅不写任何东西
    const pins = pinRef()
    const { t } = await crashWith({ restart: { isPinned: pins.isPinned } })
    const crashed = makeRig(t, { pins })
    const crashedOpen = vi.spyOn(t.host, 'open')
    let recorder: PublicationRecorder | undefined
    crashed.onProjector = (session) => {
      recorder ??= recordPublications(session.harness)
    }
    const b = await bound(clientOf(crashed, 'B'), S1)
    await settle()
    expect(crashed.calls.filter((call) => call.startsWith('peek:'))).toEqual(['peek:s1'])
    expect(crashedOpen).not.toHaveBeenCalled()
    const session = t.host.get('s1')!
    expect(session.isInterrupted()).toBe(true)
    expect(recorder!.publications).toEqual([])
    expect(b.value()).toEqual(crashed.projectorOf('s1')!.state.value)

    // 封存之后：空视图，什么都不打开
    await t.host.closeAll()
    const opensBefore = t.events.filter((event) => event.startsWith('open:')).length
    const callsBefore = crashed.calls.length
    const sealed = await bound(clientOf(crashed, 'C'), S2)
    expect(sealed.value()).toEqual(emptySessionView('s2'))
    expect(crashed.calls.length).toBe(callsBefore)
    expect(t.events.filter((event) => event.startsWith('open:')).length).toBe(opensBefore)
  })

  it('P3-04-13 · pins: hasSubscribers, LRU exemption, agent targets pin their root', async () => {
    const agents = new Map([['a1', { sessionId: 's3', conversationId: 2 }]])
    const rig = await rigWith({ maxIdleOpen: 0 }, { agents })
    // 建存储（建 agent 期间先钉住，免得刚打开就被修剪），然后让它被 LRU 关掉
    const prime = async (sessionId: string): Promise<void> => {
      rig.t.pinned.add(sessionId)
      await primeRoot(await rig.open(sessionId))
      rig.t.pinned.delete(sessionId)
      await rig.open('s0')
      await waitFor(() => rig.t.host.get(sessionId) === undefined, 3000, `idle ${sessionId} closed by LRU`)
    }
    await prime('s1')

    expect(rig.hub.hasSubscribers('s1')).toBe(false)
    const a = await bound(clientOf(rig, 'A'), S1)
    expect(rig.hub.hasSubscribers('s1')).toBe(true)
    const b = await bound(clientOf(rig, 'B'), S1)
    expect(rig.hub.hasSubscribers('s1')).toBe(true)
    await a.dispose()
    expect(rig.hub.hasSubscribers('s1')).toBe(true)

    // 订阅着的空闲会话：忙 → 闲之后的修剪不关它
    const session = rig.t.host.get('s1')!
    expect(session).toBeDefined()
    rig.t.kit.queue(answer('ok'))
    expect(await withTimeout(session.submitUser('hi'), 5000, 'run')).toEqual({})
    await waitFor(() => rig.t.statesOf('s1').at(-1) === 'idle', 3000, 'idle again')
    await settle()
    expect(rig.t.host.get('s1')).toBe(session)
    expect(rig.t.events.filter((event) => event === 'close:s1')).toHaveLength(1)

    await b.dispose()
    expect(rig.hub.hasSubscribers('s1')).toBe(false)
    await rig.open('s2')
    await waitFor(
      () => rig.t.events.filter((event) => event === 'close:s1').length === 2,
      3000,
      's1 closed by the next trim'
    )

    // 派生 agent 的订阅钉住它的根会话（PIN-16）
    await prime('s3')
    const c = await bound(clientOf(rig, 'C'), { kind: 'agent', agentId: 'a1' })
    expect(rig.hub.hasSubscribers('s3')).toBe(true)
    await rig.open('s4')
    await settle()
    expect(rig.t.host.get('s3')).toBeDefined()
    await c.dispose()
    expect(rig.hub.hasSubscribers('s3')).toBe(false)
  })

  it('P3-04-14 · client gone releases everything (PIN-21)', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    await rig.projector('s2')
    const clientA = clientOf(rig, 'A')
    await bound(clientA, S1)
    await bound(clientA, S2)
    const b = await bound(clientOf(rig, 'B'), S1)
    expect(rig.transport.goneListeners('A')).toBe(1)

    rig.transport.gone('A')
    expect(rig.hub.hasSubscribers('s2')).toBe(false)
    expect(rig.hub.hasSubscribers('s1')).toBe(true)
    expect(rig.transport.goneListeners('A')).toBe(0)

    const sentToA = framesOf(rig, 'A').length
    stream.answer(projector.state, ['after', ' gone'], 4)
    await settle()
    expect(framesOf(rig, 'A').length).toBe(sentToA)
    expect(b.value()).toEqual(projector.state.value)

    // 第二次离开：无操作
    expect(() => rig.transport.gone('A')).not.toThrow()

    // 同一个 id 再来：全新的客户端
    const again = await bound(clientOf(rig, 'A'), S1)
    expect(again.value()).toEqual(projector.state.value)
    expect(rig.transport.goneListeners('A')).toBe(1)
    stream.answer(projector.state, ['fresh'], 5)
    await settle()
    expect(again.value()).toEqual(projector.state.value)
  })

  it('P3-04-15 · resync sends one reset on the same subscription (PIN-15)', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    const a = await bound(clientOf(rig, 'A'), S1)
    const b = await bound(clientOf(rig, 'B'), S1)
    stream.start(projector.state)
    stream.append(projector.state, 'one ')
    await settle()

    rig.transport.dropState.set('A', 5)
    for (let index = 0; index < 8; index++) stream.append(projector.state, `x${index} `)
    await settle()
    expect(rig.transport.dropped).toHaveLength(5)
    expect(a.value()).not.toEqual(projector.state.value)
    expect(b.value()).toEqual(projector.state.value)
    const bFramesBefore = framesOf(rig, 'B').length

    const subscriptionId = a.subscriptionIds[0]!
    expect(await rig.hub.resync('A', subscriptionId)).toBe(true)
    await settle()
    const resets = framesOf(rig, 'A', subscriptionId).filter((frame) => frame.update.type === 'reset')
    expect(resets).toHaveLength(1)
    expect(a.value()).toEqual(projector.state.value)
    expect(a.subscriptionIds).toEqual([subscriptionId])

    stream.append(projector.state, 'tail')
    stream.commit(projector.state, 6)
    await settle()
    expect(a.value()).toEqual(projector.state.value)
    const errorsAfterReset = a.errors.length
    stream.answer(projector.state, ['next'], 7)
    await settle()
    expect(a.errors.length).toBe(errorsAfterReset)
    expect(a.value()).toEqual(projector.state.value)

    // B 什么额外的都没收到：只有那 5 次（2 + 3 次）变更的 state 帧
    const bAfter = framesOf(rig, 'B').slice(bFramesBefore)
    expect(bAfter.every((frame) => frame.update.type === 'state')).toBe(true)
    expect(bAfter).toHaveLength(2 + 3)
    expect(b.value()).toEqual(projector.state.value)
    expect(await rig.hub.resync('A', 'no-such-subscription')).toBe(false)
  })

  it('P3-04-16 · agent target', async () => {
    const agents = new Map([['a1', { sessionId: 's1', conversationId: 2 }]])
    const rig = await rigWith({}, { agents })
    await rig.open('s1')
    const a = await bound(clientOf(rig, 'A'), { kind: 'agent', agentId: 'a1' })
    const child = rig.agentProjectorOf('a1')!
    expect(a.value()).toEqual(child.state.value)
    expect(Object.keys(a.value()!).sort()).toEqual(
      ['agentId', 'context', 'conversationId', 'live', 'messages', 'run', 'sessionId', 'toolRuns', 'v'].sort()
    )
    stream.start(child.state)
    stream.append(child.state, 'child ')
    stream.append(child.state, 'streams')
    await settle()
    expect(a.value()).toEqual(child.state.value)
    const appends = a.updates
      .flatMap((update) => (update.type === 'state' ? update.ops : []))
      .filter((op) => op[0] === 'a')
    expect(appends).toContainEqual(['a', ['live', 'message', 'blocks', 0, 'text'], 'streams'])

    // 子对话结束：订阅照样可读
    stream.commit(child.state, 11)
    await settle()
    expect(a.value()).toEqual(child.state.value)
    expect((a.value() as { run: unknown }).run).toEqual({ state: 'idle' })

    // 不认识的 agent → service_not_found（PIN-16）
    const unknown = clientOf(rig, 'B').bind({ kind: 'agent', agentId: 'nobody' })
    const error = await unknown.ready().then(
      () => undefined,
      (reason: unknown) => reason
    )
    expect(codeOf(error)).toBe('service_not_found')
    expect(rig.hub.hasSubscribers('s1')).toBe(true)
  })

  it('P3-04-17 · send failures are contained (PIN-12)', async () => {
    const rig = await rigWith()
    const projector = await rig.projector('s1')
    await bound(clientOf(rig, 'A'), S1)
    const b = await bound(clientOf(rig, 'B'), S1)
    const opsBefore = framesOf(rig, 'B').length
    rig.transport.throwFor.add('A')
    expect(() => stream.answer(projector.state, ['a', 'b', 'c'], 3)).not.toThrow()
    await settle()
    expect(b.value()).toEqual(projector.state.value)
    expect(framesOf(rig, 'B').length - opsBefore).toBe(5)
    expect(rig.logs.some((line) => line.includes('send failed client=A'))).toBe(true)

    // 异步拒绝同样只记日志
    rig.transport.throwFor.delete('A')
    rig.transport.rejectFor.add('A')
    const logged = rig.logs.length
    expect(() => stream.answer(projector.state, ['d'], 4)).not.toThrow()
    await settle()
    expect(rig.logs.length).toBeGreaterThan(logged)
    expect(b.value()).toEqual(projector.state.value)

    // 会话的提交线不受影响：真的跑一轮
    const session = rig.t.host.get('s1')!
    await primeRoot(session)
    rig.t.kit.queue(answer('fine'))
    expect(await withTimeout(session.submitUser('go'), 5000, 'run')).toEqual({})
  })

  it('P3-04-18 · invalid calls', async () => {
    const rig = await rigWith()
    const catalogue = createServiceCatalogueCall()
    await expect(rig.hub.invoke('A', { kind: 'monitor', id: 'x' }, catalogue)).rejects.toThrow(TypeError)
    await expect(rig.hub.invoke('A', { kind: 'session', sessionId: '' }, catalogue)).rejects.toThrow(
      TypeError
    )
    await expect(rig.hub.invoke('', S1, catalogue)).rejects.toThrow(TypeError)
    await expect(rig.hub.invoke('A', S1, { serviceId: 'x' })).rejects.toThrow(TypeError)

    const member = (name: string): unknown => ({ serviceId: CHAT_VIEW_SERVICE_ID, member: name, args: [] })
    const viewError = await rig.hub.invoke('A', S1, member('view')).catch((error: unknown) => error)
    expect(codeOf(viewError)).toBe('service_member_mismatch')
    const unknownError = await rig.hub.invoke('A', S1, member('nope')).catch((error: unknown) => error)
    expect(codeOf(unknownError)).toBe('service_member_not_found')
    const otherService = await rig.hub
      .invoke('A', S1, createServiceSubscribeCall('x1', 'other.service', 'singleton'))
      .catch((error: unknown) => error)
    expect(codeOf(otherService)).toBe('service_not_allowed')
    const keyed = await rig.hub
      .invoke('A', S1, createServiceSubscribeCall('x2', CHAT_VIEW_SERVICE_ID, 'keyed'))
      .catch((error: unknown) => error)
    expect(codeOf(keyed)).toBe('service_mode_mismatch')

    expect(await rig.hub.invoke('A', S1, catalogue)).toEqual([
      { serviceId: 'shuvix.chat.view', mode: 'singleton' }
    ])
    // 这些调用都不碰会话
    expect(rig.calls).toEqual([])
    expect(rig.hub.hasSubscribers('s1')).toBe(false)
  })

  it('P3-04-19 · hub dispose', async () => {
    const rig = await rigWith()
    await rig.projector('s1')
    await rig.projector('s2')
    const clientA = clientOf(rig, 'A')
    const a1 = await bound(clientA, S1)
    const a2 = await bound(clientA, S2)
    const b = await bound(clientOf(rig, 'B'), S1)
    expect(rig.hookListeners()).toBe(2)

    rig.hub.dispose()
    await settle()
    for (const binding of [a1, a2, b]) {
      expect(types(binding.updates).at(-1)).toBe('unavailable')
      expect(binding.value()).toBeUndefined()
    }
    expect(rig.hookListeners()).toBe(0)
    expect(rig.transport.goneListeners()).toBe(0)
    expect(rig.hub.hasSubscribers('s1')).toBe(false)
    await expect(rig.hub.invoke('A', S1, createServiceCatalogueCall())).rejects.toThrow(/disposed/)
    // 投影器租约都还了
    expect(rig.projectorOf('s1')).toBeUndefined()
    expect(rig.projectorOf('s2')).toBeUndefined()
    // 之后的宿主钩子无副作用
    await rig.t.host.close('s1')
    expect(rig.logs).toEqual([])
  })

  it('P3-04-20 · Electron-free hub, browser-safe client', () => {
    const importsOf = (file: string): string[] =>
      [...readFileSync(join(__dirname, file), 'utf8').matchAll(/(?:from|import)\s+'([^']+)'/g)].map(
        (match) => match[1]!
      )
    const forbidden = /^(electron|node:|fs$|path$|fs\/|original-fs)/
    for (const file of ['../syncHub.ts', '../services.ts']) {
      const imports = importsOf(file)
      expect(imports.length).toBeGreaterThan(0)
      expect(imports.filter((specifier) => forbidden.test(specifier))).toEqual([])
    }
    const client = importsOf('./support/client.ts')
    expect(
      client.filter(
        (specifier) =>
          specifier !== '@earendil-works/chord' &&
          specifier !== '@earendil-works/chord/context' &&
          !specifier.startsWith('@shuvix/chat-protocol/')
      )
    ).toEqual([])
  })
})
