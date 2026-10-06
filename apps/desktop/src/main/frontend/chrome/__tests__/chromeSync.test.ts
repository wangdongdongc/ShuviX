/**
 * 视图同步的 Chrome 传输与侧边栏端到端（P3-09，docs/pi-durable/p3-0809-test-design.md）：
 *
 *   P3-09-06 Chrome 传输：帧 → `sync.frame {sessionId, frame}`（agent 目标的 sessionId 是根会话）；连接不在 /
 *            没就绪 / 认不出根会话 → 丢掉、不抛；超过 1 MB 的帧经**真的**桥连接分片，组装器原样拼回
 *   P3-09-07 客户端离开：连接断开（含被顶替）→ onClientGone 恰一次、hub 不再钉住；新连接是新客户端、拿新快照；
 *            登记时连接已经不在 → 之后的微任务里回调
 *   P3-09-12 一条连接上两个侧边栏：订阅 id 不撞（按标签页的前缀）、各看各的会话、一个退订不碰另一个
 *   P3-09-13 重连（PIN-10）：`resetAll` 之后新连接上一份新快照，旧订阅迟到的帧不落地，不向已经不在的客户端退订
 *   P3-09-14 侧边栏关了标签页还在（PIN-11）：SW 补发的退订一个来回就松开钉住；标签页关了 → `deleteSession`
 *            → 侧边栏的绑定报 unavailable、钉住松开
 *
 * 真的：SyncHub（agent-runtime）、路由传输 + Chrome 传输、chat-ui 的 syncClient；假的：会话（FakeSyncSession，
 * 用例自己改视图）与桥连接（记下推出的事件，再像 SW 那样按 sessionId 送给侧边栏）。分片那一条用真的
 * ChromeBridgeServer 与一条真的 unix socket。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceUnsubscribeCall, type JsonValue } from '@earendil-works/chord'
import { createSyncHub, type SyncHub, type SyncWireFrame } from '@shuvix/agent-runtime'
import {
  BridgeChunkAssembler,
  CHROME_BRIDGE_PROTOCOL,
  CHROME_NATIVE_MESSAGE_MAX_BYTES,
  type BridgeChunk,
  type BridgeMessage
} from '@shuvix/chat-protocol/chromeBridge'
import type { SyncChannel, SyncFrame, SyncTarget } from '@shuvix/chat-protocol/sync'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import {
  chromeClientId,
  chromeConnIdOf,
  createChromeSyncTransport,
  forgetAgentRoots,
  rememberAgentRoot,
  type ChromeSyncConnection
} from '../chromeSyncTransport'
import { createRoutingSyncTransport } from '../../sync/ipcSyncTransport'
import { ChromeBridgeServer } from '../../../services/chromeBridge/server'
import { FakeSyncHost, type FakeSyncSession } from '../../sync/__tests__/support/fakeSync'
import {
  createSyncClient,
  type SyncClient,
  type ViewSubscription
} from '../../../../../../../packages/chat-ui/src/sync/syncClient'

// ─── 假的桥连接与 SW ────────────────────────────────────

/** 一条桥连接：推出的事件记下来，并交给 SW（按 sessionId 分给侧边栏） */
class FakeConn implements ChromeSyncConnection {
  ready = true
  readonly emitted: Array<{ name: string; params: { sessionId: string; frame: unknown } }> = []
  constructor(
    readonly id: string,
    private readonly sw?: FakeServiceWorker
  ) {}
  emit(name: 'sync.frame', params: { sessionId: string; frame: unknown }): void {
    this.emitted.push({ name, params })
    // 过一遍 JSON：线上就是这样
    this.sw?.deliver(JSON.parse(JSON.stringify(params)) as { sessionId: string; frame: unknown })
  }
}

