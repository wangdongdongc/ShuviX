/**
 * `frontend/network/networkLinks.ts` —— 网络客户端的视图同步链路表（server mode phase B §B2）：一条链路 id 的第一帧必须是
 * hello；同 id 再来 hello → 旧的收掉、建新的；主体由这里盖章；每条连接的链路数有上限；连接关掉 → 链路全部结束。
 * `accept` 记下（链路，主体），立刻 `link.receive` 收帧、`link.onClose` 记原因；连接是一个小对象（`isOpen` 可切、
 * `sendSync` 是 spy）。上限给 2。
 *
 *   NL-1  未知链路 id 的第一帧不是 hello → 丢掉：accept 不调，linkCount() 为 0
 *   NL-2  hello → accept 恰一次，主体恰是 {kind:'network', clientId, remoteAddress}（hello 里自称的 clientId 不算数）；
 *         hello 本身交给链路；linkCount 记一条
 *   NL-3  之后的帧按顺序交给链路
 *   NL-4  同 id 再来 hello：旧链路以 'superseded by a new hello' 结束、不发 bye；accept 拿到一条新链路；条数仍是 1；
 *         第二个 hello 只到新链路
 *   NL-5  上限 2：第三条链路的 hello 被拒（不 accept、warn 带连接 id 与链路 id），它之后的帧丢掉；一条链路因 bye 结束后
 *         新的 hello 照收；另一条连接有自己的 2 条
 *   NL-6  坏链路 id（数字、空串、201 字符）与坏帧（null、字符串、数组、数字）→ 丢掉、不 accept；200 字符的 id 可以
 *   NL-7  连接已经关了：连 hello 都丢掉
 *   NL-8  closeConnection：这条连接的链路都以 'network client disconnected'（或给的原因）结束，条数归零，别的连接不动；
 *         不认识的 id / 第二次调用无事
 *   NL-9  服务端 → 客户端：link.send(frame) → sendSync(linkId, frame)；连接关了 → 不调 sendSync，链路以 'transport error'
 *         结束；sendSync 抛 → 同样结束，不外抛
 *   NL-10 客户端 bye 结束的链路离开计数；那个 id 之后的非 hello 帧丢掉
 */
import type { Link } from '@earendil-works/chord'
import type { ViewPrincipal } from '@shuvix/agent-runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNetworkLinkHub,
  type NetworkLinkConnection,
  type NetworkLinkHub
} from '../networkLinks'

interface Accepted {
  link: Link
  principal: ViewPrincipal
  frames: unknown[]
  reasons: string[]
}

const HELLO = { t: 'hello', name: 'renderer', kind: 'client', epoch: 1 }

let accepted: Accepted[]
let accept: ReturnType<typeof vi.fn<(link: Link, principal: ViewPrincipal) => void>>
let logger: { warn: ReturnType<typeof vi.fn<(message: string) => void>> }
let hub: NetworkLinkHub

interface TestConnection extends NetworkLinkConnection {
  open: boolean
  sendSync: ReturnType<typeof vi.fn<(link: string, frame: unknown) => void>>
}

function connection(id = 'ws:1', remoteAddress = '192.168.1.9'): TestConnection {
  const conn: TestConnection = {
    id,
    remoteAddress,
    open: true,
    isOpen: () => conn.open,
    sendSync: vi.fn()
  }
  return conn
}

beforeEach(() => {
  accepted = []
  accept = vi.fn((link: Link, principal: ViewPrincipal) => {
    const entry: Accepted = { link, principal, frames: [], reasons: [] }
    accepted.push(entry)
    link.receive((frame) => entry.frames.push(frame))
    link.onClose((reason) => entry.reasons.push(reason))
  })
  logger = { warn: vi.fn() }
  hub = createNetworkLinkHub({ accept, logger, maxLinksPerConnection: 2 })
})

