/**
 * Chrome 侧边栏的视图同步链路表（`frontend/chrome/chromeLinks.ts`，pi 1.2 / chord2）—— 桥事件 `sync.link
 * {panelId, link, frame}` ⇄ 每个侧边栏一条（或先后几条）chord `FrameLink`：
 *
 *   CL-1  `hello` 建链路，`accept` 恰一次；主体 `{kind:'chrome', installId, runId, connId, tabId}` 取自连接与 panelId，
 *         帧 / 参数里自称的什么都不算
 *   CL-2  服务端的帧 → `conn.emit('sync.link', {panelId, link, frame})`
 *   CL-3  形状不对一律丢、不建链路：panelId、链路 id（空 / 非字符串 / 超 200 字符）、帧不是对象、连接没就绪 / 没 info
 *   CL-4  没有 `hello` 打头的帧（含 SW 替已关的链路补的那帧 bye）→ 丢
 *   CL-5  同一个 id 再来 `hello` → 旧链路结束（不发 bye），新的接上
 *   CL-6  侧边栏转来的 bye → 链路结束、`linkCount` 降、服务端放掉持有与钉住
 *   CL-7  `closeConnection` → 这条连接的链路全部结束、不发帧；别的连接不动；再调一次无事
 *   CL-8  每条连接的链路数上限（超了拒并告警；有链路结束就腾出名额；按连接算）
 *   CL-9  发帧时连接没就绪 / `emit` 抛错 → 链路以 `transport error` 结束，什么也不抛
 *   CL-10 一条连接上的两个侧边栏：主体不同（tabId）、各自只收自己持有的帧、一个放手不碍另一个
 *   CL-11 两个侧边栏用同一个链路 id：两条不同的链路（按侧边栏分键），都活着
 *   CL-12 带着别的侧边栏 panelId 的帧（同一个链路 id）落不进这个侧边栏的链路
 *
 * CL-1…5、7…9、11、12 的 `accept` 是记录器（链路就是 FrameLink，帧与关闭都记下）；CL-6 / CL-10 接**真的**视图服务端
 * （agent-runtime 的 `viewServer`，会话宿主是 viewRig 的假宿主），侧边栏里是**真的** chat-ui syncClient，中间是
 * `support/fakeSw` 扮演的 SW。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Frame, Link } from '@earendil-works/chord'
import type { ViewPrincipal, ViewServer } from '@shuvix/agent-runtime'
import type { SyncLinkChannel, SyncTarget } from '@shuvix/chat-protocol/sync'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'
import { createChromeLinkHub, MAX_LINKS_PER_CONNECTION, type ChromeLinkHub } from '../chromeLinks'
import { FakeConn, FakeSw } from './support/fakeSw'
import {
  fakeViewHost,
  serverFor,
  settle,
  until,
  type FakeViewHost
} from '../../../../../../../packages/agent-runtime/src/sync/__tests__/support/viewRig'
import {
  createSyncClient,
  type SyncClient
} from '../../../../../../../packages/chat-ui/src/sync/syncClient'

const HELLO = { t: 'hello', name: 'client:tab5', kind: 'client', epoch: 0 }
const BYE = { t: 'bye', reason: 'side panel closed' }

interface Accepted {
  readonly link: Link
  readonly principal: ViewPrincipal
  /** 交给链路接收方的帧 */
  readonly frames: unknown[]
  /** 链路结束的原因 */
  readonly closes: string[]
}

/** 链路表 + 记录型 accept */
function recordingHub(max?: number): {
  hub: ChromeLinkHub
  accepted: Accepted[]
  warnings: string[]
} {
  const accepted: Accepted[] = []
  const warnings: string[] = []
  const hub = createChromeLinkHub({
    accept: (link, principal) => {
      const entry: Accepted = { link, principal, frames: [], closes: [] }
      link.receive((frame: Frame) => entry.frames.push(frame))
      link.onClose((reason) => entry.closes.push(reason))
      accepted.push(entry)
    },
    logger: { warn: (message) => warnings.push(message) },
    ...(max === undefined ? {} : { maxLinksPerConnection: max })
  })
  return { hub, accepted, warnings }
}