/** 连接表（产品里是 chromeBridge）：按 id 找、断开时通知 */
class FakeConnections {
  readonly byIdMap = new Map<string, FakeConn>()
  readonly closedListeners = new Set<(conn: FakeConn) => void>()
  add(conn: FakeConn): FakeConn {
    this.byIdMap.set(conn.id, conn)
    return conn
  }
  /** 连接断了（socket close）：不再就绪、从表里摘掉、通知每个监听器 */
  close(conn: FakeConn): void {
    conn.ready = false
    this.byIdMap.delete(conn.id)
    for (const listener of [...this.closedListeners]) listener(conn)
  }
  api = {
    byId: (id: string): FakeConn | undefined => this.byIdMap.get(id),
    onClosed: (listener: (conn: FakeConn) => void): (() => void) => {
      this.closedListeners.add(listener)
      return () => this.closedListeners.delete(listener)
    }
  }
}

/** SW 的那一半：按信封上的 sessionId 把帧送给挂着那条会话的侧边栏 */
class FakeServiceWorker {
  readonly panels = new Map<string, Set<(frame: SyncFrame) => void>>()
  readonly dropped: unknown[] = []
  deliver(params: { sessionId: string; frame: unknown }): void {
    const listeners = this.panels.get(params.sessionId)
    if (!listeners || listeners.size === 0) {
      this.dropped.push(params)
      return
    }
    for (const listener of [...listeners]) listener(params.frame as SyncFrame)
  }
  attach(sessionId: string, listener: (frame: SyncFrame) => void): () => void {
    let set = this.panels.get(sessionId)
    if (!set) {
      set = new Set()
      this.panels.set(sessionId, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }
}

const json = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)

/**
 * 一个侧边栏的同步渠道：`invoke` 经「当前连接」交给 hub（客户端 `chrome:<connId>`，JSON 往返），帧经 SW
 * 按会话送达。`conn` 可换（重连之后 SW 走的是新连接）
 */
interface Panel {
  readonly channel: SyncChannel
  readonly calls: Array<{ clientId: string; target: unknown; call: unknown }>
  conn: FakeConn
}

function panelChannel(
  hub: SyncHub,
  sw: FakeServiceWorker,
  conn: FakeConn,
  sessionId: string
): Panel {
  const panel: Panel = {
    calls: [],
    conn,
    channel: {
      invoke: async (target: SyncTarget, call: JsonValue) => {
        const clientId = chromeClientId(panel.conn.id)
        panel.calls.push({ clientId, target: json(target), call: json(call) })
        return json(await hub.invoke(clientId, json(target), json(call)))
      },
      onFrame: (callback) => sw.attach(sessionId, (frame) => callback(frame))
    }
  }
  return panel
}

/** 订阅调用里的订阅 id（chord 的 `$chord.service` subscribe：args[0]） */
const subscribedIds = (panel: Panel): string[] =>
  panel.calls
    .map((c) => c.call as { member?: string; args?: unknown[] })
    .filter((c) => c.member === 'subscribe')
    .map((c) => String(c.args?.[0]))

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick()
}

// ─── 装配 ───────────────────────────────────────────────

interface World {
  hub: SyncHub
  host: FakeSyncHost
  connections: FakeConnections
  sw: FakeServiceWorker
  clients: SyncClient[]
}

const worlds: World[] = []

function makeWorld(): World {
  const connections = new FakeConnections()
  const transport = createRoutingSyncTransport()
  transport.addRoute('chrome', createChromeSyncTransport({ connections: connections.api }))
  const host = new FakeSyncHost()
  const hub = createSyncHub({ host, transport })
  const world: World = { hub, host, connections, sw: new FakeServiceWorker(), clients: [] }
  worlds.push(world)
  return world
}

function client(world: World, panel: Panel, idPrefix: string): SyncClient {
  const c = createSyncClient({ channel: panel.channel, idPrefix, logger: { warn: () => {} } })
  world.clients.push(c)
  return c
}

const viewOf = (sub: ViewSubscription<SessionView>): SessionView | undefined => sub.value()