describe('NL-1 第一帧不是 hello', () => {
  it('NL-1 丢掉，不 accept', () => {
    hub.receive(connection(), 'L1', { t: 'sub' })
    expect(accept).not.toHaveBeenCalled()
    expect(hub.linkCount()).toBe(0)
  })
})

describe('NL-2 hello 建链路', () => {
  it('NL-2 accept 恰一次，主体由连接盖章；hello 交给链路；计数 1', () => {
    const conn = connection()
    hub.receive(conn, 'L1', { ...HELLO, clientId: 'evil' })
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accepted[0].principal).toStrictEqual({
      kind: 'network',
      clientId: 'ws:1',
      remoteAddress: '192.168.1.9'
    })
    expect(accepted[0].frames).toStrictEqual([{ ...HELLO, clientId: 'evil' }])
    expect(hub.linkCount('ws:1')).toBe(1)
    expect(hub.linkCount()).toBe(1)
  })
})

describe('NL-3 之后的帧', () => {
  it('NL-3 按顺序交给链路', () => {
    const conn = connection()
    hub.receive(conn, 'L1', HELLO)
    hub.receive(conn, 'L1', { t: 'sub', n: 1 })
    hub.receive(conn, 'L1', { t: 'sub', n: 2 })
    expect(accepted[0].frames).toStrictEqual([HELLO, { t: 'sub', n: 1 }, { t: 'sub', n: 2 }])
  })
})

describe('NL-4 同 id 再来 hello', () => {
  it('NL-4 旧的收掉（不发 bye），建新的；条数仍是 1；第二个 hello 只到新链路', () => {
    const conn = connection()
    const hello2 = { ...HELLO, epoch: 2 }
    hub.receive(conn, 'L1', HELLO)
    hub.receive(conn, 'L1', hello2)
    expect(accepted).toHaveLength(2)
    expect(accepted[0].reasons).toStrictEqual(['superseded by a new hello'])
    expect(conn.sendSync).not.toHaveBeenCalled()
    expect(accepted[1].link).not.toBe(accepted[0].link)
    expect(hub.linkCount('ws:1')).toBe(1)
    expect(accepted[0].frames).toStrictEqual([HELLO])
    expect(accepted[1].frames).toStrictEqual([hello2])
  })
})

describe('NL-5 每条连接的链路上限', () => {
  it('NL-5 第三条被拒（warn 带 id），它的帧丢掉；bye 之后新的照收；另一条连接各有各的', () => {
    const conn = connection()
    hub.receive(conn, 'L1', HELLO)
    hub.receive(conn, 'L2', HELLO)
    hub.receive(conn, 'L3', HELLO)
    expect(accept).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toContain('ws:1')
    expect(logger.warn.mock.calls[0][0]).toContain('L3')
    hub.receive(conn, 'L3', { t: 'sub' })
    expect(accept).toHaveBeenCalledTimes(2)
    expect(hub.linkCount('ws:1')).toBe(2)

    hub.receive(conn, 'L1', { t: 'bye', reason: 'x' })
    expect(accepted[0].reasons).toStrictEqual(['x'])
    expect(hub.linkCount('ws:1')).toBe(1)
    hub.receive(conn, 'L3', HELLO)
    expect(accept).toHaveBeenCalledTimes(3)
    expect(hub.linkCount('ws:1')).toBe(2)

    const conn2 = connection('ws:2')
    hub.receive(conn2, 'A', HELLO)
    hub.receive(conn2, 'B', HELLO)
    expect(accept).toHaveBeenCalledTimes(5)
    expect(hub.linkCount('ws:2')).toBe(2)
    expect(hub.linkCount()).toBe(4)
  })
})

