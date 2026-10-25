/**
 * `web/wsConnection.ts` —— web 客户端的 WebSocket 连接（server mode phase C）：invoke 的排队 / 在途 / 断开拒绝，send 断着就丢，
 * 推送监听跨重连，视图同步渠道的 up / down，退避重连，重连后的补发信号，本地实现与桌面专属通道，dispose。
 * socket 是假的（`readyState`、`sent`、`closeCalls`；`open()` / `serverSend()` / `raw()` / `drop()` 由用例驱动，`close()`
 * 只记下）；计时器是假的（`runTimer()` 跑最早的一个）。
 *
 *   WC-1  建连接 → 同步地 createSocket('ws://h/ws') 一次；state 'connecting'
 *   WC-2  第一次连上之前的两次 invoke：不发；open → 按调用顺序发出（id 1、2）；乱序的结果各自落到对的 Promise
 *   WC-3  线上：invoke('tools:list', undefined, {profile}) → args:[null,{…}]、u:[0]
 *   WC-4  结果：ok 无 value → undefined；null → null；失败带 code → 那个 code 的 Error；不带 → 'handler_error'
 *   WC-5  在途的调用遇上断开 → Error('disconnected')、code 'disconnected'；新 socket 上迟到的结果被忽略、不抛
 *   WC-6  断过之后、重连之前的 invoke 当场拒绝；重连之后也不补发
 *   WC-7  从没连上过就断：排着的调用不拒；state 仍 'connecting'、onState 不调；重连成功后发出并落定
 *   WC-8  send：开着 → {t:'send'}（带 u）；连接中 / 重连中 → 丢掉、连上后也不补发
 *   WC-9  退避：500 起，每次失败翻倍，封顶 5000；连上一次就复位；每个计时器建一个 socket；初次失败也从 500 起；自定义 min/max
 *   WC-10 createSocket 抛 → 不外抛，500 后重试，下一次能连上
 *   WC-11 transport.on：只收载荷；注销有效；断开前登记的监听在重连后照收；没人听的推送忽略；一个监听抛不挡别人（console.error）
 *   WC-12 旧 socket 的 onmessage（结果 / 推送）与 onopen 在重连之后不起作用
 *   WC-13 sync：isUp；onUp 每次连上都调；onDown('disconnected') 每个连上过的 socket 断开时恰一次，初次失败 / 重连失败不调；
 *         send 开着发、断着丢；onFrame 收 (link, frame)；注销有效
 *   WC-14 补发：第一次连上不补发；重连后恰按顺序补发 DEFAULT_RESYNC_EVENTS，且在 onUp 之后；自定义列表；[] → 不补发
 *   WC-15 state / onState：connecting → open → reconnecting → open，每次变化恰一次回调；注销有效
 *   WC-16 localInvoke：不同步调用、await 后以恰好的参数调；回它的返回值；未连上 / dispose 之后照样能用；不发帧；抛 → 拒绝；
 *         本地实现优先于桌面专属；只认自有属性
 *   WC-17 desktopOnly：拒绝（固定消息 + 'desktop_only'），onDesktopOnly 同步调一次；不发帧；断着也一样
 *   WC-18 dispose：在途 / 排队的调用拒绝；连着时 onDown('disposed')；state 'closed' 且 onState 收到；清掉重连计时器、不再建
 *         socket；当前 socket close(1000,'disposed')；之后 invoke 拒、send 无操作；旧 socket 的 onclose 不再触发 onDown / 重连；
 *         第二次 dispose 无事
 *   WC-19 参数编不成 JSON（BigInt）：开着 → TypeError 拒绝、不留在途、不影响别的调用；排着的 → 连上时拒绝、别的照发
 *   WC-20 服务端的垃圾忽略、不抛：非 JSON、未知 t、未知 id 的结果
 *   WC-21 DEFAULT_RESYNC_EVENTS：12 条、type 不重复、含 network.changed 与 session.listChanged、每条只有 type
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type ServerMessage
} from '../../../../shared/networkEnvelope'
import {
  createWsConnection,
  DEFAULT_RESYNC_EVENTS,
  type WebSocketLike,
  type WsConnection,
  type WsConnectionOptions
} from '../wsConnection'

class FakeSocket implements WebSocketLike {
  readyState = 0
  readonly sent: string[] = []
  readonly closeCalls: Array<[number | undefined, string | undefined]> = []
  onopen: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason])
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  serverSend(message: ServerMessage): void {
    this.onmessage?.({ data: encodeServerMessage(message) })
  }
  raw(data: unknown): void {
    this.onmessage?.({ data })
  }
  drop(): void {
    this.readyState = 3
    this.onclose?.({})
  }
  frames(): ClientMessage[] {
    return this.sent.map((text) => decodeClientMessage(text)!)
  }
}

interface PendingTimer {
  fn: () => void
  ms: number
  handle: { id: number }
}

let sockets: FakeSocket[]
let createSocket: ReturnType<typeof vi.fn<(url: string) => WebSocketLike>>
let pending: PendingTimer[]
let timers: {
  setTimeout: ReturnType<typeof vi.fn<(fn: () => void, ms: number) => unknown>>
  clearTimeout: ReturnType<typeof vi.fn<(handle: unknown) => void>>
}
let connections: WsConnection[]

beforeEach(() => {
  sockets = []
  createSocket = vi.fn((_url: string) => {
    const socket = new FakeSocket()
    sockets.push(socket)
    return socket
  })
  pending = []
  let seq = 0
  timers = {
    setTimeout: vi.fn((fn: () => void, ms: number) => {
      const handle = { id: ++seq }
      pending.push({ fn, ms, handle })
      return handle
    }),
    clearTimeout: vi.fn((handle: unknown) => {
      pending = pending.filter((t) => t.handle !== handle)
    })
  }
  connections = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

function make(options: Partial<WsConnectionOptions> = {}): WsConnection {
  const conn = createWsConnection({ url: 'ws://h/ws', createSocket, timers, ...options })
  connections.push(conn)
  return conn
}

function runTimer(): void {
  const timer = pending.shift()
  if (!timer) throw new Error('no pending timer')
  timer.fn()
}

const last = (): FakeSocket => sockets[sockets.length - 1]
const delays = (): number[] => timers.setTimeout.mock.calls.map(([, ms]) => ms)

/** 开着的连接：断掉、跑重连计时器、新 socket 连上 */
function reconnect(): FakeSocket {
  last().drop()
  runTimer()
  last().open()
  return last()
}

