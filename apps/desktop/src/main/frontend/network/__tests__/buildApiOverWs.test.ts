/**
 * 浏览器的 `window.api`（渲染端 `createWebApi` + `createWsConnection`）经线协议接到**真的**分发器与网络传输上（server mode
 * phase B/C）：处理函数收到的参数与经 IPC 时一样，结果 / 错误 / 推送 / 视图同步帧原样往返。socket 是假的：`send` 把帧解码后
 * 交分发器（invoke 的结果在微任务里经 `onmessage` 回来），网络传输上的假连接把推送交回 `onmessage`。
 * IPC 的基准：同一张表 + 记录型传输建出来的 api，记下 `transport.invoke` 收到的位置参数（就是 preload 交给 ipcRenderer.invoke 的）。
 *
 *   BW-1  tools.list / agent.getInfo 的各种调用：处理函数在 ctx 之后收到的参数与 IPC 基准严格相等（长度 2、undefined 的位置在、
 *         多给的丢掉）
 *   BW-2  结果：undefined → 恰是 undefined；null → null；{a:undefined,b:1} → {b:1}；[1,undefined] → [1,null]（JSON 的已知限度）
 *   BW-3  处理函数抛 → 以 Error 拒绝，message 原样，code 'handler_error'（或它自己的字符串 code）
 *   BW-4  桌面专属：本地拒（desktop_only，不发帧、服务端 spy 不调）；本地不拒时服务端拒（desktop_only，spy 照样不调）
 *   BW-5  send：terminal.write → listen spy (ctx, params)；app.windowReady() → spy 只收到 ctx
 *   BW-6  事件：agent.onEvent 恰收到 [ev]（多的载荷丢掉）；app.onNewChat 收到 []
 *   BW-7  events.subscribe 两个订阅者都收到；底下只挂一个 'app:event' 监听
 *   BW-8  liveDoc.respond('r', res) → (ctx, {requestId, result})；knowledge.baseOptions() → (ctx, {})
 *   BW-9  直接 invoke 推送通道 agent:event / sync:frame → unknown_channel
 *   BW-10 sync.send('L1', HELLO) → socket 收到 {t:'sync', link, frame}；app.platform === 'web'
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_TABLE } from '../../../../shared/apiTable'
import { buildApi, createCommonOverrides, type ApiTransport } from '../../../../shared/buildApi'
import {
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage
} from '../../../../shared/networkEnvelope'
/* eslint-disable boundaries/dependencies -- 线协议的两头（渲染端的 web 客户端与主进程的分发器）在一个用例里接起来 */
import {
  createWsConnection,
  type WebSocketLike,
  type WsConnection
} from '../../../../renderer/src/web/wsConnection'
import {
  createWebApi,
  webDesktopOnlyChannels,
  webLocalHandlers
} from '../../../../renderer/src/web/webApi'
/* eslint-enable boundaries/dependencies */
import { createNetworkDispatcher, type NetworkDispatcher } from '../dispatch'
import { createNetworkTransport, type NetworkTransport } from '../transport'
import { fakeConnection, netClient, netCtx } from './support/fakeNetworkConnection'

const HELLO = { t: 'hello', name: 'renderer', kind: 'client', epoch: 1 }

class FakeSocket implements WebSocketLike {
  readyState = 0
  readonly sent: string[] = []
  onopen: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(private readonly dispatcher: NetworkDispatcher) {}

  send(data: string): void {
    this.sent.push(data)
    const message = decodeClientMessage(data)
    if (message === undefined) return
    if (message.t === 'invoke') {
      void this.dispatcher
        .invoke(netCtx(1), message)
        .then((result) => queueMicrotask(() => this.deliver(encodeServerMessage(result))))
    } else if (message.t === 'send') {
      this.dispatcher.send(netCtx(1), message)
    }
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  deliver(data: string): void {
    this.onmessage?.({ data })
  }

  frames(): ClientMessage[] {
    return this.sent.map((text) => decodeClientMessage(text)!)
  }
}

const fakeWin = {
  location: { origin: 'http://192.168.1.10:7766', pathname: '/' },
  open: vi.fn()
}

let transport: NetworkTransport
let sock: FakeSocket
let conn: WsConnection
let api: ReturnType<typeof createWebApi>
const spies = {
  toolsList: vi.fn(),
  getInfo: vi.fn(),
  liveDocRespond: vi.fn(),
  baseOptions: vi.fn(),
  openFolder: vi.fn(),
  pinChatPin: vi.fn(),
  terminalWrite: vi.fn(),
  windowReady: vi.fn()
}

function setup(desktopOnly: ReadonlySet<string>): void {
  transport = createNetworkTransport()
  transport.serve({ kind: 'handle', channel: 'tools:list', fn: spies.toolsList })
  transport.serve({ kind: 'handle', channel: 'agent:getInfo', fn: spies.getInfo })
  transport.serve({ kind: 'handle', channel: 'liveDoc:respond', fn: spies.liveDocRespond })
  transport.serve({ kind: 'handle', channel: 'knowledge:baseOptions', fn: spies.baseOptions })
  transport.serve({ kind: 'handle', channel: 'app:open-folder', fn: spies.openFolder })
  transport.serve({ kind: 'handle', channel: 'pinChat:pin', fn: spies.pinChatPin })
  transport.serve({ kind: 'listen', channel: 'terminal:write', fn: spies.terminalWrite })
  transport.serve({ kind: 'listen', channel: 'app:window-ready', fn: spies.windowReady })
  const dispatcher = createNetworkDispatcher({ definitionOf: transport.definitionOf })
  sock = new FakeSocket(dispatcher)
  const connection = fakeConnection(netClient(1))
  connection.onSend = (message) => sock.deliver(encodeServerMessage(message))
  transport.add(connection)
  conn = createWsConnection({ url: 'ws://x/ws', createSocket: () => sock, desktopOnly })
  sock.open()
  api = createWebApi(conn)
}

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockReset()
  setup(new Set())
})