const recv = (
  hub: ChromeLinkHub,
  conn: FakeConn,
  panelId: unknown,
  link: unknown,
  frame: unknown
): void => hub.receive(conn, { panelId, link, frame })

// ─── 真服务端的用例 ─────────────────────────────────────

let servers: ViewServer[] = []
let clients: SyncClient[] = []

afterEach(async () => {
  for (const client of clients) client.dispose()
  for (const server of servers) await server.dispose().catch(() => undefined)
  clients = []
  servers = []
})

/** 真的视图服务端 + 链路表；accept 时记下主体 */
function liveRig(): {
  host: FakeViewHost
  server: ViewServer
  hub: ChromeLinkHub
  principals: ViewPrincipal[]
} {
  const host = fakeViewHost()
  const server = serverFor(host)
  servers.push(server)
  const principals: ViewPrincipal[] = []
  const hub = createChromeLinkHub({
    accept: (link, principal) => {
      principals.push(principal)
      server.accept(link, principal)
    }
  })
  return { host, server, hub, principals }
}

function clientOn(channel: SyncLinkChannel, prefix: string): SyncClient {
  const client = createSyncClient({
    channel,
    idPrefix: prefix,
    reconnectDelayMs: 5,
    logger: { warn: () => {} }
  })
  clients.push(client)
  return client
}

const session = (sessionId: string): SyncTarget => ({ kind: 'session', sessionId })

// ─── CL-1 / CL-2 ───────────────────────────────────────

describe('CL-1 hello 建链路：主体由这里盖章', () => {
  it('CL-1 panel:5 上的 hello → accept 恰一次，主体取自 conn.info / conn.id / panelId', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1', { installId: 'inst-A', runId: 'run-A' })
    // 帧与参数里自称的身份都是假的：一个也不许进主体
    const forged = {
      ...HELLO,
      installId: 'evil',
      runId: 'evil',
      tabId: 9,
      principal: { kind: 'window', webContentsId: 1 }
    }
    hub.receive(conn, {
      panelId: 'panel:5',
      link: 'L1',
      frame: forged,
      installId: 'evil',
      runId: 'evil',
      connId: 'evil',
      tabId: 9,
      kind: 'window'
    })
    expect(accepted).toHaveLength(1)
    expect(accepted[0].principal).toStrictEqual({
      kind: 'chrome',
      installId: 'inst-A',
      runId: 'run-A',
      connId: 'c1',
      tabId: 5
    })
    // hello 本身交给了链路（chord 要读它）
    expect(accepted[0].frames).toEqual([forged])
    expect(hub.linkCount('c1')).toBe(1)
    expect(hub.linkCount()).toBe(1)

    // 同一条链路的后续帧：不再 accept
    recv(hub, conn, 'panel:5', 'L1', { t: 'ping', n: 1 })
    expect(accepted).toHaveLength(1)
    expect(accepted[0].frames).toEqual([forged, { t: 'ping', n: 1 }])
  })

  it('CL-1 主体按建链路那一刻的连接取：换一条连接、换一个侧边栏，主体跟着变', () => {
    const { hub, accepted } = recordingHub()
    const c1 = new FakeConn('c1', { installId: 'i1', runId: 'r1' })
    const c2 = new FakeConn('c2', { installId: 'i2', runId: 'r2' })
    recv(hub, c1, 'panel:5', 'L1', HELLO)
    recv(hub, c2, 'panel:12', 'L1', HELLO)
    expect(accepted.map((a) => a.principal)).toStrictEqual([
      { kind: 'chrome', installId: 'i1', runId: 'r1', connId: 'c1', tabId: 5 },
      { kind: 'chrome', installId: 'i2', runId: 'r2', connId: 'c2', tabId: 12 }
    ])
  })
})

