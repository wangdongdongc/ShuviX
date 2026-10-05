/**
 * preload 的 `sync` 桥与契约（P3-05，docs/pi-durable/p3-050710a-test-design.md「Preload and contract」）：
 *
 *   P3-05-10 sync.invoke（ipcRenderer.invoke 恰一次、同一组参数；{ok:true, value} → value）
 *   P3-05-11 sync.onFrame（每个回调各一次、只给帧；注销只摘自己的；重复注销无事）
 *   P3-05-12 契约（类型层 + 静态检查：SessionChannelApi.sync 的形状、index.d.ts 声明了 sync、白名单里没有
 *            sync.invoke —— 那是 P3-09）。扩展侧边栏的桩子在 apps/extension 的 channelApiSync.test.ts。
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionChannelApi } from '@shuvix/chat-protocol/chatApi'
import { CHROME_PANEL_CHANNEL_PATHS } from '@shuvix/chat-protocol/chromeBridge'
import type { JsonValue, SyncFrame, SyncTarget } from '@shuvix/chat-protocol/sync'
import { createSyncBridge, type SyncIpcRenderer } from '../syncBridge'

type Handler = (event: unknown, ...args: unknown[]) => void

function mockIpcRenderer(reply: unknown = { ok: true, value: null }): SyncIpcRenderer & {
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  emit(channel: string, ...args: unknown[]): void
} {
  const listeners = new Map<string, Set<Handler>>()
  return {
    invoke: vi.fn(async () => reply),
    on: vi.fn((channel: string, listener: Handler) => {
      let set = listeners.get(channel)
      if (set === undefined) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
    }),
    removeListener: vi.fn((channel: string, listener: Handler) => {
      listeners.get(channel)?.delete(listener)
    }),
    emit(channel, ...args) {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({ sender: {} }, ...args)
    }
  }
}

const target: SyncTarget = { kind: 'session', sessionId: 's1' }

describe('P3-05-10 preload sync.invoke', () => {
  it("P3-05-10 ipcRenderer.invoke('sync:invoke', target, call) 恰一次、同一组参数；{ok:true, value} → value", async () => {
    const value = { reply: [1, 2, 3] }
    const ipc = mockIpcRenderer({ ok: true, value })
    const bridge = createSyncBridge(ipc)
    const call: JsonValue = { method: '$chord.service', args: [{ type: 'catalog' }] }
    await expect(bridge.invoke(target, call)).resolves.toBe(value)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    const [channel, passedTarget, passedCall] = ipc.invoke.mock.calls[0]!
    expect(channel).toBe('sync:invoke')
    expect(passedTarget).toBe(target)
    expect(passedCall).toBe(call)
  })

  it('P3-05-10 {ok:true} 没有 value（退订的回复）→ undefined；{ok:false} → 带 code 的 Error', async () => {
    await expect(
      createSyncBridge(mockIpcRenderer({ ok: true, value: undefined })).invoke(target, null)
    ).resolves.toBeUndefined()
    const rejected = (await createSyncBridge(
      mockIpcRenderer({ ok: false, error: { code: 'service_not_found', message: 'gone' } })
    )
      .invoke(target, null)
      .catch((e: unknown) => e)) as Error & { code?: string }
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected.code).toBe('service_not_found')
    expect(rejected.message).toBe('gone')
  })
})

describe('P3-05-11 preload sync.onFrame', () => {
  it("P3-05-11 'sync:frame' (event, frame) → 每个回调各一次、只带帧；cb1 注销只摘它自己的处理器，cb2 照收；重复注销无事", () => {
    const ipc = mockIpcRenderer()
    const bridge = createSyncBridge(ipc)
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const off1 = bridge.onFrame(cb1)
    bridge.onFrame(cb2)
    expect(ipc.on).toHaveBeenCalledTimes(2)
    const handler1 = ipc.on.mock.calls[0]![1]
    const handler2 = ipc.on.mock.calls[1]![1]
    expect(ipc.on.mock.calls.every(([channel]) => channel === 'sync:frame')).toBe(true)

    const frame: SyncFrame = { target, subscriptionId: 'sub-1', update: { type: 'state' } }
    ipc.emit('sync:frame', frame)
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb1.mock.calls[0]).toEqual([frame])
    expect(cb2).toHaveBeenCalledTimes(1)
    expect(cb2.mock.calls[0]).toEqual([frame])

    off1()
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(ipc.removeListener).toHaveBeenCalledWith('sync:frame', handler1)
    expect(ipc.removeListener).not.toHaveBeenCalledWith('sync:frame', handler2)
    ipc.emit('sync:frame', frame)
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(2)

    off1()
    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
  })
})

describe('P3-05-12 契约', () => {
  it('P3-05-12 SessionChannelApi.sync 的形状；window.api（ShuviXAPI）声明了 sync；白名单里没有 sync.invoke', () => {
    expectTypeOf<SessionChannelApi['sync']['invoke']>().toEqualTypeOf<
      (target: SyncTarget, call: JsonValue) => Promise<JsonValue | undefined>
    >()
    expectTypeOf<SessionChannelApi['sync']['onFrame']>().toEqualTypeOf<
      (callback: (frame: SyncFrame) => void) => () => void
    >()
    // window.api 的全局类型（index.d.ts 的 ShuviXAPI）只在 typecheck:web 可见：那边的
    // renderer/src/host/chatApiContract.ts 断言 ShuviXAPI 可赋给 ChatApi（含必选的 sync）；这里静态查声明在
    const dts = readFileSync(join(__dirname, '..', 'index.d.ts'), 'utf8')
    expect(dts).toMatch(/\n\s+sync: import\('@shuvix\/chat-protocol\/sync'\)\.SyncChannel\n/)
    expectTypeOf(createSyncBridge).returns.toEqualTypeOf<SessionChannelApi['sync']>()
    // sync 是必选成员（PIN-08）
    expectTypeOf<undefined>().not.toMatchTypeOf<SessionChannelApi['sync']>()

    expect(CHROME_PANEL_CHANNEL_PATHS as readonly string[]).not.toContain('sync.invoke')
    expect(CHROME_PANEL_CHANNEL_PATHS as readonly string[]).not.toContain('sync.onFrame')
  })
})