const settledState = async (promise: Promise<unknown>): Promise<string> => {
  let state = 'pending'
  promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected')
  )
  await Promise.resolve()
  await Promise.resolve()
  return state
}

describe('WC-1 建连接', () => {
  it("WC-1 同步地建一个 socket；state 'connecting'", () => {
    const conn = make()
    expect(createSocket).toHaveBeenCalledTimes(1)
    expect(createSocket).toHaveBeenCalledWith('ws://h/ws')
    expect(conn.state()).toBe('connecting')
  })
})

describe('WC-2 / WC-3 排队与线上形状', () => {
  it('WC-2 连上之前排着；open 后按顺序发出；乱序的结果各自落定', async () => {
    const conn = make()
    const a = conn.transport.invoke('a:x', 1)
    const b = conn.transport.invoke('b:x', 2)
    expect(last().sent).toStrictEqual([])
    last().open()
    expect(last().frames()).toStrictEqual([
      { t: 'invoke', id: 1, channel: 'a:x', args: [1] },
      { t: 'invoke', id: 2, channel: 'b:x', args: [2] }
    ])
    last().serverSend({ t: 'result', id: 2, ok: true, value: 'B' })
    last().serverSend({ t: 'result', id: 1, ok: true, value: 'A' })
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
  })

  it('WC-3 线上 args:[null,{…}]、u:[0]', () => {
    const conn = make()
    last().open()
    void conn.transport.invoke('tools:list', undefined, { profile: 'chat' })
    const wire = JSON.parse(last().sent[0])
    expect(wire.args).toStrictEqual([null, { profile: 'chat' }])
    expect(wire.u).toStrictEqual([0])
  })
})

