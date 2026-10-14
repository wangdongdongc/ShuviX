/**
 * preload 的 `sync` 桥（pi 1.2 / chord2）：`window.api.sync` 是一条 `SyncLinkChannel` ——
 *
 *   SB-1 send(link, frame) → `ipcRenderer.send('sync:frame', link, frame)` 恰一次，参数原样
 *   SB-2 onFrame：每个回调各收一次（链路 id，帧），不带 IPC 事件；链路 id 不是字符串的丢掉；注销只摘自己的、重复注销无事
 *   SB-3 契约：SessionChannelApi.sync 就是 SyncLinkChannel；白名单里没有 sync.invoke（视图同步不走 channel.call 了）
 *   SB-4 每次 onFrame 各挂一个 ipcRenderer 监听、各自的注销只摘自己那个；桥上没有 onDown / onUp / isUp / invoke
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import { CHROME_PANEL_CHANNEL_PATHS } from '@shuvix/chat-protocol/chromeBridge'
import type { SyncLinkChannel } from '@shuvix/chat-protocol/sync'
import { createSyncBridge, type SyncIpcRenderer } from '../syncBridge'

type Handler = (event: unknown, ...args: unknown[]) => void

function mockIpcRenderer(): SyncIpcRenderer & {
  send: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => void>>
  emit(channel: string, ...args: unknown[]): void
  listeners(channel: string): number
} {
  const handlers = new Map<string, Set<Handler>>()
  return {
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
    on: vi.fn((channel: string, handler: Handler) => {
      if (!handlers.has(channel)) handlers.set(channel, new Set())
      handlers.get(channel)!.add(handler)
    }),
    removeListener: vi.fn((channel: string, handler: Handler) => {
      handlers.get(channel)?.delete(handler)
    }),
    emit(channel, ...args) {
      for (const handler of [...(handlers.get(channel) ?? [])]) handler({ sender: 'ipc' }, ...args)
    },
    listeners: (channel) => handlers.get(channel)?.size ?? 0
  }
}

describe('preload sync bridge', () => {
  it('SB-1 send forwards (link, frame) on sync:frame once', () => {
    const ipc = mockIpcRenderer()
    const bridge = createSyncBridge(ipc)
    bridge.send('L1', { t: 'hello', name: 'x', kind: 'client', epoch: 1 })
    expect(ipc.send).toHaveBeenCalledTimes(1)
    expect(ipc.send).toHaveBeenCalledWith('sync:frame', 'L1', {
      t: 'hello',
      name: 'x',
      kind: 'client',
      epoch: 1
    })
  })

  it('SB-2 onFrame hands (link, frame) to each callback; unsubscribe removes only its own', () => {
    const ipc = mockIpcRenderer()
    const bridge = createSyncBridge(ipc)
    const a: unknown[] = []
    const b: unknown[] = []
    const stopA = bridge.onFrame((link, frame) => a.push([link, frame]))
    bridge.onFrame((link, frame) => b.push([link, frame]))
    ipc.emit('sync:frame', 'L1', { t: 'ping', n: 1 })
    ipc.emit('sync:frame', 7, { t: 'ping', n: 2 })
    expect(a).toEqual([['L1', { t: 'ping', n: 1 }]])
    expect(b).toEqual([['L1', { t: 'ping', n: 1 }]])
    stopA()
    stopA()
    expect(ipc.listeners('sync:frame')).toBe(1)
    ipc.emit('sync:frame', 'L2', { t: 'pong', n: 3 })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
  })

  it('SB-3 the contract: sync is a SyncLinkChannel; the panel whitelist has no sync.invoke', () => {
    expectTypeOf<SessionChannelApi['sync']>().toEqualTypeOf<SyncLinkChannel>()
    expect((CHROME_PANEL_CHANNEL_PATHS as readonly string[]).includes('sync.invoke')).toBe(false)
  })

  it('SB-4 each onFrame registers its own ipcRenderer listener and each unsubscribe removes only its own; no onDown / onUp / isUp / invoke', () => {
    const ipc = mockIpcRenderer()
    const bridge = createSyncBridge(ipc)
    const stopA = bridge.onFrame(() => {})
    const stopB = bridge.onFrame(() => {})
    expect(ipc.on).toHaveBeenCalledTimes(2)
    const on = vi.mocked(ipc.on).mock.calls
    expect(on.map(([channel]) => channel)).toEqual(['sync:frame', 'sync:frame'])
    const [handlerA, handlerB] = on.map(([, handler]) => handler)
    expect(handlerA).not.toBe(handlerB)
    expect(ipc.listeners('sync:frame')).toBe(2)

    stopB()
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(ipc.removeListener).toHaveBeenLastCalledWith('sync:frame', handlerB)
    expect(ipc.listeners('sync:frame')).toBe(1)
    stopB()
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    stopA()
    expect(ipc.removeListener).toHaveBeenCalledTimes(2)
    expect(ipc.removeListener).toHaveBeenLastCalledWith('sync:frame', handlerA)
    expect(ipc.listeners('sync:frame')).toBe(0)

    // 桌面窗口的传输永远在：桥只有 send / onFrame
    expect(Object.keys(bridge).sort()).toEqual(['onFrame', 'send'])
    for (const name of ['onDown', 'onUp', 'isUp', 'invoke']) expect(name in bridge).toBe(false)
  })
})
