/**
 * `frontend/network/transport.ts` —— 通道注册表的网络传输（server mode phase B §B2）：收下定义、认 `kind:'network'` 的客户端、
 * 推送 / 生死 / 广播走连接表。连接用 `support/fakeNetworkConnection` 的假的。NT-10 每条用例 `vi.resetModules()` 后重新导入
 * `ipc/registry`（模块级状态），挂一个记录型 `ipc` 替身 + 真的网络传输。
 *
 *   NT-1  name === 'network'；owns 只认网络客户端
 *   NT-2  serve 之后 definitionOf 回同一个对象；没有 → undefined
 *   NT-3  pushTo → 那条连接恰收到 {t:'push', channel, args}（args 是拷贝）；关了 / 不认识的 id / 窗口客户端 → 什么也不做
 *   NT-4  isClientAlive：开着 true；关了（哪怕还在表里）/ 不认识 / 窗口客户端 → false
 *   NT-5  onClientGone：开着 → 关时恰触发一次，先撤掉就不触发；不认识 / 已经关了 → 不同步回调、下一个微任务恰一次，
 *        微任务前撤掉就不触发；窗口客户端 → 永不触发、撤销无害
 *   NT-6  broadcast → 每条开着的连接各收一份（各自的拷贝），关了的跳过
 *   NT-7  connections() 按加入顺序、只列开着的；关掉之后从 connections() 与 connection(id) 里消失
 *   NT-8  同 id 换了对象 → 旧的 close(1001,'replaced')；新的留下，旧的迟到的 onClose 也摘不掉它
 *   NT-9  closeAll(4000,'x') → 每条恰 close 一次；之后 connections() 为空
 *   NT-10 与注册表接起来：broadcastToClients 两条传输都到；pushTo / isClientAlive / onClientGone 按 kind 路由；
 *        挂之前与挂之后的定义 definitionOf 都认得；没挂网络传输时 onClientGone(网络客户端) 永不触发
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RegistryModule from '../../../ipc/registry'
import type { ChannelDefinition, ClientRef, ClientTransport } from '../../../ipc/registry'
import { createNetworkTransport, NETWORK_TRANSPORT_NAME, type NetworkTransport } from '../transport'
import { fakeConnection, netClient, winCtx } from './support/fakeNetworkConnection'

const windowClient = winCtx().client

let transport: NetworkTransport

beforeEach(() => {
  transport = createNetworkTransport()
})

describe('NT-1 名字与认人', () => {
  it('NT-1 name === network；owns 只认网络客户端', () => {
    expect(transport.name).toBe('network')
    expect(NETWORK_TRANSPORT_NAME).toBe('network')
    expect(transport.owns(netClient(1))).toBe(true)
    expect(transport.owns(windowClient)).toBe(false)
  })
})

describe('NT-2 serve / definitionOf', () => {
  it('NT-2 definitionOf 回 serve 收下的同一个对象；没有 → undefined', () => {
    const definition: ChannelDefinition = { kind: 'handle', channel: 'x:y', fn: () => 1 }
    transport.serve(definition)
    expect(transport.definitionOf('x:y')).toBe(definition)
    expect(transport.definitionOf('x:z')).toBeUndefined()
  })
})

describe('NT-3 pushTo', () => {
  it('NT-3 → 那条连接恰收到 {t:push, channel, args}；args 是拷贝', () => {
    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    const a = { a: 1 }
    const b = 'b'
    const payload = [a, b]
    transport.pushTo(netClient(1), 'ch', payload)
    expect(conn.sent).toStrictEqual([{ t: 'push', channel: 'ch', args: [a, b] }])
    payload.push('later')
    expect((conn.sent[0] as { args: unknown[] }).args).toStrictEqual([a, b])
    expect((conn.sent[0] as { args: unknown[] }).args[0]).toBe(a)
  })

  it('NT-3 关了 / 不认识的 id / 窗口客户端 → 什么也不做', () => {
    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    expect(() => transport.pushTo(netClient(9), 'ch', [1])).not.toThrow()
    expect(() => transport.pushTo(windowClient, 'ch', [1])).not.toThrow()
    conn.drop()
    expect(() => transport.pushTo(netClient(1), 'ch', [1])).not.toThrow()
    expect(conn.sent).toStrictEqual([])
  })
})

describe('NT-4 isClientAlive', () => {
  it('NT-4 开着 true；关了（哪怕还在表里）/ 不认识 / 窗口客户端 → false', () => {
    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    expect(transport.isClientAlive(netClient(1))).toBe(true)
    expect(transport.isClientAlive(netClient(9))).toBe(false)
    expect(transport.isClientAlive(windowClient)).toBe(false)

    // isOpen 为假但仍在表里（关掉的回调还没摘它）
    const stale = fakeConnection(netClient(2))
    transport.add(stale)
    stale.isOpen = () => false
    expect(transport.connection('ws:2')).toBe(stale)
    expect(transport.isClientAlive(netClient(2))).toBe(false)

    conn.drop()
    expect(transport.isClientAlive(netClient(1))).toBe(false)
  })
})

describe('NT-5 onClientGone', () => {
  it('NT-5 开着：关时恰触发一次；先撤掉就不触发', () => {
    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    const cb = vi.fn()
    transport.onClientGone(netClient(1), cb)
    const cancelled = vi.fn()
    const dispose = transport.onClientGone(netClient(1), cancelled)
    dispose()
    conn.close(1000, 'bye')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cancelled).not.toHaveBeenCalled()
    conn.close(1000, 'again')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('NT-5 不认识 / 已经关了：不同步回调，下一个微任务恰一次；微任务前撤掉就不触发', async () => {
    const unknown = vi.fn()
    transport.onClientGone(netClient(9), unknown)
    expect(unknown).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(unknown).toHaveBeenCalledTimes(1)

    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    conn.drop()
    const closed = vi.fn()
    transport.onClientGone(netClient(1), closed)
    expect(closed).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(closed).toHaveBeenCalledTimes(1)

    const early = vi.fn()
    const dispose = transport.onClientGone(netClient(9), early)
    dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(early).not.toHaveBeenCalled()
  })

  it('NT-5 窗口客户端：永不触发，撤销无害', async () => {
    const cb = vi.fn()
    const dispose = transport.onClientGone(windowClient, cb)
    await Promise.resolve()
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
  })
})

describe('NT-6 broadcast', () => {
  it('NT-6 每条开着的连接各收一份（各自的拷贝），关了的跳过', () => {
    const a = fakeConnection(netClient(1))
    const b = fakeConnection(netClient(2))
    const gone = fakeConnection(netClient(3))
    transport.add(a)
    transport.add(b)
    transport.add(gone)
    gone.drop()
    const ev = { type: 'session.listChanged' }
    transport.broadcast('app:event', [ev])
    expect(a.sent).toStrictEqual([{ t: 'push', channel: 'app:event', args: [ev] }])
    expect(b.sent).toStrictEqual([{ t: 'push', channel: 'app:event', args: [ev] }])
    expect(gone.sent).toStrictEqual([])
    const argsA = (a.sent[0] as { args: unknown[] }).args
    const argsB = (b.sent[0] as { args: unknown[] }).args
    expect(argsA).not.toBe(argsB)
  })
})

describe('NT-7 connections / connection', () => {
  it('NT-7 按加入顺序、只列开着的；关掉之后消失', () => {
    const a = fakeConnection(netClient(1))
    const b = fakeConnection(netClient(2))
    const c = fakeConnection(netClient(3))
    transport.add(a)
    transport.add(b)
    transport.add(c)
    expect(transport.connections()).toEqual([a, b, c])
    b.isOpen = () => false
    expect(transport.connections()).toEqual([a, c])
    b.isOpen = () => true
    b.close(1000, 'x')
    expect(transport.connections()).toEqual([a, c])
    expect(transport.connection('ws:2')).toBeUndefined()
    expect(transport.connection('ws:1')).toBe(a)
  })
})

describe('NT-8 同 id 的新连接', () => {
  it("NT-8 旧的 close(1001,'replaced')；新的留下，旧的迟到的 onClose 摘不掉它", async () => {
    const old = fakeConnection(netClient(1))
    // 旧连接的关闭回调晚到（真的 socket 关闭握手是异步的）：先把传输登记的回调截住，不让 close 同步跑它
    const late: Array<() => void> = []
    old.onClose = (cb) => {
      late.push(cb)
      return () => {}
    }
    transport.add(old)
    expect(late).toHaveLength(1)
    const fresh = fakeConnection(netClient(1))
    transport.add(fresh)
    expect(old.closes).toStrictEqual([[1001, 'replaced']])
    expect(transport.connection('ws:1')).toBe(fresh)
    expect(transport.connections()).toEqual([fresh])
    for (const cb of late) cb()
    await Promise.resolve()
    expect(transport.connection('ws:1')).toBe(fresh)
    expect(transport.isClientAlive(netClient(1))).toBe(true)
    // 新连接自己关掉时照样摘掉
    fresh.close(1000, 'bye')
    expect(transport.connection('ws:1')).toBeUndefined()
  })

  it('NT-8 同一个对象再 add 一次 → 不关它', () => {
    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    transport.add(conn)
    expect(conn.closes).toStrictEqual([])
    expect(transport.connection('ws:1')).toBe(conn)
  })
})

describe('NT-9 closeAll', () => {
  it("NT-9 closeAll(4000,'x') → 每条恰 close 一次；之后 connections() 为空", () => {
    const a = fakeConnection(netClient(1))
    const b = fakeConnection(netClient(2))
    transport.add(a)
    transport.add(b)
    transport.closeAll(4000, 'x')
    expect(a.closes).toStrictEqual([[4000, 'x']])
    expect(b.closes).toStrictEqual([[4000, 'x']])
    expect(transport.connections()).toStrictEqual([])
    transport.closeAll(4000, 'again')
    expect(a.closes).toHaveLength(1)
  })
})

describe('NT-10 与注册表接起来', () => {
  let registry: typeof RegistryModule

  beforeEach(async () => {
    vi.resetModules()
    registry = await import('../../../ipc/registry')
  })

  interface RecordingIpc extends ClientTransport {
    pushes: Array<[ClientRef, string, readonly unknown[]]>
    broadcasts: Array<[string, readonly unknown[]]>
    gone: Array<[ClientRef, () => void]>
  }

  function recordingIpc(): RecordingIpc {
    const t: RecordingIpc = {
      name: 'ipc',
      pushes: [],
      broadcasts: [],
      gone: [],
      serve: () => {},
      owns: (client) => client.kind === 'window',
      pushTo: (client, channel, payload) => void t.pushes.push([client, channel, payload]),
      isClientAlive: () => true,
      onClientGone: (client, callback) => {
        t.gone.push([client, callback])
        return () => {}
      },
      broadcast: (channel, payload) => void t.broadcasts.push([channel, payload])
    }
    return t
  }

  it('NT-10 broadcastToClients 两条传输都到；pushTo / isClientAlive / onClientGone 按 kind 路由', async () => {
    const ipc = recordingIpc()
    registry.attachTransport(ipc)
    registry.attachTransport(transport)
    const conn = fakeConnection(netClient(1))
    transport.add(conn)

    const ev = { type: 'bot.changed' }
    registry.broadcastToClients('app:event', ev)
    expect(ipc.broadcasts).toStrictEqual([['app:event', [ev]]])
    expect(conn.sent).toStrictEqual([{ t: 'push', channel: 'app:event', args: [ev] }])

    registry.pushTo(windowClient, 'w:ch', 1)
    expect(ipc.pushes).toStrictEqual([[windowClient, 'w:ch', [1]]])
    expect(conn.sent).toHaveLength(1)

    registry.pushTo(netClient(1), 'n:ch', 2)
    expect(conn.sent[1]).toStrictEqual({ t: 'push', channel: 'n:ch', args: [2] })
    expect(ipc.pushes).toHaveLength(1)

    expect(registry.isClientAlive(netClient(1))).toBe(true)
    expect(registry.isClientAlive(netClient(9))).toBe(false)
    expect(registry.isClientAlive(windowClient)).toBe(true)

    const netGone = vi.fn()
    const winGone = vi.fn()
    registry.onClientGone(netClient(1), netGone)
    registry.onClientGone(windowClient, winGone)
    expect(ipc.gone.map(([c]) => c)).toStrictEqual([windowClient])
    conn.close(1000, 'bye')
    expect(netGone).toHaveBeenCalledTimes(1)
    expect(winGone).not.toHaveBeenCalled()
    await Promise.resolve()
  })

  it('NT-10 挂之前与挂之后的定义 definitionOf 都认得', () => {
    const before = vi.fn()
    const after = vi.fn()
    registry.defineHandler('x:y', before)
    registry.attachTransport(transport)
    registry.defineHandler('x:z', after)
    expect(transport.definitionOf('x:y')).toMatchObject({ kind: 'handle', fn: before })
    expect(transport.definitionOf('x:z')).toMatchObject({ kind: 'handle', fn: after })
  })

  it('NT-10 没挂网络传输时 onClientGone(网络客户端) 永不触发', async () => {
    registry.attachTransport(recordingIpc())
    const cb = vi.fn()
    const dispose = registry.onClientGone(netClient(1), cb)
    await Promise.resolve()
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
  })
})