describe('WC-4 结果', () => {
  it('WC-4 ok 无 value / null / 失败带 code / 不带 code', async () => {
    const conn = make()
    last().open()
    const a = conn.transport.invoke('c:a')
    const b = conn.transport.invoke('c:b')
    const c = conn.transport.invoke('c:c')
    const d = conn.transport.invoke('c:d')
    last().serverSend({ t: 'result', id: 1, ok: true })
    last().serverSend({ t: 'result', id: 2, ok: true, value: null })
    last().serverSend({ t: 'result', id: 3, ok: false, error: { message: 'm3', code: 'X' } })
    last().serverSend({ t: 'result', id: 4, ok: false, error: { message: 'm4' } })
    await expect(a).resolves.toBeUndefined()
    await expect(b).resolves.toBeNull()
    const errC = await c.catch((e: unknown) => e)
    expect(errC).toBeInstanceOf(Error)
    expect(errC).toMatchObject({ message: 'm3', code: 'X' })
    await expect(d).rejects.toMatchObject({ message: 'm4', code: 'handler_error' })
  })
})

describe('WC-5 / WC-6 断开', () => {
  it('WC-5 在途的调用遇上断开 → disconnected；新 socket 上迟到的结果被忽略', async () => {
    const conn = make()
    last().open()
    const p = conn.transport.invoke('c:x')
    last().drop()
    const error = await p.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: 'disconnected', code: 'disconnected' })
    runTimer()
    last().open()
    expect(() => last().serverSend({ t: 'result', id: 1, ok: true, value: 'late' })).not.toThrow()
  })

  it('WC-6 断过之后的 invoke 当场拒绝；重连后也不补发', async () => {
    const conn = make()
    last().open()
    last().drop()
    await expect(conn.transport.invoke('c:x')).rejects.toMatchObject({ code: 'disconnected' })
    runTimer()
    last().open()
    expect(last().sent).toStrictEqual([])
  })

  it('WC-7 从没连上过就断：排着的不拒，state 仍 connecting，onState 不调；重连后发出并落定', async () => {
    const conn = make()
    const onState = vi.fn()
    conn.onState(onState)
    const p = conn.transport.invoke('c:x', 'arg')
    last().drop()
    expect(await settledState(p)).toBe('pending')
    expect(conn.state()).toBe('connecting')
    expect(onState).not.toHaveBeenCalled()
    runTimer()
    last().open()
    expect(last().frames()).toStrictEqual([{ t: 'invoke', id: 1, channel: 'c:x', args: ['arg'] }])
    last().serverSend({ t: 'result', id: 1, ok: true, value: 7 })
    await expect(p).resolves.toBe(7)
  })
})

describe('WC-8 send', () => {
  it('WC-8 开着发（带 u）；连接中 / 重连中丢掉、之后不补发', () => {
    const conn = make()
    conn.transport.send('terminal:write', 'early')
    last().open()
    expect(last().sent).toStrictEqual([])
    conn.transport.send('terminal:write', undefined, 'x')
    const wire = JSON.parse(last().sent[0])
    expect(wire).toStrictEqual({ t: 'send', channel: 'terminal:write', args: [null, 'x'], u: [0] })
    last().drop()
    conn.transport.send('terminal:write', 'during')
    runTimer()
    last().open()
    expect(last().sent).toStrictEqual([])
  })
})

describe('WC-9 退避', () => {
  it('WC-9 500 起，失败翻倍，封顶 5000；连上就复位；每个计时器建一个 socket', () => {
    make()
    last().open()
    last().drop()
    expect(delays()).toStrictEqual([500])
    for (let i = 0; i < 5; i++) {
      runTimer()
      last().drop()
    }
    expect(delays()).toStrictEqual([500, 1000, 2000, 4000, 5000, 5000])
    expect(createSocket).toHaveBeenCalledTimes(6)
    runTimer()
    last().open()
    last().drop()
    expect(delays().at(-1)).toBe(500)
    expect(createSocket).toHaveBeenCalledTimes(7)
  })

  it('WC-9 初次失败也从 500 起', () => {
    make()
    last().drop()
    expect(delays()).toStrictEqual([500])
  })

  it('WC-9 自定义 min/max → 100, 200, 250, 250', () => {
    make({ minDelayMs: 100, maxDelayMs: 250 })
    last().drop()
    for (let i = 0; i < 3; i++) {
      runTimer()
      last().drop()
    }
    expect(delays()).toStrictEqual([100, 200, 250, 250])
  })
})