describe('NL-6 坏链路 id 与坏帧', () => {
  it('NL-6 丢掉、不 accept；200 字符的 id 可以', () => {
    const conn = connection()
    for (const linkId of [5, '', 'l'.repeat(201)]) hub.receive(conn, linkId, HELLO)
    for (const frame of [null, 'str', [1], 42]) hub.receive(conn, 'L1', frame)
    expect(accept).not.toHaveBeenCalled()
    hub.receive(conn, 'l'.repeat(200), HELLO)
    expect(accept).toHaveBeenCalledTimes(1)
  })
})

describe('NL-7 连接已经关了', () => {
  it('NL-7 连 hello 都丢掉', () => {
    const conn = connection()
    conn.open = false
    hub.receive(conn, 'L1', HELLO)
    expect(accept).not.toHaveBeenCalled()
    expect(hub.linkCount()).toBe(0)
  })
})

describe('NL-8 closeConnection', () => {
  it('NL-8 这条连接的链路全部结束、计数归零，别的连接不动', () => {
    const a = connection('ws:1')
    const b = connection('ws:2')
    hub.receive(a, 'L1', HELLO)
    hub.receive(a, 'L2', HELLO)
    hub.receive(b, 'L1', HELLO)
    hub.closeConnection('ws:1')
    expect(accepted[0].reasons).toStrictEqual(['network client disconnected'])
    expect(accepted[1].reasons).toStrictEqual(['network client disconnected'])
    expect(accepted[2].reasons).toStrictEqual([])
    expect(hub.linkCount('ws:1')).toBe(0)
    expect(hub.linkCount('ws:2')).toBe(1)
    expect(() => hub.closeConnection('ws:1')).not.toThrow()
    expect(() => hub.closeConnection('ws:404')).not.toThrow()
    expect(accepted[0].reasons).toHaveLength(1)
  })

  it('NL-8 给了原因就用那个原因', () => {
    const a = connection('ws:1')
    hub.receive(a, 'L1', HELLO)
    hub.closeConnection('ws:1', 'server stopping')
    expect(accepted[0].reasons).toStrictEqual(['server stopping'])
  })
})

describe('NL-9 服务端 → 客户端', () => {
  it('NL-9 link.send(frame) → sendSync(linkId, frame)', () => {
    const conn = connection()
    hub.receive(conn, 'L1', HELLO)
    const frame = { t: 'x', n: 1 }
    accepted[0].link.send(frame as never)
    expect(conn.sendSync).toHaveBeenCalledTimes(1)
    expect(conn.sendSync).toHaveBeenCalledWith('L1', frame)
  })

  it("NL-9 连接关了 → 不调 sendSync，链路以 'transport error' 结束", () => {
    const conn = connection()
    hub.receive(conn, 'L1', HELLO)
    conn.open = false
    expect(() => accepted[0].link.send({ t: 'x' } as never)).not.toThrow()
    expect(conn.sendSync).not.toHaveBeenCalled()
    expect(accepted[0].reasons).toStrictEqual(['transport error'])
    expect(hub.linkCount('ws:1')).toBe(0)
  })

  it("NL-9 sendSync 抛 → 以 'transport error' 结束，不外抛", () => {
    const conn = connection()
    conn.sendSync.mockImplementation(() => {
      throw new Error('socket gone')
    })
    hub.receive(conn, 'L1', HELLO)
    expect(() => accepted[0].link.send({ t: 'x' } as never)).not.toThrow()
    expect(accepted[0].reasons).toStrictEqual(['transport error'])
  })
})

describe('NL-10 客户端 bye 结束的链路', () => {
  it('NL-10 离开计数；之后的非 hello 帧丢掉', () => {
    const conn = connection()
    hub.receive(conn, 'L1', HELLO)
    hub.receive(conn, 'L1', { t: 'bye', reason: 'done' })
    expect(hub.linkCount('ws:1')).toBe(0)
    expect(hub.linkCount()).toBe(0)
    hub.receive(conn, 'L1', { t: 'sub' })
    expect(accepted[0].frames).toStrictEqual([HELLO])
    expect(accept).toHaveBeenCalledTimes(1)
  })
})