describe('CL-2 服务端的帧 → 桥事件', () => {
  it('CL-2 link.send → conn.emit(sync.link, {panelId, link, frame})；close 先发 bye 再结束', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    recv(hub, conn, 'panel:5', 'L1', HELLO)
    recv(hub, conn, 'panel:7', 'L2', HELLO)
    accepted[0].link.send({ t: 'pong', n: 1 } as Frame)
    accepted[1].link.send({ t: 'pong', n: 2 } as Frame)
    expect(conn.emitted).toEqual([
      { name: 'sync.link', params: { panelId: 'panel:5', link: 'L1', frame: { t: 'pong', n: 1 } } },
      { name: 'sync.link', params: { panelId: 'panel:7', link: 'L2', frame: { t: 'pong', n: 2 } } }
    ])

    accepted[0].link.close('done')
    expect(conn.emitted.at(-1)).toEqual({
      name: 'sync.link',
      params: { panelId: 'panel:5', link: 'L1', frame: { t: 'bye', reason: 'done' } }
    })
    expect(accepted[0].closes).toEqual(['done'])
    expect(hub.linkCount('c1')).toBe(1)
  })
})

// ─── CL-3 / CL-4 ───────────────────────────────────────

describe('CL-3 形状不对：丢掉、不建链路', () => {
  const cases: Array<[string, (conn: FakeConn) => unknown]> = [
    ['panelId tab:1', () => ({ panelId: 'tab:1', link: 'L', frame: HELLO })],
    ['panelId panel:x', () => ({ panelId: 'panel:x', link: 'L', frame: HELLO })],
    ['panelId panel:-1', () => ({ panelId: 'panel:-1', link: 'L', frame: HELLO })],
    ['panelId panel:', () => ({ panelId: 'panel:', link: 'L', frame: HELLO })],
    ['panelId panel:1.5', () => ({ panelId: 'panel:1.5', link: 'L', frame: HELLO })],
    ['panelId 太大', () => ({ panelId: 'panel:99999999999999999999', link: 'L', frame: HELLO })],
    ['panelId 是数字', () => ({ panelId: 5, link: 'L', frame: HELLO })],
    ['没有 panelId', () => ({ link: 'L', frame: HELLO })],
    ['链路 id 为空', () => ({ panelId: 'panel:1', link: '', frame: HELLO })],
    ['链路 id 是数字', () => ({ panelId: 'panel:1', link: 7, frame: HELLO })],
    ['链路 id 是对象', () => ({ panelId: 'panel:1', link: {}, frame: HELLO })],
    ['没有链路 id', () => ({ panelId: 'panel:1', frame: HELLO })],
    ['链路 id 201 字符', () => ({ panelId: 'panel:1', link: 'x'.repeat(201), frame: HELLO })],
    ['帧是字符串', () => ({ panelId: 'panel:1', link: 'L', frame: 'hello' })],
    ['帧是 null', () => ({ panelId: 'panel:1', link: 'L', frame: null })],
    ['帧是数组', () => ({ panelId: 'panel:1', link: 'L', frame: [HELLO] })],
    ['帧是数字', () => ({ panelId: 'panel:1', link: 'L', frame: 5 })],
    ['没有帧', () => ({ panelId: 'panel:1', link: 'L' })],
    ['参数是 undefined', () => undefined],
    ['参数是 null', () => null],
    ['参数是字符串', () => 'panel:1'],
    [
      '连接没就绪',
      (conn) => {
        conn.ready = false
        return { panelId: 'panel:1', link: 'L', frame: HELLO }
      }
    ],
    [
      '连接没有 info',
      (conn) => {
        conn.info = undefined
        return { panelId: 'panel:1', link: 'L', frame: HELLO }
      }
    ]
  ]

  it.each(cases)('CL-3 %s', (_label, params) => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    expect(() => hub.receive(conn, params(conn))).not.toThrow()
    expect(accepted).toEqual([])
    expect(hub.linkCount()).toBe(0)
    expect(conn.emitted).toEqual([])
  })

  it('CL-3 链路 id 恰好 200 字符还收', () => {
    const { hub, accepted } = recordingHub()
    recv(hub, new FakeConn('c1'), 'panel:1', 'x'.repeat(200), HELLO)
    expect(accepted).toHaveLength(1)
  })

  it('CL-3 被丢掉的 hello 之后，同一个 id 的后续帧也落空（没有链路）', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    conn.ready = false
    recv(hub, conn, 'panel:1', 'L', HELLO)
    conn.ready = true
    recv(hub, conn, 'panel:1', 'L', { t: 'hold', id: 1 })
    expect(accepted).toEqual([])
    expect(hub.linkCount()).toBe(0)
  })
})