describe('WC-10 createSocket 抛', () => {
  it('WC-10 不外抛，500 后重试，下一次能连上', async () => {
    createSocket.mockImplementationOnce(() => {
      throw new Error('blocked')
    })
    let conn: WsConnection | undefined
    expect(() => (conn = make())).not.toThrow()
    expect(delays()).toStrictEqual([500])
    runTimer()
    last().open()
    expect(conn!.state()).toBe('open')
    const p = conn!.transport.invoke('c:x')
    last().serverSend({ t: 'result', id: 1, ok: true, value: 1 })
    await expect(p).resolves.toBe(1)
  })
})

describe('WC-11 transport.on', () => {
  it('WC-11 只收载荷；注销有效；跨重连照收；没人听的忽略；一个监听抛不挡别人', () => {
    const conn = make()
    last().open()
    const a = vi.fn()
    const off = conn.transport.on('agent:event', a)
    last().serverSend({ t: 'push', channel: 'agent:event', args: [{ e: 1 }, 'second'] })
    expect(a.mock.calls).toStrictEqual([[{ e: 1 }, 'second']])

    reconnect()
    last().serverSend({ t: 'push', channel: 'agent:event', args: [{ e: 2 }] })
    expect(a.mock.calls[1]).toStrictEqual([{ e: 2 }])

    expect(() =>
      last().serverSend({ t: 'push', channel: 'nobody:listens', args: [1] })
    ).not.toThrow()

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const thrower = vi.fn(() => {
      throw new Error('listener boom')
    })
    const b = vi.fn()
    conn.transport.on('agent:event', thrower)
    conn.transport.on('agent:event', b)
    last().serverSend({ t: 'push', channel: 'agent:event', args: [{ e: 3 }] })
    expect(thrower).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledWith({ e: 3 })
    expect(consoleError).toHaveBeenCalled()

    off()
    last().serverSend({ t: 'push', channel: 'agent:event', args: [{ e: 4 }] })
    expect(a).toHaveBeenCalledTimes(3)
  })
})

describe('WC-12 旧 socket', () => {
  it('WC-12 重连之后旧 socket 的 onmessage / onopen 不起作用', async () => {
    const conn = make()
    const old = last()
    old.open()
    const listener = vi.fn()
    conn.transport.on('agent:event', listener)
    const onState = vi.fn()
    reconnect()
    const fresh = last()
    conn.onState(onState)
    const p = conn.transport.invoke('c:x')
    expect(fresh.frames()).toStrictEqual([{ t: 'invoke', id: 1, channel: 'c:x', args: [] }])
    old.serverSend({ t: 'result', id: 1, ok: true, value: 'stale' })
    old.serverSend({ t: 'push', channel: 'agent:event', args: [1] })
    old.onopen?.({})
    expect(listener).not.toHaveBeenCalled()
    expect(await settledState(p)).toBe('pending')
    expect(onState).not.toHaveBeenCalled()
    fresh.serverSend({ t: 'result', id: 1, ok: true, value: 'fresh' })
    await expect(p).resolves.toBe('fresh')
  })
})