/** 用例改视图的记号：整条消息列表换成一条带这段文字的用户消息 */
function mark(session: FakeSyncSession, text: string): void {
  session.change((d) => {
    d.messages = [
      { id: `m-${text}`, role: 'user', type: 'text', content: text, timestamp: 1 } as never
    ]
  })
}
const markOf = (sub: ViewSubscription<SessionView>): string | undefined =>
  viewOf(sub)?.messages.at(-1)?.content

afterEach(() => {
  for (const world of worlds.splice(0)) {
    for (const c of world.clients) c.dispose()
    world.hub.dispose()
  }
  forgetAgentRoots('c1')
})

// ─── P3-09-06 ───────────────────────────────────────────

describe('P3-09-06 Chrome 传输', () => {
  const frameOf = (target: SyncTarget): SyncWireFrame =>
    ({ target, subscriptionId: 'tab5.n#1', update: { type: 'state' } }) as unknown as SyncWireFrame

  it('P3-09-06 会话目标 → 那条连接上的 sync.frame {sessionId: 目标会话, frame}（帧原样）', () => {
    const connections = new FakeConnections()
    const c1 = connections.add(new FakeConn('c1'))
    const c2 = connections.add(new FakeConn('c2'))
    const transport = createChromeSyncTransport({ connections: connections.api })
    const frame = frameOf({ kind: 'session', sessionId: 's1' })
    transport.send('chrome:c1', frame)
    expect(c1.emitted).toEqual([{ name: 'sync.frame', params: { sessionId: 's1', frame } }])
    expect(c1.emitted[0].params.frame).toBe(frame)
    expect(c2.emitted).toEqual([])
  })

  it('P3-09-06 agent 目标 → sessionId 是核对归属时记下的根会话；没记过 → 丢掉', () => {
    const connections = new FakeConnections()
    const c1 = connections.add(new FakeConn('c1'))
    const transport = createChromeSyncTransport({ connections: connections.api })
    const frame = frameOf({ kind: 'agent', agentId: 'a1' })
    transport.send('chrome:c1', frame)
    expect(c1.emitted).toEqual([])
    rememberAgentRoot('c1', 'a1', 'root-s')
    transport.send('chrome:c1', frame)
    expect(c1.emitted).toEqual([{ name: 'sync.frame', params: { sessionId: 'root-s', frame } }])
  })

  it('P3-09-06 连接不在 / 没就绪 / 不是 chrome 客户端 / emit 抛错 → 丢掉，从不抛', () => {
    const connections = new FakeConnections()
    const c1 = connections.add(new FakeConn('c1'))
    const logger = { warn: vi.fn(), error: vi.fn() }
    const transport = createChromeSyncTransport({ connections: connections.api, logger })
    const frame = frameOf({ kind: 'session', sessionId: 's1' })
    expect(() => transport.send('chrome:nope', frame)).not.toThrow()
    expect(() => transport.send('ipc:7', frame)).not.toThrow()
    expect(() => transport.send('garbage', frame)).not.toThrow()
    c1.ready = false
    expect(() => transport.send('chrome:c1', frame)).not.toThrow()
    expect(c1.emitted).toEqual([])
    c1.ready = true
    c1.emit = () => {
      throw new Error('socket gone')
    }
    expect(() => transport.send('chrome:c1', frame)).not.toThrow()
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('P3-09-06 客户端 id 的两头：chrome:<connId> ⇄ connId', () => {
    expect(chromeClientId('abc')).toBe('chrome:abc')
    expect(chromeConnIdOf('chrome:abc')).toBe('abc')
    expect(chromeConnIdOf('ipc:3')).toBeUndefined()
    expect(chromeConnIdOf('chrome:')).toBeUndefined()
  })

  describe('经真的桥连接', () => {
    let dir = ''
    let server: ChromeBridgeServer | undefined
    let socket: Socket | undefined

    afterEach(() => {
      socket?.destroy()
      server?.stop()
      if (dir) rmSync(dir, { recursive: true, force: true })
      socket = undefined
      server = undefined
    })

    it('P3-09-06 超过 1 MB 的帧：每一行都在原生消息上限以内，扩展的组装器原样拼回', async () => {
      dir = mkdtempSync(join(tmpdir(), 'p309-'))
      const sockPath = join(dir, 's.sock')
      server = new ChromeBridgeServer()
      await server.start({ socketPath: sockPath, getToken: () => 'tok' })

      // 扮演本地组件：鉴权、握手，然后按行收
      const lines: string[] = []
      let rest = ''
      socket = connect(sockPath)
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        rest += chunk
        const parts = rest.split('\n')
        rest = parts.pop() ?? ''
        lines.push(...parts.filter((p) => p.length > 0))
      })
      socket.write(JSON.stringify({ auth: 'tok' }) + '\n')
      await vi.waitFor(() => expect(lines).toContain('{"auth":"ok"}'), { timeout: 5000 })
      socket.write(
        JSON.stringify({
          type: 'hello',
          protocol: CHROME_BRIDGE_PROTOCOL,
          extensionVersion: '0.0.0',
          installId: 'i1',
          runId: 'r1',
          browser: 'Chrome',
          openTabIds: []
        }) + '\n'
      )
      await vi.waitFor(() => expect(server!.connectionFor('i1')).toBeDefined(), { timeout: 5000 })
      const conn = server.connectionFor('i1')!
      const bridge = server
      expect(bridge.connectionById(conn.id)).toBe(conn)
      expect(bridge.connectionById('nope')).toBeUndefined()

      const transport = createChromeSyncTransport({
        connections: {
          byId: (id) => bridge.connectionById(id),
          onClosed: (listener) => bridge.onConnectionClosed(listener)
        }
      })
      // 1.3 MB 的中日韩文字（UTF-8 三字节）+ 一个 emoji
      const big = '漢'.repeat(430_000) + '😀'
      const frame = {
        target: { kind: 'session', sessionId: 's-big' },
        subscriptionId: 'tab5.n#1',
        update: { type: 'state', ops: [['r', { text: big }]] }
      } as unknown as SyncWireFrame
      const from = lines.length
      transport.send(chromeClientId(conn.id), frame)

      const assembler = new BridgeChunkAssembler()
      const whole = await vi.waitFor(
        () => {
          let out: BridgeMessage | null = null
          for (const line of lines.slice(from)) {
            const message = JSON.parse(line) as BridgeMessage
            if (message.type === 'chunk') out = assembler.push(message as BridgeChunk) ?? out
          }
          expect(out).not.toBeNull()
          return out!
        },
        { timeout: 5000 }
      )
      const sent = lines.slice(from)
      expect(sent.length).toBeGreaterThanOrEqual(2)
      for (const line of sent) {
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(CHROME_NATIVE_MESSAGE_MAX_BYTES)
        expect((JSON.parse(line) as BridgeMessage).type).toBe('chunk')
      }
      expect(whole).toEqual({
        type: 'event',
        name: 'sync.frame',
        params: { sessionId: 's-big', frame: JSON.parse(JSON.stringify(frame)) }
      })
    })
  })
})