describe('CL-4 没有 hello 打头的帧', () => {
  it('CL-4 不认识的 id 上的非 hello 帧 → 丢', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    for (const frame of [{ t: 'hold', id: 1 }, { t: 'ping', n: 1 }, BYE, {}]) {
      recv(hub, conn, 'panel:5', 'L9', frame)
    }
    expect(accepted).toEqual([])
    expect(hub.linkCount()).toBe(0)
  })

  it('CL-4 SW 替已经关掉的链路补的 bye（以及之后的迟到帧）→ 丢，什么也不抛', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    recv(hub, conn, 'panel:5', 'L1', HELLO)
    recv(hub, conn, 'panel:5', 'L1', BYE)
    expect(accepted[0].closes).toEqual(['side panel closed'])
    expect(hub.linkCount()).toBe(0)

    expect(() => recv(hub, conn, 'panel:5', 'L1', BYE)).not.toThrow()
    recv(hub, conn, 'panel:5', 'L1', { t: 'ping', n: 2 })
    expect(accepted).toHaveLength(1)
    expect(accepted[0].closes).toEqual(['side panel closed'])
    expect(accepted[0].frames).toEqual([HELLO])
    expect(hub.linkCount()).toBe(0)
    expect(conn.emitted).toEqual([])
  })
})

// ─── CL-5 ─────────────────────────────────────────────

describe('CL-5 同一个 id 再来 hello', () => {
  it('CL-5 旧链路结束（不发 bye），新的接上；之后的帧只进新的', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    const hello2 = { ...HELLO, epoch: 1 }
    recv(hub, conn, 'panel:5', 'L1', HELLO)
    recv(hub, conn, 'panel:5', 'L1', hello2)
    expect(accepted).toHaveLength(2)
    expect(accepted[0].closes).toEqual(['superseded by a new hello'])
    expect(accepted[0].link.closed).toBe(true)
    expect(accepted[1].link.closed).toBe(false)
    expect(accepted[1].principal).toStrictEqual(accepted[0].principal)
    expect(conn.emitted).toEqual([])
    expect(hub.linkCount('c1')).toBe(1)

    recv(hub, conn, 'panel:5', 'L1', { t: 'ping', n: 1 })
    expect(accepted[0].frames).toEqual([HELLO])
    expect(accepted[1].frames).toEqual([hello2, { t: 'ping', n: 1 }])

    // 旧链路发帧：它已经结束了，什么也不出去
    accepted[0].link.send({ t: 'pong', n: 1 } as Frame)
    expect(conn.emitted).toEqual([])
    accepted[1].link.send({ t: 'pong', n: 2 } as Frame)
    expect(conn.syncEvents()).toEqual([
      { panelId: 'panel:5', link: 'L1', frame: { t: 'pong', n: 2 } }
    ])
  })
})

// ─── CL-6 ─────────────────────────────────────────────