describe('WC-13 sync', () => {
  it('WC-13 isUp / onUp / onDown / send / onFrame / 注销', () => {
    const conn = make()
    const up = vi.fn()
    const down = vi.fn()
    const frames = vi.fn()
    const offUp = conn.sync.onUp!(up)
    const offDown = conn.sync.onDown!(down)
    const offFrame = conn.sync.onFrame(frames)
    expect(conn.sync.isUp!()).toBe(false)

    // 初次失败：不调 onDown
    last().drop()
    expect(down).not.toHaveBeenCalled()
    runTimer()
    last().open()
    expect(conn.sync.isUp!()).toBe(true)
    expect(up).toHaveBeenCalledTimes(1)

    conn.sync.send('L1', { t: 'hello' } as never)
    expect(last().frames()).toStrictEqual([{ t: 'sync', link: 'L1', frame: { t: 'hello' } }])
    last().serverSend({ t: 'sync', link: 'L1', frame: { t: 'x' } })
    expect(frames.mock.calls).toStrictEqual([['L1', { t: 'x' }]])

    last().drop()
    expect(conn.sync.isUp!()).toBe(false)
    expect(down.mock.calls).toStrictEqual([['disconnected']])
    conn.sync.send('L1', { t: 'dropped' } as never)
    // 重连失败：不调 onDown
    runTimer()
    last().drop()
    expect(down).toHaveBeenCalledTimes(1)
    runTimer()
    last().open()
    expect(up).toHaveBeenCalledTimes(2)
    expect(last().sent).toStrictEqual([])

    offUp()
    offDown()
    offFrame()
    last().serverSend({ t: 'sync', link: 'L1', frame: { t: 'y' } })
    last().drop()
    runTimer()
    last().open()
    expect(up).toHaveBeenCalledTimes(2)
    expect(down).toHaveBeenCalledTimes(1)
    expect(frames).toHaveBeenCalledTimes(1)
  })
})

describe('WC-14 重连后的补发', () => {
  it('WC-14 第一次连上不补发；重连后按顺序补发 DEFAULT_RESYNC_EVENTS，且在 onUp 之后', () => {
    const conn = make()
    const order: string[] = []
    const events: unknown[] = []
    conn.transport.on('app:event', (event) => {
      events.push(event)
      order.push('event')
    })
    conn.sync.onUp!(() => order.push('up'))
    last().open()
    expect(events).toStrictEqual([])
    order.length = 0
    reconnect()
    expect(events).toStrictEqual([...DEFAULT_RESYNC_EVENTS])
    expect(order[0]).toBe('up')
    expect(order.slice(1).every((o) => o === 'event')).toBe(true)
    expect(order).toHaveLength(1 + DEFAULT_RESYNC_EVENTS.length)
  })

  it('WC-14 自定义列表；[] → 不补发', () => {
    const custom = make({ resyncEvents: [{ type: 'bot.changed' }] })
    const got: unknown[] = []
    custom.transport.on('app:event', (event) => got.push(event))
    last().open()
    reconnect()
    expect(got).toStrictEqual([{ type: 'bot.changed' }])

    const none = make({ resyncEvents: [] })
    const nothing = vi.fn()
    none.transport.on('app:event', nothing)
    last().open()
    reconnect()
    expect(nothing).not.toHaveBeenCalled()
  })
})

describe('WC-15 state / onState', () => {
  it('WC-15 connecting → open → reconnecting → open，每次变化一次回调；注销有效', () => {
    const conn = make()
    const seen: string[] = []
    const off = conn.onState((s) => seen.push(s))
    expect(conn.state()).toBe('connecting')
    last().open()
    last().drop()
    runTimer()
    last().drop() // 重连失败：仍是 reconnecting，不回调
    runTimer()
    last().open()
    expect(seen).toStrictEqual(['open', 'reconnecting', 'open'])
    expect(conn.state()).toBe('open')
    off()
    last().drop()
    expect(seen).toHaveLength(3)
    expect(conn.state()).toBe('reconnecting')
  })
})