// ─── P3-09-07 ───────────────────────────────────────────

describe('P3-09-07 客户端离开', () => {
  it('P3-09-07 连接断开 → onClientGone 恰一次（第二次断开事件不再叫）；注销之后不叫', () => {
    const connections = new FakeConnections()
    const c1 = connections.add(new FakeConn('c1'))
    const c2 = connections.add(new FakeConn('c2'))
    const transport = createChromeSyncTransport({ connections: connections.api })
    const gone1 = vi.fn()
    const gone2 = vi.fn()
    transport.onClientGone('chrome:c1', gone1)
    const off2 = transport.onClientGone('chrome:c2', gone2) as () => void
    off2()
    // 别的连接断开不算
    connections.close(c2)
    expect(gone1).not.toHaveBeenCalled()
    connections.close(c1)
    for (const listener of connections.closedListeners) listener(c1)
    expect(gone1).toHaveBeenCalledTimes(1)
    expect(gone2).not.toHaveBeenCalled()
    // 监听器摘干净了
    expect(connections.closedListeners.size).toBe(0)
  })

  it('P3-09-07 登记时连接已经不在 / 没就绪 → 回调在之后的微任务里（不在 onClientGone 里同步调）', async () => {
    const connections = new FakeConnections()
    const unready = connections.add(new FakeConn('c3'))
    unready.ready = false
    const transport = createChromeSyncTransport({ connections: connections.api })
    const gone = vi.fn()
    const goneUnready = vi.fn()
    transport.onClientGone('chrome:missing', gone)
    transport.onClientGone('chrome:c3', goneUnready)
    expect(gone).not.toHaveBeenCalled()
    expect(goneUnready).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(gone).toHaveBeenCalledTimes(1)
    expect(goneUnready).toHaveBeenCalledTimes(1)
    // 注销得早就不叫
    const late = vi.fn()
    const off = transport.onClientGone('chrome:missing', late) as () => void
    off()
    await Promise.resolve()
    expect(late).not.toHaveBeenCalled()
  })

  it('P3-09-07 真 hub：连接断开（或被新 hello 顶替）→ 不再钉住；新连接是新客户端，拿一份新快照', async () => {
    const w = makeWorld()
    const s1 = w.host.add('tab-s1')
    s1.change((d) => {
      d.messages = [{ id: 'm1', role: 'user', type: 'text', content: 'hi', timestamp: 1 } as never]
    })
    const c1 = w.connections.add(new FakeConn('c1', w.sw))
    const panel = panelChannel(w.hub, w.sw, c1, 'tab-s1')
    const sync = client(w, panel, 'tab5.a')
    const sub = sync.acquire<SessionView>({ kind: 'session', sessionId: 'tab-s1' })
    await vi.waitFor(() => expect(sub.state().status).toBe('live'))
    expect(w.hub.hasSubscribers('tab-s1')).toBe(true)
    expect(panel.calls.every((c) => c.clientId === 'chrome:c1')).toBe(true)

    // 新 hello 顶替：旧连接被关掉（socket close）
    w.connections.close(c1)
    await settle()
    expect(w.hub.hasSubscribers('tab-s1')).toBe(false)

    // 新连接上重订：新客户端 id、新快照（断开期间改过的内容也在）
    s1.change((d) => {
      d.messages = [
        ...d.messages,
        { id: 'm2', role: 'user', type: 'text', content: 'again', timestamp: 2 } as never
      ]
    })
    panel.conn = w.connections.add(new FakeConn('c2', w.sw))
    sync.resetAll()
    await vi.waitFor(() => expect(viewOf(sub)?.messages.map((m) => m.id)).toEqual(['m1', 'm2']))
    expect(w.hub.hasSubscribers('tab-s1')).toBe(true)
    const subscribes = panel.calls.filter(
      (c) => (c.call as { member?: string }).member === 'subscribe'
    )
    expect(subscribes.map((c) => c.clientId)).toEqual(['chrome:c1', 'chrome:c2'])
  })
})