describe('CL-6 侧边栏转来的 bye', () => {
  it('CL-6 链路结束、linkCount 降、服务端放掉持有与钉住', async () => {
    const { host, server, hub } = liveRig()
    const s5 = host.add('s5')
    const conn = new FakeConn('c1')
    const sw = new FakeSw(hub, conn)
    const panel = sw.panelChannel('panel:5')
    const client = clientOn(panel.channel, 'tab5')
    const sub = client.acquire<SessionView>(session('s5'))
    await until(() => sub.state().status === 'live', 'live')
    const root = s5.currentRoot()!
    expect(root.refs).toBe(1)
    expect(server.hasSubscribers('s5')).toBe(true)
    expect(hub.linkCount('c1')).toBe(1)
    const [linkId] = [...panel.links]

    // 侧边栏放手 → 客户端的空闲关闭发 bye → SW 转给桌面
    sub.release()
    await until(() => hub.linkCount('c1') === 0, 'link ended')
    expect(panel.sent.at(-1)).toEqual([linkId, { t: 'bye', reason: 'idle' }])
    await until(() => !server.hasSubscribers('s5'), 'unpinned')
    await until(() => root.refs === 0, 'lease released')
    expect(host.log).toEqual([`acquire:${root.id}`, `release:${root.id}`])
  })

  it('CL-6 SW 直接转来的 bye（侧边栏不再说话）同样收掉链路与持有', async () => {
    const { host, server, hub } = liveRig()
    const s5 = host.add('s5')
    const conn = new FakeConn('c1')
    const panel = new FakeSw(hub, conn).panelChannel('panel:5')
    const client = clientOn(panel.channel, 'tab5')
    const sub = client.acquire<SessionView>(session('s5'))
    await until(() => sub.state().status === 'live', 'live')
    const [linkId] = [...panel.links]
    const emittedBefore = conn.emitted.length

    recv(hub, conn, 'panel:5', linkId, BYE)
    expect(hub.linkCount('c1')).toBe(0)
    await until(() => !server.hasSubscribers('s5'), 'unpinned')
    expect(s5.currentRoot()?.refs ?? 0).toBe(0)
    // 对一条已经结束的链路，服务端不再发帧
    await settle()
    expect(conn.emitted.length).toBe(emittedBefore)
  })
})

// ─── CL-7 ─────────────────────────────────────────────

describe('CL-7 桥连接断开', () => {
  it('CL-7 closeConnection(c1) → c1 的链路全部结束、不发帧；c2 不动；再调一次无事', () => {
    const { hub, accepted } = recordingHub()
    const c1 = new FakeConn('c1')
    const c2 = new FakeConn('c2')
    recv(hub, c1, 'panel:5', 'L1', HELLO)
    recv(hub, c1, 'panel:7', 'L2', HELLO)
    recv(hub, c2, 'panel:5', 'L1', HELLO)
    expect(hub.linkCount()).toBe(3)

    hub.closeConnection('c1')
    expect(accepted[0].closes).toEqual(['Chrome disconnected'])
    expect(accepted[1].closes).toEqual(['Chrome disconnected'])
    expect(accepted[2].closes).toEqual([])
    expect(c1.emitted).toEqual([])
    expect(hub.linkCount('c1')).toBe(0)
    expect(hub.linkCount('c2')).toBe(1)
    expect(hub.linkCount()).toBe(1)

    expect(() => hub.closeConnection('c1')).not.toThrow()
    expect(() => hub.closeConnection('nope')).not.toThrow()
    expect(accepted[0].closes).toEqual(['Chrome disconnected'])
    expect(accepted[2].link.closed).toBe(false)

    // c2 的链路照常收发
    recv(hub, c2, 'panel:5', 'L1', { t: 'ping', n: 1 })
    expect(accepted[2].frames).toEqual([HELLO, { t: 'ping', n: 1 }])
    // c1 上的旧链路 id 的迟到帧：丢
    recv(hub, c1, 'panel:5', 'L1', { t: 'ping', n: 2 })
    expect(accepted[0].frames).toEqual([HELLO])
    expect(accepted).toHaveLength(3)
  })
})

// ─── CL-8 ─────────────────────────────────────────────