/** IPC 基准：preload 交给 ipcRenderer.invoke 的位置参数（通道之后的） */
function ipcArgs(call: (ipcApi: ReturnType<typeof createWebApi>) => unknown): unknown[] {
  const calls: unknown[][] = []
  const recording: ApiTransport = {
    invoke: (_channel, ...args) => {
      calls.push(args)
      return Promise.resolve(undefined)
    },
    send: () => {},
    on: () => () => {}
  }
  const ipcApi = buildApi(API_TABLE, recording, createCommonOverrides(recording))
  call(ipcApi as unknown as ReturnType<typeof createWebApi>)
  expect(calls).toHaveLength(1)
  return calls[0]
}

describe('BW-1 参数与 IPC 一致', () => {
  const cases: Array<[string, (a: ReturnType<typeof createWebApi>) => Promise<unknown>]> = [
    ['tools.list(undefined, {profile})', (a) => a.tools.list(undefined, { profile: 'chat' })],
    ['tools.list()', (a) => a.tools.list()],
    ["tools.list('s1')", (a) => a.tools.list('s1')],
    ["agent.getInfo('s1')", (a) => a.agent.getInfo('s1')],
    ["tools.list('s1', {}, 'extra')", (a) => a.tools.list('s1', {}, 'extra')]
  ]

  it.each(cases)('BW-1 %s', async (_name, call) => {
    const baseline = ipcArgs(call)
    spies.toolsList.mockImplementation(() => 'ok')
    spies.getInfo.mockImplementation(() => 'ok')
    await expect(call(api)).resolves.toBe('ok')
    const spy = spies.toolsList.mock.calls.length > 0 ? spies.toolsList : spies.getInfo
    expect(spy).toHaveBeenCalledTimes(1)
    const [ctx, ...args] = spy.mock.calls[0]
    expect(ctx).toStrictEqual(netCtx(1))
    expect(args).toStrictEqual(baseline)
    expect(args).toHaveLength(2)
    baseline.forEach((value, index) => {
      expect(index in args).toBe(true)
      if (value === undefined) expect(args[index]).toBeUndefined()
    })
  })
})

describe('BW-2 结果', () => {
  it('BW-2 undefined / null / 对象里的 undefined / 数组里的 undefined', async () => {
    spies.toolsList.mockReturnValueOnce(undefined)
    const first = await api.tools.list()
    expect(first).toBeUndefined()
    spies.toolsList.mockReturnValueOnce(null)
    expect(await api.tools.list()).toBeNull()
    spies.toolsList.mockReturnValueOnce({ a: undefined, b: 1 })
    expect(await api.tools.list()).toStrictEqual({ b: 1 })
    spies.toolsList.mockReturnValueOnce([1, undefined])
    expect(await api.tools.list()).toStrictEqual([1, null])
  })
})

describe('BW-3 错误', () => {
  it("BW-3 抛 → Error，message 原样，code 'handler_error' 或它自己的", async () => {
    spies.toolsList.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const error = await api.tools.list().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('boom')
    expect((error as { code?: string }).code).toBe('handler_error')

    spies.toolsList.mockImplementationOnce(() => {
      throw Object.assign(new Error('coded'), { code: 'E_X' })
    })
    await expect(api.tools.list()).rejects.toMatchObject({ message: 'coded', code: 'E_X' })
  })
})

