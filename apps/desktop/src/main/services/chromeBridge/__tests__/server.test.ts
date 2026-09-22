/**
 * Chrome 桥服务（桌面这一端）—— 本地组件连进来的 socket：鉴权、握手、双向请求与事件、分片、连接登记。
 *
 * 每条用例一个新的 `ChromeBridgeServer`（不用进程单例），监听在临时目录里的真 unix socket 上；
 * 测试客户端 setEncoding('utf8') 按行收。劈开多字节字符、鉴权超时这两条用假 socket（EventEmitter）
 * 直接构造 `BridgeConnection`，好控制每一次 `data` 的字节边界与时钟。
 *
 *   CBS-1      start：替换残留文件、补建父目录、socket 0600、重复 start 不动
 *   CBS-2/3/20 鉴权：token 不对 / 不是字符串 / 不是对象 / 首行不是 JSON / 桌面没有 token → 断开且一字不回；
 *              对了恰回一行 {"auth":"ok"}
 *   CBS-4~7    握手：就绪（openTabIds 只留整数）、协议不符（mismatch）、缺 installId / runId（不理）、
 *              握手前的请求回 not-ready、事件不派发
 *   CBS-8~11   请求：扩展 → 桌面的结果 / 错误映射；桌面 → 扩展的 request（id、错误、超时、断开时全部失败）
 *   CBS-12/13  分片：出站超 1 MB 自动分片且每片不超上限；入站分片与别的消息交错也拼得回
 *   CBS-14~17  连接登记：同 installId 让位、onClose 只给就绪过的、onChange、事件先内部后上层
 *   CBS-18/19  按行切：一次 write 两条、一条跨两次 write、空行、坏行；多字节字符劈在两个 Buffer 之间
 *   CBS-21~23  statuses 新的在前；stop 后能在同一路径重启；checkToken
 *   CBS-24~27  鉴权超时（10s，计时器 unref）；stop 关掉没鉴权 / 没握手的连接；同一连接第二个 hello 不理；
 *              onConnectionReady 先于上层 onReady
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter, once } from 'events'
import { connect, type Socket } from 'net'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BridgeChunkAssembler,
  CHROME_BRIDGE_PROTOCOL,
  CHROME_NATIVE_MESSAGE_MAX_BYTES,
  splitBridgeMessage,
  type BridgeChunk,
  type BridgeMessage
} from '@shuvix/chat-protocol/chromeBridge'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  BridgeConnection,
  CHROME_DISCONNECTED_ERROR,
  ChromeBridgeServer,
  type ChromeBridgeHandlers
} from '../server'

const MAX = CHROME_NATIVE_MESSAGE_MAX_BYTES
const TOKEN = 'tok-bridge-server'
const AUTH_LINE = JSON.stringify({ auth: TOKEN })
const AUTH_OK = '{"auth":"ok"}'
const WAIT = { timeout: 5000, interval: 5 }

type Message = Record<string, unknown>

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

const helloOf = (over: Message = {}): Message => ({
  type: 'hello',
  protocol: CHROME_BRIDGE_PROTOCOL,
  extensionVersion: '0.3.0',
  installId: 'i1',
  runId: 'r1',
  browser: 'Chrome 140',
  openTabIds: [],
  ...over
})

/** 测试客户端（扮演本地组件）：按行收，setEncoding('utf8') */
class Client {
  readonly socket: Socket
  readonly lines: string[] = []
  received = ''
  closed = false
  private rest = ''

  constructor(path: string) {
    this.socket = connect(path)
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => {
      this.received += chunk
      this.rest += chunk
      const parts = this.rest.split('\n')
      this.rest = parts.pop() ?? ''
      this.lines.push(...parts)
    })
    this.socket.on('error', () => {})
    this.socket.on('close', () => {
      this.closed = true
    })
  }

  messages(from = 0): Message[] {
    return this.lines
      .slice(from)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Message)
  }

  send(value: unknown): void {
    this.socket.write(JSON.stringify(value) + '\n')
  }

  write(text: string | Buffer): void {
    this.socket.write(text)
  }

  async auth(token = TOKEN): Promise<void> {
    this.send({ auth: token })
    await vi.waitFor(() => expect(this.lines).toContain(AUTH_OK), WAIT)
  }

  /** 说 hello，等 welcome */
  async hello(over: Message = {}): Promise<Message> {
    const from = this.lines.length
    this.send(helloOf(over))
    return vi.waitFor(() => {
      const welcome = this.messages(from).find((m) => m.type === 'welcome')
      expect(welcome).toBeDefined()
      return welcome!
    }, WAIT)
  }

  /** 鉴权 + 握手成功 */
  async ready(over: Message = {}): Promise<void> {
    await this.auth()
    expect(await this.hello(over)).toEqual({ type: 'welcome', protocol: 1, ok: true })
  }

  /** 等一条满足条件的消息 */
  waitFor(predicate: (m: Message) => boolean, from = 0): Promise<Message> {
    return vi.waitFor(() => {
      const hit = this.messages(from).find(predicate)
      expect(hit).toBeDefined()
      return hit!
    }, WAIT)
  }

  close(): void {
    this.socket.destroy()
  }
}

