/**
 * 视图同步的服务端传输（P3-05，docs/pi-durable/p3-050710a-test-design.md「Transport, client identity and
 * client gone」）：
 *
 *   P3-05-02 send 只发给一个 webContents        P3-05-03 发送失败留在传输里（不抛、各记一笔）
 *   P3-05-04 别的传输的客户端 id（PIN-03）        P3-05-05 onClientGone（含 PIN-04：登记时已不在）
 *   P3-05-06 渲染进程重载（PIN-02）              P3-05-07 接真 hub：客户端离开
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createServiceStateDecoder,
  createServiceSubscribeCall,
  parseWireServiceSubscriptionSnapshot
} from '@earendil-works/chord'
import { createSyncHub, type SyncWireFrame } from '@shuvix/agent-runtime'
import { CHAT_VIEW_SERVICE_ID } from '@shuvix/chat-protocol/sync'
import {
  createIpcSyncTransport,
  createRoutingSyncTransport,
  type SyncTransportLogger
} from '../ipcSyncTransport'
import { FakeWebContents, lookupOf, settle } from './support/ipcRig'
import { FakeSyncHost } from './support/fakeSync'

const frame = (n = 1): SyncWireFrame =>
  ({
    target: { kind: 'session', sessionId: 's1' },
    subscriptionId: `sub-${n}`,
    update: { type: 'state', n }
  }) as unknown as SyncWireFrame

function recordingLogger(): SyncTransportLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    warn: (message) => void lines.push(`warn:${message}`),
    error: (message) => void lines.push(`error:${message}`)
  }
}

function rig(): {
  wcA: FakeWebContents
  wcB: FakeWebContents
  table: Map<number, FakeWebContents>
  logger: ReturnType<typeof recordingLogger>
  transport: ReturnType<typeof createRoutingSyncTransport>
} {
  const wcA = new FakeWebContents(7)
  const wcB = new FakeWebContents(8)
  const table = new Map([
    [7, wcA],
    [8, wcB]
  ])
  const logger = recordingLogger()
  const transport = createRoutingSyncTransport({ logger })
  transport.addRoute('ipc', createIpcSyncTransport({ lookup: lookupOf(table), logger }))
  return { wcA, wcB, table, logger, transport }
}

const goneListeners = (wc: FakeWebContents): number =>
  wc.listenerCount('destroyed') +
  wc.listenerCount('render-process-gone') +
  wc.listenerCount('did-navigate')

describe('P3-05-02 send 只发给一个 webContents', () => {
  it("P3-05-02 send('ipc:7', frame) → wcA.send 恰一次 ('sync:frame', frame)；wcB 从没被调", () => {
    const { wcA, wcB, transport } = rig()
    const f = frame()
    transport.send('ipc:7', f)
    expect(wcA.send).toHaveBeenCalledTimes(1)
    expect(wcA.send).toHaveBeenCalledWith('sync:frame', f)
    expect(wcA.send.mock.calls[0]![1]).toEqual(frame())
    expect(wcB.send).not.toHaveBeenCalled()
  })
})

describe('P3-05-03 发送失败留在传输里', () => {
  it('P3-05-03 lookup 交回 undefined → 不抛，记一笔', () => {
    const { table, logger, transport } = rig()
    table.delete(7)
    expect(() => transport.send('ipc:7', frame())).not.toThrow()
    expect(logger.lines).toHaveLength(1)
  })

  it('P3-05-03 webContents 已销毁 → 不调 send，不抛，记一笔', () => {
    const { wcA, logger, transport } = rig()
    wcA.destroyed = true
    expect(() => transport.send('ipc:7', frame())).not.toThrow()
    expect(wcA.send).not.toHaveBeenCalled()
    expect(logger.lines).toHaveLength(1)
  })

  it('P3-05-03 wcA.send 抛错 → 不抛，记一笔', () => {
    const { wcA, logger, transport } = rig()
    wcA.send.mockImplementationOnce(() => {
      throw new Error('Object has been destroyed')
    })
    expect(() => transport.send('ipc:7', frame())).not.toThrow()
    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toContain('Object has been destroyed')
  })
})

describe('P3-05-04 别的传输的客户端 id（PIN-03）', () => {
  it("P3-05-04 send('chrome:3') / send('bogus') → 不碰任何 webContents、丢掉并记一笔、不抛", () => {
    const { wcA, wcB, logger, transport } = rig()
    expect(() => transport.send('chrome:3', frame())).not.toThrow()
    expect(() => transport.send('bogus', frame())).not.toThrow()
    expect(wcA.send).not.toHaveBeenCalled()
    expect(wcB.send).not.toHaveBeenCalled()
    expect(logger.lines).toHaveLength(2)
    expect(logger.lines.every((line) => line.includes('no route'))).toBe(true)
  })

  it('P3-05-04 之后挂上的前缀（P3-09 的 chrome）照样路由；注销只摘自己挂的那一个', () => {
    const { transport } = rig()
    const sent: string[] = []
    const chrome = { send: (id: string) => void sent.push(id), onClientGone: () => () => {} }
    const unregister = transport.addRoute('chrome', chrome)
    transport.send('chrome:3', frame())
    expect(sent).toEqual(['chrome:3'])
    expect(transport.routes().sort()).toEqual(['chrome', 'ipc'])
    unregister()
    expect(transport.routes()).toEqual(['ipc'])
  })
})

describe('P3-05-05 onClientGone（含 PIN-04）', () => {
  it("P3-05-05 登记 → destroyed 监听 +1；emit 'destroyed' 调 cb 一次，再 emit 不再调；注销恢复基线、之后的 emit 什么都不做", () => {
    const { wcA, transport } = rig()
    const baseline = wcA.listenerCount('destroyed')
    const cb = vi.fn()
    transport.onClientGone('ipc:7', cb)
    expect(wcA.listenerCount('destroyed')).toBe(baseline + 1)
    wcA.emit('destroyed')
    expect(cb).toHaveBeenCalledTimes(1)
    wcA.emit('destroyed')
    expect(cb).toHaveBeenCalledTimes(1)

    const cb2 = vi.fn()
    const base2 = goneListeners(wcA)
    const unregister = transport.onClientGone('ipc:7', cb2) as () => void
    expect(goneListeners(wcA)).toBe(base2 + 3)
    unregister()
    expect(goneListeners(wcA)).toBe(base2)
    expect(wcA.listenerCount('destroyed')).toBe(baseline)
    wcA.emit('destroyed')
    expect(cb2).not.toHaveBeenCalled()
    unregister() // 重复注销无事
  })

  it.each([
    ['webContents 不在', 'missing'],
    ['webContents 已销毁', 'destroyed']
  ])('P3-05-05 变体（PIN-04）：%s → cb 在之后的一拍里恰一次，绝不同步', async (_label, kind) => {
    const { wcA, table, transport } = rig()
    if (kind === 'missing') table.delete(7)
    else wcA.destroyed = true
    const cb = vi.fn()
    transport.onClientGone('ipc:7', cb)
    expect(cb).not.toHaveBeenCalled()
    await settle()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(goneListeners(wcA)).toBe(0)
  })

  it('P3-05-05 变体：之后一拍到来之前注销 → cb 不调', async () => {
    const { table, transport } = rig()
    table.delete(7)
    const cb = vi.fn()
    const unregister = transport.onClientGone('ipc:7', cb) as () => void
    unregister()
    await settle()
    expect(cb).not.toHaveBeenCalled()
  })

  it('P3-05-05 没人认领的前缀：当它已经离开（之后一拍里调一次）', async () => {
    const { transport } = rig()
    const cb = vi.fn()
    transport.onClientGone('chrome:3', cb)
    expect(cb).not.toHaveBeenCalled()
    await settle()
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('P3-05-06 渲染进程重载（PIN-02）', () => {
  it("P3-05-06 'render-process-gone' → cb 一次", () => {
    const { wcA, transport } = rig()
    const cb = vi.fn()
    transport.onClientGone('ipc:7', cb)
    wcA.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    wcA.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(goneListeners(wcA)).toBe(0)
  })

  it('P3-05-06 主框架跨文档导航落定（did-navigate）→ cb 一次；只是开始了（被拦下的导航）、页内导航 → 不调', () => {
    const { wcA, transport } = rig()
    const cb = vi.fn()
    transport.onClientGone('ipc:7', cb)
    // 导航开始了、却被 will-navigate 拦下（外部链接闸）：页面还是那个页面（P3-08 改）
    wcA.emit(
      'did-start-navigation',
      { url: 'app://x', isSameDocument: false, isMainFrame: true },
      'app://x',
      false,
      true
    )
    // 页内（同文档）导航
    wcA.emit('did-navigate-in-page', {}, 'app://x#a', true)
    expect(cb).not.toHaveBeenCalled()
    // 主框架跨文档导航落定（重载 / 换页）
    wcA.emit('did-navigate', {}, 'app://x', 200, 'OK')
    expect(cb).toHaveBeenCalledTimes(1)
    wcA.emit('did-navigate', {}, 'app://x', 200, 'OK')
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('P3-05-07 接真 hub：客户端离开', () => {
  it("P3-05-07 ipc:7 订阅 s1；wcA 'destroyed' → hasSubscribers 为 false、wcA 不再收帧；ipc:7 再订阅是全新的客户端（完整快照，PIN-21）", async () => {
    const { wcA, transport } = rig()
    const host = new FakeSyncHost()
    const s1 = host.add('s1')
    const hub = createSyncHub({ host, transport })

    const subscribe = (id: string): unknown =>
      hub.invoke(
        'ipc:7',
        { kind: 'session', sessionId: 's1' },
        createServiceSubscribeCall(id, CHAT_VIEW_SERVICE_ID, 'singleton')
      )
    const decode = (reply: unknown): { kind: string; ops: unknown[][] } => {
      const snapshot = createServiceStateDecoder().decodeSnapshot(
        parseWireServiceSubscriptionSnapshot(reply as never)
      )
      return snapshot.instances[0]!.members.find((entry) => entry.kind === 'state') as never
    }
    expect(decode(await subscribe('a')).ops[0]![0]).toBe('r')
    expect(hub.hasSubscribers('s1')).toBe(true)
    s1.change((view) => void (view.queue = []))
    s1.change((view) => void (view.run = { state: 'busy' }))
    await settle()
    const before = wcA.frames().length
    expect(before).toBeGreaterThan(0)

    wcA.destroy()
    expect(hub.hasSubscribers('s1')).toBe(false)
    // 新的 webContents 也没有了监听器（hub 注销了自己的离开回调）
    expect(goneListeners(wcA)).toBe(0)
    s1.change((view) => void (view.run = { state: 'idle' }))
    await settle()
    expect(wcA.frames()).toHaveLength(before)

    // 同一个 id 再来：全新的客户端，同一个订阅 id 也能用，拿到的是完整快照（当前值）
    wcA.destroyed = false
    const member = decode(await subscribe('a'))
    expect(member.ops[0]![0]).toBe('r')
    expect((member.ops[0]![1] as { run: unknown }).run).toEqual({ state: 'idle' })
    expect(hub.hasSubscribers('s1')).toBe(true)
    hub.dispose()
  })
})