describe('WC-16 localInvoke', () => {
  it('WC-16 await 后以恰好的参数调；回返回值；不发帧；未连上 / dispose 之后照样', async () => {
    const spy = vi.fn((..._args: unknown[]) => ({ success: true }))
    const conn = make({ localInvoke: { 'app:open-settings': spy } })
    const p = conn.transport.invoke('app:open-settings', 'x')
    expect(spy).not.toHaveBeenCalled()
    await expect(p).resolves.toStrictEqual({ success: true })
    expect(spy.mock.calls).toStrictEqual([['x']])
    last().open()
    await conn.transport.invoke('app:open-settings')
    expect(last().sent).toStrictEqual([])
    conn.dispose()
    await expect(conn.transport.invoke('app:open-settings', 'y')).resolves.toStrictEqual({
      success: true
    })
    expect(spy.mock.calls[2]).toStrictEqual(['y'])
  })

  it('WC-16 抛 → 拒绝；优先于 desktopOnly；只认自有属性', async () => {
    const err = new Error('local boom')
    const conn = make({
      localInvoke: {
        'app:open-external': () => {
          throw err
        },
        'app:open-settings': () => 'local'
      },
      desktopOnly: new Set(['app:open-settings'])
    })
    await expect(conn.transport.invoke('app:open-external')).rejects.toBe(err)
    await expect(conn.transport.invoke('app:open-settings')).resolves.toBe('local')

    const inherited = vi.fn(() => 'inherited')
    const proto = make({ localInvoke: Object.create({ 'x:y': inherited }) })
    last().open()
    void proto.transport.invoke('x:y')
    expect(inherited).not.toHaveBeenCalled()
    expect(last().frames()).toStrictEqual([{ t: 'invoke', id: 1, channel: 'x:y', args: [] }])
  })
})

describe('WC-17 desktopOnly', () => {
  it('WC-17 拒绝、onDesktopOnly 同步一次、不发帧；断着也一样', async () => {
    const onDesktopOnly = vi.fn()
    const conn = make({ desktopOnly: new Set(['app:open-folder']), onDesktopOnly })
    last().open()
    const p = conn.transport.invoke('app:open-folder', '/x')
    expect(onDesktopOnly).toHaveBeenCalledTimes(1)
    expect(onDesktopOnly).toHaveBeenCalledWith('app:open-folder')
    await expect(p).rejects.toMatchObject({
      message: '"app:open-folder" is only available in the desktop app for now',
      code: 'desktop_only'
    })
    expect(last().sent).toStrictEqual([])
    last().drop()
    await expect(conn.transport.invoke('app:open-folder', '/x')).rejects.toMatchObject({
      code: 'desktop_only'
    })
    expect(onDesktopOnly).toHaveBeenCalledTimes(2)
  })
})

describe('WC-18 dispose', () => {
  it("WC-18 连着时：在途拒绝、onDown('disposed')、state closed、close(1000,'disposed')；之后什么也不做", async () => {
    const conn = make()
    const sock = last()
    sock.open()
    const down = vi.fn()
    const states: string[] = []
    conn.sync.onDown!(down)
    conn.onState((s) => states.push(s))
    const inflight = conn.transport.invoke('c:x')
    conn.dispose()
    await expect(inflight).rejects.toMatchObject({ code: 'disconnected' })
    expect(down.mock.calls).toStrictEqual([['disposed']])
    expect(conn.state()).toBe('closed')
    expect(states).toStrictEqual(['closed'])
    expect(conn.sync.isUp!()).toBe(false)
    expect(sock.closeCalls).toStrictEqual([[1000, 'disposed']])

    await expect(conn.transport.invoke('c:y')).rejects.toMatchObject({
      message: 'disconnected',
      code: 'disconnected'
    })
    const sentBefore = sock.sent.length
    conn.transport.send('terminal:write', 'x')
    expect(sock.sent.length).toBe(sentBefore)

    // 旧 socket 的 onclose 迟到：不再 onDown、不重连
    sock.onclose?.({})
    expect(down).toHaveBeenCalledTimes(1)
    expect(timers.setTimeout).not.toHaveBeenCalled()
    expect(createSocket).toHaveBeenCalledTimes(1)

    expect(() => conn.dispose()).not.toThrow()
    expect(sock.closeCalls).toHaveLength(1)
    expect(states).toStrictEqual(['closed'])
  })

  it('WC-18 连上之前：排着的拒绝；不调 onDown；state closed', async () => {
    const conn = make()
    const down = vi.fn()
    conn.sync.onDown!(down)
    const queued = conn.transport.invoke('c:x')
    conn.dispose()
    await expect(queued).rejects.toMatchObject({ code: 'disconnected' })
    expect(down).not.toHaveBeenCalled()
    expect(conn.state()).toBe('closed')
    last().open()
    expect(last().sent).toStrictEqual([])
  })

  it('WC-18 重连计时器挂着：clearTimeout(handle)，不再建 socket', () => {
    const conn = make()
    last().open()
    last().drop()
    expect(pending).toHaveLength(1)
    const handle = pending[0].handle
    conn.dispose()
    expect(timers.clearTimeout).toHaveBeenCalledWith(handle)
    expect(pending).toHaveLength(0)
    expect(createSocket).toHaveBeenCalledTimes(1)
    expect(conn.state()).toBe('closed')
  })
})