describe('CL-8 每条连接的链路数上限', () => {
  it('CL-8 缺省上限 256', () => {
    expect(MAX_LINKS_PER_CONNECTION).toBe(256)
  })

  it('CL-8 上限 2：第三个 hello 被拒并告警；有链路结束就腾出名额；按连接算', () => {
    const { hub, accepted, warnings } = recordingHub(2)
    const c1 = new FakeConn('c1')
    const c2 = new FakeConn('c2')
    recv(hub, c1, 'panel:5', 'L1', HELLO)
    recv(hub, c1, 'panel:7', 'L2', HELLO)
    recv(hub, c1, 'panel:5', 'L3', HELLO)
    expect(accepted).toHaveLength(2)
    expect(hub.linkCount('c1')).toBe(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/connection c1 already has 2 links; refused one/)
    // 被拒的链路 id 上的后续帧：没有链路，丢
    recv(hub, c1, 'panel:5', 'L3', { t: 'hold', id: 1 })
    expect(accepted).toHaveLength(2)

    // 满着的时候同一个 id 再 hello：先收旧的再建新的，照样接上
    recv(hub, c1, 'panel:5', 'L1', HELLO)
    expect(accepted).toHaveLength(3)
    expect(accepted[0].closes).toEqual(['superseded by a new hello'])
    expect(hub.linkCount('c1')).toBe(2)

    // 别的连接有自己的名额
    recv(hub, c2, 'panel:5', 'L1', HELLO)
    recv(hub, c2, 'panel:7', 'L2', HELLO)
    expect(hub.linkCount('c2')).toBe(2)
    expect(warnings).toHaveLength(1)

    // c1 的一条链路结束 → 腾出一个名额
    recv(hub, c1, 'panel:7', 'L2', BYE)
    expect(hub.linkCount('c1')).toBe(1)
    recv(hub, c1, 'panel:5', 'L3', HELLO)
    expect(hub.linkCount('c1')).toBe(2)
    expect(accepted.at(-1)!.principal).toMatchObject({ connId: 'c1', tabId: 5 })
    recv(hub, c1, 'panel:5', 'L4', HELLO)
    expect(hub.linkCount('c1')).toBe(2)
    expect(warnings).toHaveLength(2)
  })
})

// ─── CL-9 ─────────────────────────────────────────────

describe('CL-9 发帧失败', () => {
  it('CL-9 连接没就绪时发帧 → transport error，不抛、不发', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    recv(hub, conn, 'panel:5', 'L1', HELLO)
    conn.ready = false
    expect(() => accepted[0].link.send({ t: 'ping', n: 1 } as Frame)).not.toThrow()
    expect(accepted[0].closes).toEqual(['transport error'])
    expect(conn.emitted).toEqual([])
    expect(hub.linkCount('c1')).toBe(0)
  })

  it('CL-9 emit 抛错 → transport error，不抛', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    recv(hub, conn, 'panel:5', 'L1', HELLO)
    conn.throwOnEmit = true
    expect(() => accepted[0].link.send({ t: 'ping', n: 1 } as Frame)).not.toThrow()
    expect(accepted[0].closes).toEqual(['transport error'])
    expect(hub.linkCount('c1')).toBe(0)
    // close 时发 bye 也失败：照样结束、不抛（已经结束了，什么也不做）
    expect(() => accepted[0].link.close('x')).not.toThrow()
  })
})

// ─── CL-10 ────────────────────────────────────────────

describe('CL-10 一条连接上的两个侧边栏', () => {
  it('CL-10 主体按 tabId 区分；各自只收自己持有的帧；一个放手不碍另一个', async () => {
    const { host, server, hub, principals } = liveRig()
    host.add('s5')
    const s7 = host.add('s7')
    const conn = new FakeConn('c1')
    const sw = new FakeSw(hub, conn)
    const p5 = sw.panelChannel('panel:5')
    const p7 = sw.panelChannel('panel:7')
    const client5 = clientOn(p5.channel, 'tab5')
    const client7 = clientOn(p7.channel, 'tab7')
    const a5 = client5.acquire<SessionView>(session('s5'))
    const a7 = client5.acquire<SessionView>(session('s7'))
    const b7 = client7.acquire<SessionView>(session('s7'))
    await until(
      () =>
        a5.state().status === 'live' &&
        a7.state().status === 'live' &&
        b7.state().status === 'live',
      'all live'
    )
    expect(principals).toStrictEqual([
      { kind: 'chrome', installId: 'i1', runId: 'r1', connId: 'c1', tabId: 5 },
      { kind: 'chrome', installId: 'i1', runId: 'r1', connId: 'c1', tabId: 7 }
    ])
    expect(hub.linkCount('c1')).toBe(2)
    // 桌面发出的每一帧都只寻址一个侧边栏；侧边栏 7 从没收到过 s5 的东西
    const links5 = new Set(p5.received.map(([link]) => link))
    const links7 = new Set(p7.received.map(([link]) => link))
    expect([...links5].every((link) => link.startsWith('tab5.'))).toBe(true)
    expect([...links7].every((link) => link.startsWith('tab7.'))).toBe(true)
    expect(JSON.stringify(p7.received)).not.toContain('"s5"')

    // 侧边栏 5 全部放手：它的链路收掉，s5 不再钉住；s7 还被侧边栏 7 看着
    a5.release()
    a7.release()
    await until(() => hub.linkCount('c1') === 1, 'panel 5 link closed')
    await until(() => !server.hasSubscribers('s5'), 's5 unpinned')
    expect(server.hasSubscribers('s7')).toBe(true)
    expect(b7.state().status).toBe('live')

    // 侧边栏 5 的链路已经关了：s7 之后的修订只到侧边栏 7
    const before5 = p5.received.length
    s7.root.change((draft) => {
      draft.run = { state: 'busy' }
    })
    await until(() => b7.value()?.run.state === 'busy', 'panel 7 still updates')
    await settle()
    expect(p5.received.length).toBe(before5)
  })
})