/** 假 socket：只有 on / emit / write / destroy —— 直接喂 Buffer 给 BridgeConnection */
class FakeSocket extends EventEmitter {
  write = vi.fn((_data: string) => true)
  destroy = vi.fn()
}

let dir: string
let sockPath: string
const servers: ChromeBridgeServer[] = []
const clients: Client[] = []

function track(server: ChromeBridgeServer): ChromeBridgeServer {
  servers.push(server)
  return server
}

async function startServer(
  handlers: ChromeBridgeHandlers = {},
  getToken: () => string = () => TOKEN
): Promise<ChromeBridgeServer> {
  const server = track(new ChromeBridgeServer())
  server.setHandlers(handlers)
  await server.start({ socketPath: sockPath, getToken })
  return server
}

function client(path = sockPath): Client {
  const c = new Client(path)
  clients.push(c)
  return c
}

/** 一个就绪的连接：服务端的 BridgeConnection 与客户端 */
async function readyPair(
  handlers: ChromeBridgeHandlers = {},
  over: Message = {}
): Promise<{ server: ChromeBridgeServer; c: Client; conn: BridgeConnection }> {
  const server = await startServer(handlers)
  const c = client()
  await c.ready(over)
  const conn = server.connectionFor((over.installId as string) ?? 'i1')
  expect(conn).toBeDefined()
  return { server, c, conn: conn! }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-'))
  sockPath = join(dir, 's.sock')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const c of clients.splice(0)) c.close()
  for (const server of servers.splice(0)) server.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('ChromeBridgeServer —— 真 unix socket', () => {
  it('CBS-1 start：残留的普通文件被换成 socket（0600）、缺的父目录补建；再 start 一次什么也不动', async () => {
    writeFileSync(sockPath, 'stale')
    const server = await startServer()
    expect(server.listening).toBe(true)
    const st = statSync(sockPath)
    expect(st.isSocket()).toBe(true)
    expect(st.mode & 0o777).toBe(0o600)
    await client().auth()

    const other = join(dir, 'other.sock')
    await server.start({ socketPath: other, getToken: () => 'another-token' })
    expect(existsSync(other)).toBe(false)
    // 仍是原来那次 start 的地址与 token
    await client().auth(TOKEN)

    const nested = join(dir, 'a', 'b', 's.sock')
    const second = track(new ChromeBridgeServer())
    await second.start({ socketPath: nested, getToken: () => TOKEN })
    expect(statSync(join(dir, 'a', 'b')).isDirectory()).toBe(true)
    expect(statSync(nested).isSocket()).toBe(true)
    await client(nested).auth()
  })

  it.each<[string, unknown]>([
    ['token 不对（长度不同）', { auth: 'wrong' }],
    ['token 同长不同值', { auth: TOKEN.slice(0, -1) + 'Z' }],
    ['token 多一个字符', { auth: TOKEN + 'x' }],
    ['token 不是字符串', { auth: 123 }],
    ['没有 auth', {}],
    ['null', null],
    ['一个 JSON 字符串', 'x']
  ])('CBS-2 鉴权行%s：断开，客户端一个字节也收不到', async (_label, line) => {
    await startServer()
    const c = client()
    c.send(line)
    await vi.waitFor(() => expect(c.closed).toBe(true), WAIT)
    expect(c.received).toBe('')
  })

  it('CBS-2 桌面这边拿不到 token（getToken 回空串）：连空 token 也不认', async () => {
    await startServer({}, () => '')
    for (const token of ['', TOKEN]) {
      const c = client()
      c.send({ auth: token })
      await vi.waitFor(() => expect(c.closed).toBe(true), WAIT)
      expect(c.received).toBe('')
    }
  })

  it('CBS-3 token 对：恰回一行 {"auth":"ok"}，此外什么也不说', async () => {
    await startServer()
    const c = client()
    await c.auth()
    await settle()
    expect(c.received).toBe(AUTH_OK + '\n')
    expect(c.closed).toBe(false)
  })

  it('CBS-4 hello（协议 1）：welcome ok；连接就绪、info 齐全；onReady 恰一次且 openTabIds 只留整数；statuses 一条 ready；onChange 触发', async () => {
    const onReady = vi.fn()
    const server = await startServer({ onReady })
    const onChange = vi.fn()
    server.onChange(onChange)
    const c = client()
    await c.auth()

    const welcome = await c.hello({ openTabIds: [1, '2', 3.5, null, 4] })
    expect(welcome).toEqual({ type: 'welcome', protocol: 1, ok: true })

    const conn = server.connectionFor('i1')!
    expect(conn.ready).toBe(true)
    expect(conn.info).toEqual({
      installId: 'i1',
      runId: 'r1',
      browser: 'Chrome 140',
      extensionVersion: '0.3.0',
      connectedAt: expect.any(Number)
    })
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith(
      conn,
      expect.objectContaining({ installId: 'i1', runId: 'r1', openTabIds: [1, 4] })
    )
    expect(server.statuses()).toEqual([{ ...conn.info, state: 'ready', protocol: 1 }])
    expect(server.readyConnections()).toEqual([conn])
    expect(onChange).toHaveBeenCalled()
  })

  it('CBS-5 hello 协议不符（2）：welcome ok=false / protocol-mismatch；statuses 记为 mismatch；不算就绪、不调 onReady；请求回 protocol-mismatch；断开不调 onClose', async () => {
    const onReady = vi.fn()
    const onClose = vi.fn()
    const onRequest = vi.fn(async () => 'never')
    const onEvent = vi.fn()
    const server = await startServer({ onReady, onClose, onRequest, onEvent })
    const c = client()
    await c.auth()

    expect(await c.hello({ protocol: 2 })).toEqual({
      type: 'welcome',
      protocol: 1,
      ok: false,
      error: 'protocol-mismatch'
    })
    expect(server.statuses()).toEqual([
      expect.objectContaining({ installId: 'i1', state: 'mismatch', protocol: 2 })
    ])
    expect(server.connectionFor('i1')).toBeUndefined()
    expect(server.readyConnections()).toEqual([])
    expect(onReady).not.toHaveBeenCalled()

    c.send({ type: 'event', name: 'tabs.removed', params: { tabId: 1 } })
    c.send({ type: 'request', id: 'x1', method: 'tabSession.open', params: { tabId: 1 } })
    expect(await c.waitFor((m) => m.type === 'response')).toEqual({
      type: 'response',
      id: 'x1',
      ok: false,
      error: 'protocol-mismatch'
    })
    expect(onRequest).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()

    c.close()
    await vi.waitFor(() => expect(server.statuses()).toEqual([]), WAIT)
    await settle()
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each<[string, Message]>([
    ['缺 installId', { installId: undefined }],
    ["installId 是 ''", { installId: '' }],
    ['installId 不是字符串', { installId: 5 }],
    ['缺 runId', { runId: undefined }],
    ["runId 是 ''", { runId: '' }],
    ['runId 不是字符串', { runId: 5 }]
  ])(
    'CBS-6 hello %s：不理（不回 welcome、不登记）；请求回 not-ready；之后一个合法的 hello 照常握手',
    async (_label, over) => {
      const onReady = vi.fn()
      const server = await startServer({ onReady })
      const c = client()
      await c.auth()

      c.send(helloOf(over))
      c.send({ type: 'request', id: 'q1', method: 'tabSession.open', params: { tabId: 1 } })
      expect(await c.waitFor((m) => m.type === 'response')).toEqual({
        type: 'response',
        id: 'q1',
        ok: false,
        error: 'not-ready'
      })
      expect(c.messages().some((m) => m.type === 'welcome')).toBe(false)
      expect(server.statuses()).toEqual([])
      expect(onReady).not.toHaveBeenCalled()

      expect(await c.hello()).toEqual({ type: 'welcome', protocol: 1, ok: true })
      expect(server.connectionFor('i1')?.ready).toBe(true)
    }
  )

  it('CBS-7 握手之前：请求回 not-ready（不进处理器）；事件既不进内部也不进上层', async () => {
    const onRequest = vi.fn(async () => 'never')
    const onEvent = vi.fn()
    const server = await startServer({ onRequest, onEvent })
    const internal = vi.fn()
    server.onExtensionEvent(internal)
    const c = client()
    await c.auth()

    c.send({ type: 'event', name: 'tabs.removed', params: { tabId: 1 } })
    c.send({ type: 'request', id: 'q1', method: 'tabSession.open', params: {} })
    expect(await c.waitFor((m) => m.type === 'response')).toEqual({
      type: 'response',
      id: 'q1',
      ok: false,
      error: 'not-ready'
    })
    await settle()
    expect(onRequest).not.toHaveBeenCalled()
    expect(onEvent).not.toHaveBeenCalled()
    expect(internal).not.toHaveBeenCalled()
  })

  it.each<[string, ChromeBridgeHandlers['onRequest'] | undefined, Message]>([
    ['回 {x:1}', async () => ({ x: 1 }), { ok: true, result: { x: 1 } }],
    ['回 undefined', async () => undefined, { ok: true, result: null }],
    [
      "抛 Error('boom')",
      async () => {
        throw new Error('boom')
      },
      { ok: false, error: 'boom' }
    ],
    [
      "抛字符串 'plain'",
      async () => {
        throw 'plain'
      },
      { ok: false, error: 'plain' }
    ],
    ['没挂处理器', undefined, { ok: false, error: 'Unknown method "m".' }]
  ])('CBS-8 扩展发来的请求，处理器%s → 回应映射', async (_label, onRequest, expected) => {
    const handler = onRequest ? vi.fn(onRequest) : undefined
    const { c, conn } = await readyPair(handler ? { onRequest: handler } : {})

    c.send({ type: 'request', id: 'p1', method: 'm', params: { a: [1, '二'] } })
    expect(await c.waitFor((m) => m.type === 'response')).toEqual({
      type: 'response',
      id: 'p1',
      ...expected
    })
    if (handler) expect(handler).toHaveBeenCalledWith(conn, 'm', { a: [1, '二'] })
  })

  it('CBS-9 conn.request：客户端看到 {type:request,id:d<n>,method,params}；答 ok → resolve；答错 → reject（无错误文本时给默认句）；未知 id / 第二次回答不理', async () => {
    const { c, conn } = await readyPair()
    const requestOf = async (method: string, seen: Set<unknown>): Promise<Message> => {
      const req = await c.waitFor(
        (m) => m.type === 'request' && m.method === method && !seen.has(m.id)
      )
      seen.add(req.id)
      return req
    }
    const seen = new Set<unknown>()

    const first = conn.request('tabs.get', { tabId: 1 })
    const req1 = await requestOf('tabs.get', seen)
    expect(req1).toEqual({
      type: 'request',
      id: expect.stringMatching(/^d\d+$/),
      method: 'tabs.get',
      params: { tabId: 1 }
    })
    c.send({ type: 'response', id: req1.id, ok: true, result: { id: 1, title: 'A' } })
    await expect(first).resolves.toEqual({ id: 1, title: 'A' })

    const second = conn.request('tabs.remove', { tabId: 2 })
    const req2 = await requestOf('tabs.remove', seen)
    expect(req2.id).not.toBe(req1.id)
    c.send({ type: 'response', id: req2.id, ok: false, error: 'No tab with id: 2.' })
    await expect(second).rejects.toThrow('No tab with id: 2.')

    const third = conn.request('tabs.remove', { tabId: 3 })
    const req3 = await requestOf('tabs.remove', seen)
    c.send({ type: 'response', id: req3.id, ok: false })
    await expect(third).rejects.toThrow('Chrome reported an error.')

    const fourth = conn.request('tabs.get', { tabId: 4 })
    const req4 = await requestOf('tabs.get', seen)
    c.send({ type: 'response', id: 'nope', ok: true, result: 'wrong' })
    c.send({ type: 'response', id: req1.id, ok: false, error: 'a second answer' })
    c.send({ type: 'response', id: req4.id, ok: true, result: 'right' })
    await expect(fourth).resolves.toBe('right')
    await settle()
    expect(conn.ready).toBe(true)
  })

  it('CBS-10 超时：{timeoutMs:30} 无人答 → reject「Chrome did not answer "tabs.get" within Ns.」；迟到的回答被忽略、不留未处理的 reject', async () => {
    const { c, conn } = await readyPair()
    const pending = conn.request('tabs.get', { tabId: 1 }, { timeoutMs: 30 })
    await expect(pending).rejects.toThrow(/^Chrome did not answer "tabs\.get" within \d+s\.$/)

    const req = await c.waitFor((m) => m.type === 'request')
    c.send({ type: 'response', id: req.id, ok: true, result: null })
    await settle()
    expect(conn.ready).toBe(true)
  })

  it('CBS-11 断开：挂着的三个请求都以 CHROME_DISCONNECTED_ERROR 失败；之后 request 当场失败、emit 不写；ready 为 false', async () => {
    const { c, conn } = await readyPair()
    const all = Promise.allSettled([1, 2, 3].map((tabId) => conn.request('tabs.get', { tabId })))
    await vi.waitFor(
      () => expect(c.messages().filter((m) => m.type === 'request')).toHaveLength(3),
      WAIT
    )

    c.close()
    const results = await all
    for (const result of results) {
      expect(result.status).toBe('rejected')
      expect((result as PromiseRejectedResult).reason.message).toBe(CHROME_DISCONNECTED_ERROR)
    }
    expect(CHROME_DISCONNECTED_ERROR).toBe('Chrome is no longer connected to ShuviX.')

    await expect(conn.request('tabs.get', { tabId: 9 })).rejects.toThrow(CHROME_DISCONNECTED_ERROR)
    const send = vi.spyOn(conn, 'send')
    conn.emit('chat.event', { sessionId: 's', event: { type: 'text_delta' } })
    expect(send).not.toHaveBeenCalled()
    expect(conn.ready).toBe(false)
    expect(conn.alive).toBe(false)
  })

  it('CBS-12 出站超 1 MB 自动分片：只发分片行（≥2）、每行不超上限、一个 id、seq 连续、total 不变、拼回原事件；小事件就是一行', async () => {
    const { c, conn } = await readyPair()

    const receive = async (from: number): Promise<string[]> =>
      vi.waitFor(
        () => {
          const lines = c.lines.slice(from)
          expect(lines.length).toBeGreaterThan(0)
          const first = JSON.parse(lines[0]) as BridgeChunk
          expect(first.type).toBe('chunk')
          expect(lines).toHaveLength(first.total)
          return lines
        },
        { timeout: 10_000, interval: 20 }
      )

    for (const text of ['x'.repeat(2_500_000), '中'.repeat(700_000)]) {
      const params = { sessionId: 's', event: { text } }
      const from = c.lines.length
      conn.emit('chat.event', params)
      const lines = await receive(from)

      expect(lines.length).toBeGreaterThanOrEqual(2)
      for (const line of lines) expect(byteLength(line)).toBeLessThanOrEqual(MAX)
      const chunks = lines.map((line) => JSON.parse(line) as BridgeChunk)
      expect(new Set(chunks.map((ch) => ch.id)).size).toBe(1)
      expect(chunks.map((ch) => ch.seq)).toEqual(chunks.map((_, i) => i))
      expect(new Set(chunks.map((ch) => ch.total))).toEqual(new Set([chunks.length]))
      const assembler = new BridgeChunkAssembler()
      let whole: BridgeMessage | null = null
      for (const chunk of chunks) whole = assembler.push(chunk) ?? whole
      expect(whole).toEqual({ type: 'event', name: 'chat.event', params })
    }

    const from = c.lines.length
    conn.emit('chat.event', { sessionId: 's', event: { text: 'small' } })
    await vi.waitFor(() => expect(c.lines.length).toBe(from + 1), WAIT)
    await settle()
    expect(c.lines.slice(from)).toEqual([
      JSON.stringify({
        type: 'event',
        name: 'chat.event',
        params: { sessionId: 's', event: { text: 'small' } }
      })
    ])
  })

  it('CBS-13 入站分片：请求被拆成多片、中间夹一条别的事件 —— 事件照常先处理，请求拼齐后处理器恰调一次、参数一字不差', async () => {
    const order: string[] = []
    const onRequest = vi.fn(async (_c: BridgeConnection, method: string, params: unknown) => {
      order.push(`request:${method}`)
      return { echoed: params }
    })
    const onEvent = vi.fn((_c: BridgeConnection, name: string) => {
      order.push(`event:${name}`)
    })
    const { c, conn } = await readyPair({ onRequest, onEvent })

    const request: BridgeMessage = {
      type: 'request',
      id: 'up1',
      method: 'channel.call',
      params: { path: 'agent.prompt', args: ['s1', '长文本 😀 '.repeat(40)] }
    }
    const pieces = splitBridgeMessage(request, {
      newId: () => 'u1',
      byteLength,
      maxBytes: 100,
      chunkChars: 100
    })
    expect(pieces.length).toBeGreaterThan(2)
    c.write(pieces[0] + '\n')
    c.send({ type: 'event', name: 'tabs.removed', params: { tabId: 3 } })
    c.write(pieces.slice(1).join('\n') + '\n')

    const response = await c.waitFor((m) => m.type === 'response' && m.id === 'up1')
    expect(response).toEqual({
      type: 'response',
      id: 'up1',
      ok: true,
      result: { echoed: request.params }
    })
    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(onRequest).toHaveBeenCalledWith(conn, 'channel.call', request.params)
    expect(order).toEqual(['event:tabs.removed', 'request:channel.call'])
  })

  it('CBS-14 同一个 installId 再握手：旧连接被关掉、登记换成新的；statuses 仍一条；onClose(旧) 恰一次；新连接照常往返', async () => {
    const onClose = vi.fn()
    const server = await startServer({ onClose })
    const a = client()
    await a.ready()
    const connA = server.connectionFor('i1')!

    const b = client()
    await b.ready({ runId: 'r2' })
    const connB = server.connectionFor('i1')!
    expect(connB).not.toBe(connA)

    await vi.waitFor(() => expect(a.closed).toBe(true), WAIT)
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), WAIT)
    expect(onClose).toHaveBeenCalledWith(connA)
    expect(server.connectionFor('i1')).toBe(connB)
    expect(server.statuses()).toEqual([
      expect.objectContaining({ installId: 'i1', runId: 'r2', state: 'ready' })
    ])

    const pending = connB.request('tabs.get', { tabId: 7 })
    const req = await b.waitFor((m) => m.type === 'request')
    b.send({ type: 'response', id: req.id, ok: true, result: { id: 7 } })
    await expect(pending).resolves.toEqual({ id: 7 })
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('CBS-15 断开：onClose 只给就绪过的那条；模块内的 onConnectionClosed 每条都给（没鉴权 / 等 hello / mismatch / 就绪）', async () => {
    const onClose = vi.fn()
    const server = await startServer({ onClose })
    const closed: BridgeConnection[] = []
    server.onConnectionClosed((conn) => closed.push(conn))

    const unauthed = client()
    await once(unauthed.socket, 'connect')
    await settle(30)
    unauthed.close()
    await vi.waitFor(() => expect(closed).toHaveLength(1), WAIT)
    expect(closed[0].info).toBeUndefined()

    const awaitingHello = client()
    await awaitingHello.auth()
    awaitingHello.close()
    await vi.waitFor(() => expect(closed).toHaveLength(2), WAIT)
    expect(closed[1].info).toBeUndefined()

    const mismatch = client()
    await mismatch.auth()
    await mismatch.hello({ installId: 'i3', protocol: 2 })
    mismatch.close()
    await vi.waitFor(() => expect(closed).toHaveLength(3), WAIT)
    expect(closed[2].info?.installId).toBe('i3')

    const ready = client()
    await ready.ready({ installId: 'i4' })
    const readyConn = server.connectionFor('i4')!
    ready.close()
    await vi.waitFor(() => expect(closed).toHaveLength(4), WAIT)
    expect(closed[3]).toBe(readyConn)

    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(readyConn)
  })

  it('CBS-16 onChange：就绪、mismatch、就绪的连接断开各触发一次；退订后不再收到；抛错的监听者不妨碍别人', async () => {
    const server = await startServer()
    let a = 0
    let b = 0
    const offA = server.onChange(() => a++)
    server.onChange(() => {
      throw new Error('listener bug')
    })
    server.onChange(() => b++)

    const x = client()
    await x.ready({ installId: 'ix' })
    expect([a, b]).toEqual([1, 1])

    const y = client()
    await y.auth()
    await y.hello({ installId: 'iy', protocol: 2 })
    expect([a, b]).toEqual([2, 2])

    x.close()
    await vi.waitFor(() => expect(b).toBe(3), WAIT)
    expect(a).toBe(3)

    offA()
    const z = client()
    await z.ready({ installId: 'iz' })
    expect([a, b]).toEqual([3, 4])
  })

  it('CBS-17 就绪后的扩展事件：模块内的处理器先于上层 onEvent；内部处理器抛错不挡上层；上层抛错不断连接', async () => {
    const order: string[] = []
    const onEvent = vi.fn((_c: BridgeConnection, name: string) => {
      order.push(`upper:${name}`)
      if (name === 'boom') throw new Error('upper failed')
    })
    const onRequest = vi.fn(async () => 'still here')
    const { server, c, conn } = await readyPair({ onEvent, onRequest })
    server.onExtensionEvent(() => {
      order.push('internal-throws')
      throw new Error('internal failed')
    })
    const internal = vi.fn((_c: BridgeConnection, name: string) => order.push(`internal:${name}`))
    server.onExtensionEvent(internal)

    c.send({ type: 'event', name: 'tabs.removed', params: { tabId: 5 } })
    await vi.waitFor(() => expect(order).toHaveLength(3), WAIT)
    expect(order).toEqual(['internal-throws', 'internal:tabs.removed', 'upper:tabs.removed'])
    expect(internal).toHaveBeenCalledWith(conn, 'tabs.removed', { tabId: 5 })
    expect(onEvent).toHaveBeenCalledWith(conn, 'tabs.removed', { tabId: 5 })

    c.send({ type: 'event', name: 'boom' })
    c.send({ type: 'request', id: 'after', method: 'm' })
    expect(await c.waitFor((m) => m.id === 'after')).toEqual({
      type: 'response',
      id: 'after',
      ok: true,
      result: 'still here'
    })
    expect(conn.ready).toBe(true)
  })

  it('CBS-18 按行切：一次 write 两条、一条跨两次 write、空行、两条好行之间夹坏行 —— 好的按序处理，连接一直在', async () => {
    const names: string[] = []
    const onRequest = vi.fn(async () => 'ok')
    const { c, conn } = await readyPair({
      onEvent: (_c, name) => names.push(name),
      onRequest
    })
    const event = (name: string): string => JSON.stringify({ type: 'event', name }) + '\n'

    c.write(event('e1') + event('e2'))
    const third = event('e3')
    c.write(third.slice(0, 10))
    await settle(20)
    c.write(third.slice(10))
    c.write('\n\n')
    c.write('{not json\n' + event('e4'))

    await vi.waitFor(() => expect(names).toEqual(['e1', 'e2', 'e3', 'e4']), WAIT)
    c.send({ type: 'request', id: 'alive', method: 'm' })
    expect(await c.waitFor((m) => m.id === 'alive')).toMatchObject({ ok: true })
    expect(conn.ready).toBe(true)
  })

  it('CBS-20 第一行不是 JSON：直接断开，一个字节也不回', async () => {
    await startServer()
    const c = client()
    c.write('garbage\n')
    await vi.waitFor(() => expect(c.closed).toBe(true), WAIT)
    expect(c.received).toBe('')
  })

  it('CBS-21 statuses 按握手时间新的在前（mismatch 的也在内），与连上的先后无关', async () => {
    const server = await startServer()
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    await client().ready({ installId: 'iA' })
    now.mockReturnValue(3000)
    await client().ready({ installId: 'iB' })
    now.mockReturnValue(2000)
    const c = client()
    await c.auth()
    await c.hello({ installId: 'iC', protocol: 2 })

    expect(server.statuses().map((s) => [s.installId, s.connectedAt, s.state])).toEqual([
      ['iB', 3000, 'ready'],
      ['iC', 2000, 'mismatch'],
      ['iA', 1000, 'ready']
    ])
  })

  it('CBS-22 stop：握手过的连接被关、socket 文件删掉、listening=false、登记清空；随后在同一路径 start 照常可用', async () => {
    const { server, c } = await readyPair()
    server.stop()

    await vi.waitFor(() => expect(c.closed).toBe(true), WAIT)
    expect(existsSync(sockPath)).toBe(false)
    expect(server.listening).toBe(false)
    expect(server.connectionFor('i1')).toBeUndefined()
    expect(server.statuses()).toEqual([])

    await server.start({ socketPath: sockPath, getToken: () => TOKEN })
    expect(server.listening).toBe(true)
    const again = client()
    await again.ready()
    expect(server.connectionFor('i1')?.ready).toBe(true)
  })

  it('CBS-23 checkToken：相等 true；同长不同、长度不同、桌面没有 token 都是 false；token 每次现读', async () => {
    let expected = 'abc123'
    const server = await startServer({}, () => expected)

    expect(server.checkToken('abc123')).toBe(true)
    expect(server.checkToken('abc124')).toBe(false)
    expect(server.checkToken('abc1234')).toBe(false)
    expect(server.checkToken('')).toBe(false)

    expected = ''
    expect(server.checkToken('')).toBe(false)
    expect(server.checkToken('abc123')).toBe(false)

    // 桌面重启重写了 cli-token：新 token 立刻生效，不必重启桥服务
    expected = 'rotated'
    expect(server.checkToken('rotated')).toBe(true)
    expect(server.checkToken('abc123')).toBe(false)

    // 从没 start 过的服务谁也不认
    expect(new ChromeBridgeServer().checkToken('')).toBe(false)
  })

  it('CBS-25 stop 也关掉还没鉴权、还没握手的连接（不止握手过的）', async () => {
    const server = await startServer()
    const unauthed = client()
    await once(unauthed.socket, 'connect')
    await settle(30)
    const awaitingHello = client()
    await awaitingHello.auth()
    const ready = client()
    await ready.ready()

    server.stop()
    await vi.waitFor(
      () =>
        expect([unauthed.closed, awaitingHello.closed, ready.closed]).toEqual([true, true, true]),
      WAIT
    )
  })

  it('CBS-26 同一条连接上的第二个 hello 不理：不回第二个 welcome、statuses 不变、旧 installId 仍指向它、新 installId 不登记（ready 与 mismatch 都一样）', async () => {
    const onReady = vi.fn()
    const onRequest = vi.fn(async () => 'ok')
    const { server, c, conn } = await readyPair({ onReady, onRequest })
    const before = server.statuses()

    c.send(helloOf({ installId: 'i2', runId: 'r2' }))
    c.send({ type: 'request', id: 'after-second-hello', method: 'm' })
    await c.waitFor((m) => m.id === 'after-second-hello')

    expect(c.messages().filter((m) => m.type === 'welcome')).toHaveLength(1)
    expect(server.statuses()).toEqual(before)
    expect(server.connectionFor('i1')).toBe(conn)
    expect(server.connectionFor('i2')).toBeUndefined()
    expect(conn.info?.installId).toBe('i1')
    expect(onReady).toHaveBeenCalledTimes(1)

    const m = client()
    await m.auth()
    await m.hello({ installId: 'i3', protocol: 2 })
    m.send(helloOf({ installId: 'i3', protocol: CHROME_BRIDGE_PROTOCOL }))
    m.send({ type: 'request', id: 'still-mismatch', method: 'm' })
    expect(await m.waitFor((msg) => msg.id === 'still-mismatch')).toEqual({
      type: 'response',
      id: 'still-mismatch',
      ok: false,
      error: 'protocol-mismatch'
    })
    expect(m.messages().filter((msg) => msg.type === 'welcome')).toHaveLength(1)
    expect(server.connectionFor('i3')).toBeUndefined()
    expect(server.statuses().find((s) => s.installId === 'i3')?.state).toBe('mismatch')
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('CBS-27 onConnectionReady：模块内的就绪处理器先于上层 onReady（此时连接已登记可查）；抛错的不挡上层；退订生效；mismatch 不触发', async () => {
    const order: string[] = []
    const server = await startServer({
      onReady: (conn) => order.push(`upper:${conn.info?.installId}`)
    })
    server.onConnectionReady(() => {
      order.push('internal-throws')
      throw new Error('ready handler bug')
    })
    const registered: boolean[] = []
    const off = server.onConnectionReady((conn) => {
      order.push(`internal:${conn.info?.installId}`)
      registered.push(conn.ready && server.connectionFor(conn.info!.installId) === conn)
    })

    await client().ready({ installId: 'i1' })
    expect(order).toEqual(['internal-throws', 'internal:i1', 'upper:i1'])
    expect(registered).toEqual([true])

    off()
    await client().ready({ installId: 'i2' })
    expect(order.slice(3)).toEqual(['internal-throws', 'upper:i2'])

    const m = client()
    await m.auth()
    await m.hello({ installId: 'i3', protocol: 2 })
    await settle()
    expect(order).toHaveLength(5)
  })
})

describe('BridgeConnection —— 假 socket 控制字节边界与时钟', () => {
  /** 一个挂在假 socket 上、已就绪的连接 */
  function fakeReady(handlers: ChromeBridgeHandlers = {}): {
    server: ChromeBridgeServer
    sock: FakeSocket
    conn: BridgeConnection
  } {
    const server = new ChromeBridgeServer()
    vi.spyOn(server, 'checkToken').mockImplementation((token) => token === TOKEN)
    server.setHandlers(handlers)
    const sock = new FakeSocket()
    const conn = new BridgeConnection(sock as unknown as Socket, server)
    sock.emit('data', Buffer.from(AUTH_LINE + '\n'))
    sock.emit('data', Buffer.from(JSON.stringify(helloOf()) + '\n'))
    expect(conn.ready).toBe(true)
    return { server, sock, conn }
  }

  it('CBS-19 多字节字符（中文、emoji）劈在两个 Buffer 之间（每一种劈法）：处理器拿到的参数一字不差；字符串形式的 data 也照收', async () => {
    const onRequest = vi.fn(async () => 'ok')
    const { sock, conn } = fakeReady({ onRequest })
    const text = '中文😀'

    const ids: string[] = []
    const sample = Buffer.from(
      JSON.stringify({ type: 'request', id: 'p0', method: 'm', params: { text } })
    )
    const start = sample.indexOf(Buffer.from('中', 'utf8'))
    const end = start + Buffer.byteLength(text, 'utf8')
    for (let offset = 1; offset < end - start; offset++) {
      const id = `p${offset}`
      const bytes = Buffer.from(
        JSON.stringify({ type: 'request', id, method: 'm', params: { text } }) + '\n',
        'utf8'
      )
      const cut = bytes.indexOf(Buffer.from('中', 'utf8')) + offset
      sock.emit('data', bytes.subarray(0, cut))
      sock.emit('data', bytes.subarray(cut))
      ids.push(id)
    }
    sock.emit(
      'data',
      JSON.stringify({
        type: 'request',
        id: 'as-string',
        method: 'm',
        params: { text: '字符串' }
      }) + '\n'
    )

    await vi.waitFor(() => expect(onRequest).toHaveBeenCalledTimes(ids.length + 1), WAIT)
    expect(ids.length).toBeGreaterThanOrEqual(8)
    for (let i = 0; i < ids.length; i++) {
      expect(onRequest.mock.calls[i]).toEqual([conn, 'm', { text }])
    }
    expect(onRequest.mock.calls[ids.length]).toEqual([conn, 'm', { text: '字符串' }])
    sock.emit('close')
  })

  it('CBS-20 第一行不是 JSON：销毁 socket，同一块里跟在后面的鉴权行也不再处理', () => {
    const server = new ChromeBridgeServer()
    vi.spyOn(server, 'checkToken').mockImplementation((token) => token === TOKEN)
    const sock = new FakeSocket()
    new BridgeConnection(sock as unknown as Socket, server)

    sock.emit('data', Buffer.from('garbage\n' + AUTH_LINE + '\n'))
    expect(sock.destroy).toHaveBeenCalledTimes(1)
    expect(sock.write).not.toHaveBeenCalled()
    sock.emit('close')
  })

  it('CBS-24 10 秒内没鉴权的连接被销毁；按时鉴权的之后再久也不销毁', async () => {
    const server = new ChromeBridgeServer()
    vi.spyOn(server, 'checkToken').mockImplementation((token) => token === TOKEN)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const silent = new FakeSocket()
    new BridgeConnection(silent as unknown as Socket, server)
    const polite = new FakeSocket()
    new BridgeConnection(polite as unknown as Socket, server)

    vi.advanceTimersByTime(5_000)
    polite.emit('data', Buffer.from(AUTH_LINE + '\n'))
    expect(polite.write).toHaveBeenCalledWith(AUTH_OK + '\n')

    vi.advanceTimersByTime(4_999)
    expect(silent.destroy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(silent.destroy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_000)
    expect(polite.destroy).not.toHaveBeenCalled()
    expect(silent.destroy).toHaveBeenCalledTimes(1)
    silent.emit('close')
    polite.emit('close')
  })

  it('CBS-24 鉴权计时器是 10 秒、且 unref（不拦进程退出）', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const sock = new FakeSocket()
    new BridgeConnection(sock as unknown as Socket, new ChromeBridgeServer())

    const index = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 10_000)
    expect(index).toBeGreaterThanOrEqual(0)
    const timer = setTimeoutSpy.mock.results[index].value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
    sock.emit('close')
  })
})