describe('BW-4 桌面专属', () => {
  it('BW-4 本地拒：desktop_only，不发帧，服务端 spy 不调', async () => {
    // phase D：app:open-folder 在浏览器里有本地实现（显示路径）；仍当场拒的是悬浮窗这类浏览器里没有的东西
    setup(webDesktopOnlyChannels(webLocalHandlers(fakeWin)))
    const before = sock.sent.length
    await expect(api.pinChat.pin('s1')).rejects.toMatchObject({ code: 'desktop_only' })
    expect(sock.sent.length).toBe(before)
    expect(spies.pinChatPin).not.toHaveBeenCalled()
  })

  it('BW-4 本地不拒：服务端拒（desktop_only），spy 照样不调', async () => {
    await expect(api.app.openFolder('/x')).rejects.toMatchObject({
      message: '"app:open-folder" is only available in the desktop app for now',
      code: 'desktop_only'
    })
    expect(sock.frames().some((f) => f.t === 'invoke' && f.channel === 'app:open-folder')).toBe(
      true
    )
    expect(spies.openFolder).not.toHaveBeenCalled()
  })
})

describe('BW-5 send', () => {
  it('BW-5 terminal.write → (ctx, params)；windowReady → 只有 ctx', () => {
    api.terminal.write({ terminalId: 't', data: 'x' })
    expect(spies.terminalWrite).toHaveBeenCalledTimes(1)
    expect(spies.terminalWrite.mock.calls[0]).toStrictEqual([
      netCtx(1),
      { terminalId: 't', data: 'x' }
    ])
    api.app.windowReady()
    expect(spies.windowReady).toHaveBeenCalledTimes(1)
    expect(spies.windowReady.mock.calls[0]).toHaveLength(1)
    expect(spies.windowReady.mock.calls[0][0]).toStrictEqual(netCtx(1))
  })
})

describe('BW-6 事件', () => {
  it('BW-6 agent.onEvent 恰收到 [ev]；多的载荷丢掉', () => {
    const cb = vi.fn()
    api.agent.onEvent(cb)
    const ev = { type: 'agent_start', sessionId: 's1' }
    transport.pushTo(netClient(1), 'agent:event', [ev])
    expect(cb.mock.calls).toStrictEqual([[ev]])
    transport.pushTo(netClient(1), 'agent:event', [ev, 'extra'])
    expect(cb.mock.calls[1]).toStrictEqual([ev])
  })

  it('BW-6 app.onNewChat 收到 []', () => {
    const cb = vi.fn()
    api.app.onNewChat(cb)
    transport.pushTo(netClient(1), 'app:new-chat', [])
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]).toStrictEqual([])
  })
})

describe('BW-7 events.subscribe', () => {
  it('BW-7 两个订阅者都收到；底下只挂一个 app:event 监听', () => {
    const on = vi.spyOn(conn.transport, 'on')
    const a = vi.fn()
    const b = vi.fn()
    api.events.subscribe(a)
    api.events.subscribe(b)
    transport.broadcast('app:event', [{ type: 'session.listChanged' }])
    expect(a).toHaveBeenCalledWith({ type: 'session.listChanged' })
    expect(b).toHaveBeenCalledWith({ type: 'session.listChanged' })
    expect(on.mock.calls.filter(([channel]) => channel === 'app:event')).toHaveLength(1)
  })
})

describe('BW-8 override 通道', () => {
  it('BW-8 liveDoc.respond / knowledge.baseOptions', async () => {
    spies.liveDocRespond.mockReturnValue({ success: false })
    spies.baseOptions.mockReturnValue({ options: [], selected: [], explicit: false })
    const res = { ok: true, text: 'x' }
    await expect(api.liveDoc.respond('r', res as never)).resolves.toStrictEqual({ success: false })
    expect(spies.liveDocRespond.mock.calls[0]).toStrictEqual([
      netCtx(1),
      { requestId: 'r', result: res }
    ])
    await api.knowledge.baseOptions()
    expect(spies.baseOptions.mock.calls[0]).toStrictEqual([netCtx(1), {}])
  })
})

describe('BW-9 推送通道不能 invoke', () => {
  it('BW-9 agent:event / sync:frame → unknown_channel', async () => {
    await expect(conn.transport.invoke('agent:event')).rejects.toMatchObject({
      code: 'unknown_channel'
    })
    await expect(conn.transport.invoke('sync:frame')).rejects.toMatchObject({
      code: 'unknown_channel'
    })
  })
})

describe('BW-10 视图同步与平台', () => {
  it("BW-10 sync.send → {t:'sync', link, frame}；platform 'web'", () => {
    api.sync.send('L1', HELLO as never)
    expect(sock.frames().at(-1)).toStrictEqual({ t: 'sync', link: 'L1', frame: HELLO })
    expect(api.app.platform).toBe('web')
  })
})
