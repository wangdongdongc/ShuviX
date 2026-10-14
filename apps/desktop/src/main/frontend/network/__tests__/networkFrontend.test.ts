/**
 * `frontend/network/NetworkFrontend.ts` —— 一条网络连接收聊天余项事件的口（server mode phase B）：经注册表 `pushTo` 推
 * `agent:event`，连接断了 `isAlive` 即假。每条用例 `vi.resetModules()` 后重新导入 `ipc/registry` 与 NetworkFrontend
 * （注册表有模块级状态），挂上真的网络传输；连接是假的。logger 替身（真的拉 electron-log）。
 *
 *   NF-1 networkFrontendId('ws:3') === 'network:ws:3'；id = 'network:' + client.id；capabilities 恰是 {userInput:true}
 *   NF-2 开着：sendEvent → 那条连接收到 {t:'push', channel:'agent:event', args:[ev]}；isAlive 真
 *   NF-3 连接关了：isAlive 假，sendEvent 什么也不发、不抛
 *   NF-4 根本没挂网络传输：isAlive 假，sendEvent 无操作
 *   NF-5 真的 ChatFrontendRegistry：registerDefault 后 hasCapability(userInput) 真；broadcast 推到；连接关了之后一次
 *        broadcast 把它剪掉；unregister(networkFrontendId(id)) 移除
 */
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RegistryModule from '../../../ipc/registry'
import type * as FrontendModule from '../NetworkFrontend'
import { createNetworkTransport, type NetworkTransport } from '../transport'
import { fakeConnection, netClient } from './support/fakeNetworkConnection'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

let registry: typeof RegistryModule
let mod: typeof FrontendModule
let transport: NetworkTransport

beforeEach(async () => {
  vi.resetModules()
  registry = await import('../../../ipc/registry')
  mod = await import('../NetworkFrontend')
  transport = createNetworkTransport()
})

const ev = { type: 'agent_start', sessionId: 's9' } as ChatEvent

describe('NF-1 id 与能力', () => {
  it('NF-1 networkFrontendId / id / capabilities', () => {
    expect(mod.networkFrontendId('ws:3')).toBe('network:ws:3')
    const c = netClient(4)
    const frontend = new mod.NetworkFrontend(c)
    expect(frontend.id).toBe('network:' + c.id)
    expect(frontend.capabilities).toStrictEqual({ userInput: true })
  })
})

describe('NF-2 / NF-3 推送与生死', () => {
  it('NF-2 开着：sendEvent → agent:event 推送；isAlive 真', () => {
    registry.attachTransport(transport)
    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    const frontend = new mod.NetworkFrontend(netClient(1))
    expect(frontend.isAlive()).toBe(true)
    frontend.sendEvent(ev)
    expect(conn.sent).toStrictEqual([{ t: 'push', channel: 'agent:event', args: [ev] }])
  })

  it('NF-3 连接关了：isAlive 假，sendEvent 不发、不抛', () => {
    registry.attachTransport(transport)
    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    const frontend = new mod.NetworkFrontend(netClient(1))
    conn.close(1000, 'bye')
    expect(frontend.isAlive()).toBe(false)
    expect(() => frontend.sendEvent(ev)).not.toThrow()
    expect(conn.sent).toStrictEqual([])
  })

  it('NF-4 没挂网络传输：isAlive 假，sendEvent 无操作', () => {
    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    const frontend = new mod.NetworkFrontend(netClient(1))
    expect(frontend.isAlive()).toBe(false)
    expect(() => frontend.sendEvent(ev)).not.toThrow()
    expect(conn.sent).toStrictEqual([])
  })
})

describe('NF-5 真的 ChatFrontendRegistry', () => {
  it('NF-5 registerDefault / broadcast / 剪掉断开的 / unregister', async () => {
    const { ChatFrontendRegistry } = await import('../../core/ChatFrontendRegistry')
    registry.attachTransport(transport)
    const chat = new ChatFrontendRegistry()

    const conn = fakeConnection(netClient(1))
    transport.add(conn)
    const frontend = new mod.NetworkFrontend(netClient(1))
    chat.registerDefault(frontend)
    expect(chat.hasCapability('s9', 'userInput')).toBe(true)

    chat.broadcast(ev)
    expect(conn.sent).toStrictEqual([{ t: 'push', channel: 'agent:event', args: [ev] }])

    conn.close(1000, 'bye')
    expect(chat.getFrontends('s9').map((f) => f.id)).toContain(frontend.id)
    chat.broadcast(ev)
    expect(chat.getFrontends('s9').map((f) => f.id)).not.toContain(frontend.id)
    expect(chat.hasCapability('s9', 'userInput')).toBe(false)

    const conn2 = fakeConnection(netClient(2))
    transport.add(conn2)
    const other = new mod.NetworkFrontend(netClient(2))
    chat.registerDefault(other)
    expect(chat.getFrontends('s9').map((f) => f.id)).toEqual(['network:ws:2'])
    chat.unregister(mod.networkFrontendId('ws:2'))
    expect(chat.getFrontends('s9')).toEqual([])
  })
})