// ─── CL-11 / CL-12 ────────────────────────────────────

describe('CL-11 两个侧边栏用同一个链路 id', () => {
  it('CL-11 两条不同的链路（按侧边栏分键）：第二个 hello 不顶掉第一个，两条都活着、各收各的', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    recv(hub, conn, 'panel:5', 'L', HELLO)
    recv(hub, conn, 'panel:7', 'L', HELLO)
    expect(accepted).toHaveLength(2)
    expect(accepted[0].closes).toEqual([])
    expect(accepted[0].link.closed).toBe(false)
    expect(accepted.map((a) => a.principal.tabId)).toEqual([5, 7])
    expect(hub.linkCount('c1')).toBe(2)

    recv(hub, conn, 'panel:5', 'L', { t: 'ping', n: 5 })
    recv(hub, conn, 'panel:7', 'L', { t: 'ping', n: 7 })
    expect(accepted[0].frames).toEqual([HELLO, { t: 'ping', n: 5 }])
    expect(accepted[1].frames).toEqual([HELLO, { t: 'ping', n: 7 }])

    accepted[0].link.send({ t: 'pong', n: 5 } as Frame)
    accepted[1].link.send({ t: 'pong', n: 7 } as Frame)
    expect(conn.syncEvents()).toEqual([
      { panelId: 'panel:5', link: 'L', frame: { t: 'pong', n: 5 } },
      { panelId: 'panel:7', link: 'L', frame: { t: 'pong', n: 7 } }
    ])

    // 侧边栏 7 关掉自己那条：侧边栏 5 的照旧
    recv(hub, conn, 'panel:7', 'L', BYE)
    expect(accepted[1].link.closed).toBe(true)
    expect(accepted[0].link.closed).toBe(false)
    expect(hub.linkCount('c1')).toBe(1)
  })
})

describe('CL-12 带着别的侧边栏 panelId 的帧', () => {
  it('CL-12 同一个链路 id、别的 panelId：落不进这个侧边栏的链路（非 hello 丢掉、bye 关不掉它）', () => {
    const { hub, accepted } = recordingHub()
    const conn = new FakeConn('c1')
    recv(hub, conn, 'panel:5', 'L', HELLO)

    recv(hub, conn, 'panel:7', 'L', { t: 'hold', id: 1, input: { sessionId: 'x' } })
    recv(hub, conn, 'panel:7', 'L', BYE)
    expect(accepted).toHaveLength(1)
    expect(accepted[0].frames).toEqual([HELLO])
    expect(accepted[0].link.closed).toBe(false)
    expect(hub.linkCount('c1')).toBe(1)

    // 别的侧边栏用这个 id 说 hello：那是它自己的新链路，不碰侧边栏 5 的
    recv(hub, conn, 'panel:7', 'L', HELLO)
    expect(accepted).toHaveLength(2)
    expect(accepted[1].principal.tabId).toBe(7)
    expect(accepted[0].link.closed).toBe(false)
    expect(accepted[0].frames).toEqual([HELLO])
  })
})