// ─── P3-09-12 ───────────────────────────────────────────

describe('P3-09-12 一条连接上的两个侧边栏', () => {
  async function twoPanels(): Promise<{
    w: World
    sA: FakeSyncSession
    sB: FakeSyncSession
    p1: Panel
    p2: Panel
    sub1: ViewSubscription<SessionView>
    sub2: ViewSubscription<SessionView>
  }> {
    const w = makeWorld()
    const sA = w.host.add('sA')
    const sB = w.host.add('sB')
    const conn = w.connections.add(new FakeConn('c1', w.sw))
    const p1 = panelChannel(w.hub, w.sw, conn, 'sA')
    const p2 = panelChannel(w.hub, w.sw, conn, 'sB')
    const sub1 = client(w, p1, 'tab1.x').acquire<SessionView>({ kind: 'session', sessionId: 'sA' })
    const sub2 = client(w, p2, 'tab2.y').acquire<SessionView>({ kind: 'session', sessionId: 'sB' })
    await vi.waitFor(() => {
      expect(sub1.state().status).toBe('live')
      expect(sub2.state().status).toBe('live')
    })
    return { w, sA, sB, p1, p2, sub1, sub2 }
  }

  it('P3-09-12 同一个客户端（chrome:c1）下订阅 id 各带各的前缀、不撞；各看各的会话', async () => {
    const { sA, sB, p1, p2, sub1, sub2 } = await twoPanels()
    const ids1 = subscribedIds(p1)
    const ids2 = subscribedIds(p2)
    expect(ids1.every((id) => id.startsWith('tab1.x#'))).toBe(true)
    expect(ids2.every((id) => id.startsWith('tab2.y#'))).toBe(true)
    expect(new Set([...ids1, ...ids2]).size).toBe(ids1.length + ids2.length)
    expect([...p1.calls, ...p2.calls].every((c) => c.clientId === 'chrome:c1')).toBe(true)

    mark(sA, 'A page')
    mark(sB, 'B page')
    await vi.waitFor(() => {
      expect(markOf(sub1)).toBe('A page')
      expect(markOf(sub2)).toBe('B page')
    })
    expect(viewOf(sub1)?.sessionId).toBe('sA')
    expect(viewOf(sub2)?.sessionId).toBe('sB')
  })

  it('P3-09-12 一个侧边栏退订不碰另一个：sA 松开、sB 仍钉着、仍收得到更新', async () => {
    const { w, sB, sub1, sub2 } = await twoPanels()
    expect(sub1.release()).toBe(true)
    await settle()
    expect(w.hub.hasSubscribers('sA')).toBe(false)
    expect(w.hub.hasSubscribers('sB')).toBe(true)
    mark(sB, 'still here')
    await vi.waitFor(() => expect(markOf(sub2)).toBe('still here'))
    expect(sub2.state().status).toBe('live')
  })

  it('P3-09-12 反证：两个侧边栏用同一个前缀 → 同一个客户端下订阅 id 撞了，第二个订阅被 hub 拒绝', async () => {
    const w = makeWorld()
    w.host.add('sA')
    w.host.add('sB')
    const conn = w.connections.add(new FakeConn('c1', w.sw))
    const sub1 = client(w, panelChannel(w.hub, w.sw, conn, 'sA'), 'same').acquire<SessionView>({
      kind: 'session',
      sessionId: 'sA'
    })
    await vi.waitFor(() => expect(sub1.state().status).toBe('live'))
    const sub2 = client(w, panelChannel(w.hub, w.sw, conn, 'sB'), 'same').acquire<SessionView>({
      kind: 'session',
      sessionId: 'sB'
    })
    await vi.waitFor(() => expect(sub2.state().status).toBe('error'))
  })
})