describe('WC-19 编不成 JSON 的参数', () => {
  it('WC-19 开着：TypeError 拒绝、不留在途、不影响别的', async () => {
    const conn = make()
    last().open()
    const bad = conn.transport.invoke('c:bad', 10n)
    const good = conn.transport.invoke('c:good')
    const error = await bad.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TypeError)
    expect(last().frames()).toStrictEqual([{ t: 'invoke', id: 2, channel: 'c:good', args: [] }])
    last().serverSend({ t: 'result', id: 1, ok: true, value: 'ignored' })
    last().serverSend({ t: 'result', id: 2, ok: true, value: 'good' })
    await expect(good).resolves.toBe('good')
    const after = conn.transport.invoke('c:after')
    last().drop()
    await expect(after).rejects.toMatchObject({ code: 'disconnected' })
  })

  it('WC-19 排着的：连上时拒绝，别的照发', async () => {
    const conn = make()
    const a = conn.transport.invoke('c:a')
    const bad = conn.transport.invoke('c:bad', 10n)
    const c = conn.transport.invoke('c:c')
    last().open()
    await expect(bad).rejects.toBeInstanceOf(TypeError)
    expect(
      last()
        .frames()
        .map((f) => (f as { channel: string }).channel)
    ).toStrictEqual(['c:a', 'c:c'])
    last().serverSend({ t: 'result', id: 1, ok: true, value: 'A' })
    last().serverSend({ t: 'result', id: 3, ok: true, value: 'C' })
    await expect(a).resolves.toBe('A')
    await expect(c).resolves.toBe('C')
  })
})

describe('WC-20 服务端的垃圾', () => {
  it('WC-20 非 JSON / 未知 t / 未知 id 的结果 → 忽略、不抛', async () => {
    const conn = make()
    last().open()
    const p = conn.transport.invoke('c:x')
    expect(() => last().raw('nope')).not.toThrow()
    expect(() => last().raw(JSON.stringify({ t: 'weird', id: 1 }))).not.toThrow()
    expect(() => last().raw(42)).not.toThrow()
    expect(() => last().serverSend({ t: 'result', id: 99, ok: true, value: 1 })).not.toThrow()
    expect(await settledState(p)).toBe('pending')
    last().serverSend({ t: 'result', id: 1, ok: true, value: 'ok' })
    await expect(p).resolves.toBe('ok')
  })
})

describe('WC-21 DEFAULT_RESYNC_EVENTS', () => {
  it('WC-21 15 条、type 不重复、含 network.changed / session.listChanged / daily.changed / tracking.changed / trigger.logged、每条只有 type', () => {
    expect(DEFAULT_RESYNC_EVENTS).toHaveLength(15)
    const types = DEFAULT_RESYNC_EVENTS.map((e) => e.type)
    expect(new Set(types).size).toBe(15)
    expect(types).toContain('network.changed')
    expect(types).toContain('session.listChanged')
    // 断线期间写过的日报：重连后日历的点与摘录要跟上
    expect(types).toContain('daily.changed')
    // 断线期间 bot 整理过的跟踪项（实验）：重连后侧栏分组要跟上
    expect(types).toContain('tracking.changed')
    // 断线期间新记的触发日志：重连后设置 → 触发源 一页要跟上
    expect(types).toContain('trigger.logged')
    for (const event of DEFAULT_RESYNC_EVENTS) expect(Object.keys(event)).toStrictEqual(['type'])
  })
})