// ─── P3-09-13 ───────────────────────────────────────────

describe('P3-09-13 重连之后重绑（PIN-10）', () => {
  it('P3-09-13 resetAll：不向已经不在的客户端退订；新连接上一份新快照；旧订阅迟到的帧不落地', async () => {
    const w = makeWorld()
    const s1 = w.host.add('tab-s1')
    const c1 = w.connections.add(new FakeConn('c1', w.sw))
    const panel = panelChannel(w.hub, w.sw, c1, 'tab-s1')
    const sync = client(w, panel, 'tab5.r')
    const sub = sync.acquire<SessionView>({ kind: 'session', sessionId: 'tab-s1' })
    await vi.waitFor(() => expect(sub.state().status).toBe('live'))
    // 快照之后的一次改动：经一帧到达（下面拿它当「旧订阅迟到的帧」）
    mark(s1, 'before')
    await vi.waitFor(() => expect(markOf(sub)).toBe('before'))
    expect(c1.emitted.length).toBeGreaterThan(0)
    const oldIds = subscribedIds(panel)
    const oldFrame = c1.emitted.at(-1)!.params.frame as SyncFrame

    // 桌面重启：旧连接没了；期间视图又变了
    w.connections.close(c1)
    await settle()
    mark(s1, 'after restart')
    panel.conn = w.connections.add(new FakeConn('c2', w.sw))
    const callsBefore = panel.calls.length
    sync.resetAll()
    await vi.waitFor(() => expect(markOf(sub)).toBe('after restart'))

    const after = panel.calls.slice(callsBefore)
    // 不发退订（旧客户端已经不在）；只在新连接上订了一次
    expect(after.filter((c) => (c.call as { member?: string }).member === 'unsubscribe')).toEqual(
      []
    )
    expect(after.map((c) => [c.clientId, (c.call as { member?: string }).member])).toEqual([
      ['chrome:c2', 'subscribe']
    ])
    expect(subscribedIds(panel).slice(oldIds.length)).not.toEqual(oldIds)

    // 旧订阅的一帧迟到（改写成别的标题）：订阅表里已经没有它，丢掉
    const stale = json(oldFrame) as SyncFrame & { update: unknown }
    w.sw.deliver({ sessionId: 'tab-s1', frame: stale })
    await settle()
    expect(markOf(sub)).toBe('after restart')
    expect(sub.state().status).toBe('live')
  })
})

// ─── P3-09-14 ───────────────────────────────────────────

describe('P3-09-14 侧边栏关了 / 标签页关了', () => {
  it('P3-09-14 SW 补发的退订（同一个客户端、同一个订阅 id）一个来回就松开钉住', async () => {
    const w = makeWorld()
    w.host.add('tab-s1')
    const conn = w.connections.add(new FakeConn('c1', w.sw))
    const panel = panelChannel(w.hub, w.sw, conn, 'tab-s1')
    const sub = client(w, panel, 'tab5.c').acquire<SessionView>({
      kind: 'session',
      sessionId: 'tab-s1'
    })
    await vi.waitFor(() => expect(sub.state().status).toBe('live'))
    expect(w.hub.hasSubscribers('tab-s1')).toBe(true)

    // 侧边栏页面没了（不会自己退订）；SW 替它退
    for (const id of subscribedIds(panel)) {
      await w.hub.invoke(
        'chrome:c1',
        { kind: 'session', sessionId: 'tab-s1' },
        json(createServiceUnsubscribeCall(id))
      )
    }
    expect(w.hub.hasSubscribers('tab-s1')).toBe(false)
    // 再退一次也无事（幂等）
    await expect(
      w.hub.invoke(
        'chrome:c1',
        { kind: 'session', sessionId: 'tab-s1' },
        json(createServiceUnsubscribeCall(subscribedIds(panel)[0]))
      )
    ).resolves.toBeUndefined()
  })

  it('P3-09-14 标签页关了 → deleteSession：侧边栏的绑定报 unavailable、不再钉住', async () => {
    const w = makeWorld()
    w.host.add('tab-s1')
    const conn = w.connections.add(new FakeConn('c1', w.sw))
    const panel = panelChannel(w.hub, w.sw, conn, 'tab-s1')
    const sub = client(w, panel, 'tab5.d').acquire<SessionView>({
      kind: 'session',
      sessionId: 'tab-s1'
    })
    await vi.waitFor(() => expect(sub.state().status).toBe('live'))
    w.hub.deleteSession('tab-s1')
    await vi.waitFor(() => expect(sub.state().status).toBe('unavailable'))
    expect(sub.value()).toBeUndefined()
    expect(w.hub.hasSubscribers('tab-s1')).toBe(false)
  })
})
