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
 *   CBS-28     入站的坏分片（没有 data）掀不翻主进程：连接照样答话
 *   CBS-14a/b  顶替的两条岔路：旧连接**还答话**就拒掉新的；不答话才让位
 *   CBS-29~37  顶替不能是静默的：探活恰一次、被拒的收到 already-connected 并收线、争用按 installId
 *              串行（两条新连接不能都「就绪」）、版本不符的让位给在用的那条、被拒的连接不许留着
 *   CBS-38~44  地址是**写**下来的：内容 / 权限 / 父目录 / 重启后改写 / stop 后删掉 /
 *              写不进去也不耽误监听 / 监听失败的那个实例不许删掉在用的那一份
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter, once } from 'events'
import { connect, type Socket } from 'net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
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

/**
 * 假 socket：只有 on / emit / write / end / destroy —— 直接喂 Buffer 给 BridgeConnection。
 *
 * `end` / `destroy` 会跟着发 `close`，真 socket 就是这样 —— 「被拒之后连接要被摘掉」「顶替之后
 * 旧连接要触发 onClose」这些路径全靠那一下才走得完（多发一次 close 由 onClosed 自己挡住）。
 */
class FakeSocket extends EventEmitter {
  write = vi.fn((_data: string) => true)
  end = vi.fn(() => {
    this.emit('close')
  })
  destroy = vi.fn(() => {
    this.emit('close')
  })
}

/** 一个假 socket 上写出去的全部桥消息（send 是一行一条） */
function written(sock: FakeSocket): Message[] {
  return sock.write.mock.calls
    .flatMap(([line]) => String(line).split('\n'))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Message)
}

/** 写给这条连接的探活请求（顶替之前问「你还在吗」） */
const pingsIn = (messages: Message[]): Message[] =>
  messages.filter((m) => m.type === 'request' && m.method === 'bridge.ping')

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
  getToken: () => string = () => TOKEN,
  extra: { addressFile?: string } = {}
): Promise<ChromeBridgeServer> {
  const server = track(new ChromeBridgeServer())
  server.setHandlers(handlers)
  await server.start({ socketPath: sockPath, getToken, ...extra })
  return server
}

function client(path = sockPath): Client {
  const c = new Client(path)
  clients.push(c)
  return c
}

/**
 * 让这个客户端应答 `bridge.ping`。**有意不并进 `readyPair`** —— 顶替的两条岔路就靠「答不答话」
 * 分开，默认都答话的话 CBS-14a/b、CBS-29/30 全都失去意义。
 */
function pong(c: Client, opts: { ok?: boolean } = {}): { pings: Message[] } {
  const pings: Message[] = []
  const answered = new Set<unknown>()
  const scan = (): void => {
    for (const m of c.messages()) {
      if (m.type !== 'request' || m.method !== 'bridge.ping' || answered.has(m.id)) continue
      answered.add(m.id)
      pings.push(m)
      if (opts.ok === false) c.send({ type: 'response', id: m.id, ok: false, error: 'nope' })
      else c.send({ type: 'response', id: m.id, ok: true, result: { ok: true } })
    }
  }
  c.socket.on('data', scan)
  return { pings }
}

/** 活着的连接数（含没鉴权 / 没握手 / 被拒的）—— 没有公开访问器，只能伸手进去看 */
const liveConnections = (server: ChromeBridgeServer): number =>
  (server as unknown as { connections: Set<BridgeConnection> }).connections.size

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

  it('CBS-14b 同一个 installId 再握手、旧的**不答话**：旧连接被关掉、登记换成新的；statuses 仍一条；onClose(旧) 恰一次；新连接照常往返（走满 2 秒探活超时）', async () => {
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
    const req = await b.waitFor((m) => m.type === 'request' && m.method === 'tabs.get')
    b.send({ type: 'response', id: req.id, ok: true, result: { id: 7 } })
    await expect(pending).resolves.toEqual({ id: 7 })
    await settle()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('CBS-14a 同一个 installId 再握手、旧的**还答话**：新的被拒（already-connected）、旧的原封不动', async () => {
    const onClose = vi.fn()
    const server = await startServer({ onClose })
    const a = client()
    await a.ready()
    pong(a)
    const connA = server.connectionFor('i1')!

    const b = client()
    await b.auth()
    expect(await b.hello({ runId: 'r2' })).toEqual({
      type: 'welcome',
      protocol: 1,
      ok: false,
      error: 'already-connected'
    })

    expect(server.connectionFor('i1')).toBe(connA)
    expect(connA.ready).toBe(true)
    expect(a.closed).toBe(false)
    await settle()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('CBS-29 顶替不能是静默的：旧的答了探活 → 新的收到 already-connected 并被收线；登记、statuses、三个回调都当没发生过；旧连接照常往返', async () => {
    const onReady = vi.fn()
    const server = await startServer({ onReady })
    const a = client()
    await a.ready()
    const { pings } = pong(a)
    const connA = server.connectionFor('i1')!
    const statusesBefore = server.statuses()

    const internalReady = vi.fn()
    server.onConnectionReady(internalReady)
    // onChange 会随「被拒的那条 socket 关掉」触发一次（每条连接摘掉都触发）；要紧的是它每次
    // 报出来的东西都没变 —— 设置页刷新一遍看到的还是同一个浏览器
    const seen: unknown[] = []
    server.onChange(() => seen.push(server.statuses()))

    const b = client()
    await b.auth()
    const welcome = await b.hello({ runId: 'r2', browser: 'Chrome 141' })

    expect(welcome).toEqual({
      type: 'welcome',
      protocol: 1,
      ok: false,
      error: 'already-connected'
    })
    // 被拒的那条自己收线 —— 对面据此显示「这个浏览器已经连着了」，而不是当成桌面没开一直重试
    await vi.waitFor(() => expect(b.closed).toBe(true), WAIT)

    // 探活恰一次、而且只是协议层的 ping（不碰浏览器）
    expect(pings).toHaveLength(1)
    expect(pings[0]).toEqual({
      type: 'request',
      id: expect.stringMatching(/^d\d+$/),
      method: 'bridge.ping',
      params: {}
    })
    expect(a.messages().filter((m) => m.type === 'request' && m.method !== 'bridge.ping')).toEqual(
      []
    )

    expect(server.connectionFor('i1')).toBe(connA)
    expect(server.readyConnections()).toEqual([connA])
    expect(server.statuses()).toEqual(statusesBefore)
    expect(server.statuses()).toHaveLength(1)
    expect(server.statuses()[0].runId).toBe('r1')
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(internalReady).not.toHaveBeenCalled()
    for (const snapshot of seen) expect(snapshot).toEqual(statusesBefore)

    // 旧连接一点没受影响
    const pending = connA.request('tabs.get', { tabId: 3 })
    const req = await a.waitFor((m) => m.type === 'request' && m.method === 'tabs.get')
    a.send({ type: 'response', id: req.id, ok: true, result: { id: 3 } })
    await expect(pending).resolves.toEqual({ id: 3 })
  })

  it('CBS-31 一个 installId 的**第一条**连接：不探活（一个 ping 也不写），而且 hello 处理完当场就绪 —— 紧跟 hello 的第一条请求不能撞上「还没就绪」', async () => {
    const server = await startServer()
    const a = client()
    await a.auth()

    // hello 与随后的请求写在同一块里：claim 若插一个微任务进去，这条请求就会收到 not-ready
    a.write(
      JSON.stringify(helloOf()) +
        '\n' +
        JSON.stringify({ type: 'request', id: 'right-after-hello', method: 'm' }) +
        '\n'
    )
    expect(await a.waitFor((m) => m.id === 'right-after-hello')).toEqual({
      type: 'response',
      id: 'right-after-hello',
      ok: false,
      error: 'Unknown method "m".'
    })
    expect(server.connectionFor('i1')?.ready).toBe(true)

    // 另一个 installId 也一样：探活只属于「有人占着」那条路
    const b = client()
    await b.ready({ installId: 'i2' })
    await settle()
    expect(pingsIn(a.messages())).toEqual([])
    expect(pingsIn(b.messages())).toEqual([])
  })

  it('CBS-32 版本不符的新连接撞上在用的那条：旧的不探活、不关、照样登记着；新的说完 welcome 就收线，statuses 仍只有旧的那一行', async () => {
    const onClose = vi.fn()
    const server = await startServer({ onClose })
    const a = client()
    await a.ready()
    const { pings } = pong(a)
    const connA = server.connectionFor('i1')!
    const before = server.statuses()

    const b = client()
    await b.auth()
    expect(await b.hello({ protocol: 2, runId: 'r2' })).toEqual({
      type: 'welcome',
      protocol: 1,
      ok: false,
      error: 'protocol-mismatch'
    })

    // 登记表一个 installId 只有一格：顶掉真在用的那条去显示一条版本不符的，是本末倒置
    await vi.waitFor(() => expect(b.closed).toBe(true), WAIT)
    expect(pings).toEqual([])
    expect(a.closed).toBe(false)
    expect(server.connectionFor('i1')).toBe(connA)
    expect(server.statuses()).toEqual(before)
    expect(server.statuses().map((s) => [s.runId, s.state])).toEqual([['r1', 'ready']])
    await settle()
    expect(onClose).not.toHaveBeenCalled()

    // 换个没人占的 installId：版本不符的照样登记（设置页要显示「请更新扩展」）
    const c = client()
    await c.auth()
    await c.hello({ installId: 'i9', protocol: 2 })
    expect(server.statuses().map((s) => [s.installId, s.state])).toContainEqual(['i9', 'mismatch'])
  })

  it('CBS-33 那条版本不符的连接断开之后：在用的那条仍登记着、仍答话（release 认连接本人，不认 installId）', async () => {
    const server = await startServer()
    const a = client()
    await a.ready()
    pong(a)
    const connA = server.connectionFor('i1')!

    const b = client()
    await b.auth()
    await b.hello({ protocol: 2, runId: 'r2' })
    b.close()
    await settle()

    expect(server.connectionFor('i1')).toBe(connA)
    expect(server.readyConnections()).toEqual([connA])
    const pending = connA.request('tabs.get', { tabId: 4 })
    const req = await a.waitFor((m) => m.type === 'request' && m.method === 'tabs.get')
    a.send({ type: 'response', id: req.id, ok: true, result: { id: 4 } })
    await expect(pending).resolves.toEqual({ id: 4 })
  })

  it('CBS-36 旧连接答的是 ok:false：**按不答话算**、照样让位 —— 有意如此（真扩展只会答 ok:true，答错的只可能是别的本地进程）', async () => {
    const server = await startServer()
    const a = client()
    await a.ready()
    const { pings } = pong(a, { ok: false })
    const connA = server.connectionFor('i1')!

    const b = client()
    await b.ready({ runId: 'r2' })

    expect(pings).toHaveLength(1)
    expect(server.connectionFor('i1')).not.toBe(connA)
    expect(server.connectionFor('i1')?.info?.runId).toBe('r2')
    await vi.waitFor(() => expect(a.closed).toBe(true), WAIT)
  })

  it('CBS-37 被拒的连接不许留着：连拒 5 次之后，活着的连接只剩在用的那一条（socket 也跟着收掉）', async () => {
    const server = await startServer()
    const a = client()
    await a.ready()
    pong(a)
    await vi.waitFor(() => expect(liveConnections(server)).toBe(1), WAIT)

    for (let i = 0; i < 5; i++) {
      const b = client()
      await b.auth()
      expect(await b.hello({ runId: `r${i}` })).toMatchObject({
        ok: false,
        error: 'already-connected'
      })
      await vi.waitFor(() => expect(b.closed).toBe(true), WAIT)
    }

    // 被拒时先把 state 置成 closed 的话，socket 的 close 事件就早退了 —— 连接与它的 socket 会一直留到进程结束
    await vi.waitFor(() => expect(liveConnections(server)).toBe(1), WAIT)
    expect(server.connectionFor('i1')?.ready).toBe(true)
  })

  it('CBS-28 入站的分片没有 data：不抛（socket 回调里抛出去就是主进程的一次未捕获异常），连接照常答话', async () => {
    const onRequest = vi.fn(async () => 'alive')
    const { c, conn } = await readyPair({ onRequest })

    c.send({ type: 'chunk', id: 'x', seq: 0, total: 2 })
    c.send({ type: 'chunk', id: 'y', seq: 0, total: 2, data: null })
    c.send({ type: 'chunk', id: 'z', seq: 0, total: 2, data: 123 })
    c.send({ type: 'request', id: 'after-garbage', method: 'm' })

    expect(await c.waitFor((m) => m.id === 'after-garbage')).toEqual({
      type: 'response',
      id: 'after-garbage',
      ok: true,
      result: 'alive'
    })
    expect(conn.ready).toBe(true)
    expect(c.closed).toBe(false)
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

  it('CBS-38 地址文件：内容恰是监听地址（不带换行）、0600、父目录补建；照着它连得上', async () => {
    const addressFile = join(dir, 'a', 'b', 'chrome-bridge.addr')
    const server = await startServer({}, () => TOKEN, { addressFile })

    expect(readFileSync(addressFile, 'utf-8')).toBe(sockPath)
    expect(statSync(addressFile).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'a', 'b')).isDirectory()).toBe(true)

    // 「地址是读出来的」全靠这一点：本地组件拿文件里的字符串直接去连
    await client(readFileSync(addressFile, 'utf-8')).auth()
    expect(server.listening).toBe(true)
  })

  it('CBS-39 地址文件里躺着上一轮的地址：启动时原地改写成这一轮的', async () => {
    const addressFile = join(dir, 'chrome-bridge.addr')
    writeFileSync(addressFile, join(dir, 'gone.sock'))

    await startServer({}, () => TOKEN, { addressFile })
    expect(readFileSync(addressFile, 'utf-8')).toBe(sockPath)
  })

  it('CBS-40 stop：地址文件与 socket 文件都删掉；再 stop 一次不抛；文件被人先删了也不抛', async () => {
    const addressFile = join(dir, 'chrome-bridge.addr')
    const server = await startServer({}, () => TOKEN, { addressFile })
    expect(existsSync(addressFile)).toBe(true)

    server.stop()
    expect(existsSync(addressFile)).toBe(false)
    expect(existsSync(sockPath)).toBe(false)
    expect(() => server.stop()).not.toThrow()

    // 外面有人把文件删了（清理脚本、用户）——桌面退出时不该因此炸掉
    const again = await startServer({}, () => TOKEN, { addressFile })
    rmSync(addressFile)
    rmSync(sockPath)
    expect(() => again.stop()).not.toThrow()
  })

  it('CBS-41 桌面重启（换了监听地址）：地址文件跟着改成新地址 —— 这就是它存在的理由', async () => {
    const addressFile = join(dir, 'chrome-bridge.addr')
    const pathB = join(dir, 's2.sock')

    const server = await startServer({}, () => TOKEN, { addressFile })
    expect(readFileSync(addressFile, 'utf-8')).toBe(sockPath)
    server.stop()

    const second = track(new ChromeBridgeServer())
    await second.start({ socketPath: pathB, getToken: () => TOKEN, addressFile })
    expect(readFileSync(addressFile, 'utf-8')).toBe(pathB)
    await client(pathB).auth()
  })

  it('CBS-42 地址文件写不进去（那个位置是个目录）：桥照样起得来、连得上 —— 写不下地址最多是回落到确定地址，不该拖垮监听', async () => {
    const addressFile = join(dir, 'blocked')
    mkdirSync(addressFile)

    const server = await startServer({}, () => TOKEN, { addressFile })
    expect(server.listening).toBe(true)
    await client().auth()
    expect(statSync(addressFile).isDirectory()).toBe(true)
  })

  it('CBS-43 没给 addressFile：一个字不写；之后 stop() 也不去删任何东西', async () => {
    const bystander = join(dir, 'chrome-bridge.addr')
    writeFileSync(bystander, '/somebody/elses.sock')

    const server = await startServer()
    expect(readFileSync(bystander, 'utf-8')).toBe('/somebody/elses.sock')

    server.stop()
    expect(existsSync(bystander)).toBe(true)
    expect(readFileSync(bystander, 'utf-8')).toBe('/somebody/elses.sock')
  })

  it('CBS-44 监听失败的那个实例，stop() 时不许删掉**在用的**那一份地址文件（两个实例抢同一个地址时，本地组件就会再也找不到桌面）', async () => {
    const addressFile = join(dir, 'chrome-bridge.addr')
    const live = await startServer({}, () => TOKEN, { addressFile })
    expect(readFileSync(addressFile, 'utf-8')).toBe(sockPath)

    // 监听一个已经是目录的地址：bind 失败
    const taken = join(dir, 'taken')
    mkdirSync(taken)
    const loser = track(new ChromeBridgeServer())
    await expect(
      loser.start({ socketPath: taken, getToken: () => TOKEN, addressFile })
    ).rejects.toThrow()
    expect(loser.listening).toBe(false)

    loser.stop()
    expect(existsSync(addressFile)).toBe(true)
    expect(readFileSync(addressFile, 'utf-8')).toBe(sockPath)
    expect(live.listening).toBe(true)
    await client().auth()
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
  /** 一台挂假 socket 的桥服务 */
  function fakeServer(handlers: ChromeBridgeHandlers = {}): ChromeBridgeServer {
    const server = new ChromeBridgeServer()
    vi.spyOn(server, 'checkToken').mockImplementation((token) => token === TOKEN)
    server.setHandlers(handlers)
    return server
  }

  /** 接一条假连接、走完鉴权与 hello（就不就绪由 claim 决定，这里不断言） */
  function fakeConnect(
    server: ChromeBridgeServer,
    over: Message = {}
  ): { sock: FakeSocket; conn: BridgeConnection } {
    const sock = new FakeSocket()
    const conn = new BridgeConnection(sock as unknown as Socket, server)
    sock.emit('data', Buffer.from(AUTH_LINE + '\n'))
    sock.emit('data', Buffer.from(JSON.stringify(helloOf(over)) + '\n'))
    return { sock, conn }
  }

  /** 替这条连接回一句「我在」 */
  function answerPing(sock: FakeSocket): Message {
    const pings = pingsIn(written(sock))
    expect(pings).toHaveLength(1)
    sock.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'response', id: pings[0].id, ok: true, result: { ok: true } }) + '\n'
      )
    )
    return pings[0]
  }

  /** 一个挂在假 socket 上、已就绪的连接（没人占着这个 installId：就绪是同步发生的） */
  function fakeReady(handlers: ChromeBridgeHandlers = {}): {
    server: ChromeBridgeServer
    sock: FakeSocket
    conn: BridgeConnection
  } {
    const server = fakeServer(handlers)
    const { sock, conn } = fakeConnect(server)
    expect(conn.ready).toBe(true)
    return { server, sock, conn }
  }

  it('CBS-30 旧连接不答话：满 2 秒之前一切照旧；到点才关掉旧的、让新的就绪', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onClose = vi.fn()
    const onReady = vi.fn()
    const server = fakeServer({ onClose, onReady })
    const a = fakeConnect(server)
    expect(a.conn.ready).toBe(true)
    onReady.mockClear()

    const b = fakeConnect(server, { runId: 'r2' })
    await vi.advanceTimersByTimeAsync(0)
    expect(pingsIn(written(a.sock))).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1999)
    expect(a.sock.destroy).not.toHaveBeenCalled()
    expect(b.conn.ready).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    expect(server.connectionFor('i1')).toBe(a.conn)

    await vi.advanceTimersByTimeAsync(1)
    expect(a.sock.destroy).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(a.conn)
    expect(b.conn.ready).toBe(true)
    expect(written(b.sock)).toContainEqual({ type: 'welcome', protocol: 1, ok: true })
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(server.connectionFor('i1')).toBe(b.conn)
  })

  it('CBS-34 旧的不答话、两条新连接同时来：claim 按 installId 串起来 —— 最后只有一条就绪，另一条被拒（不串行的话两条都会以为自己接手了，其中一条「就绪」却没登记、什么也收不到）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onReady = vi.fn()
    const server = fakeServer({ onReady })
    const a = fakeConnect(server)
    expect(onReady).toHaveBeenCalledTimes(1)
    onReady.mockClear()

    const b = fakeConnect(server, { runId: 'rB' })
    const c = fakeConnect(server, { runId: 'rC' })
    await vi.advanceTimersByTimeAsync(2000)

    // A 不答话 → B 接手；接着轮到 C，它探的是**此刻**登记着的 B
    expect(a.sock.destroy).toHaveBeenCalled()
    expect(b.conn.ready).toBe(true)
    answerPing(b.sock)
    await vi.advanceTimersByTimeAsync(0)

    expect(c.conn.ready).toBe(false)
    expect(written(c.sock)).toContainEqual({
      type: 'welcome',
      protocol: 1,
      ok: false,
      error: 'already-connected'
    })
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady.mock.calls[0][0]).toBe(b.conn)
    expect([a.conn, b.conn, c.conn].filter((conn) => conn.ready)).toEqual([b.conn])
    expect(server.connectionFor('i1')).toBe(b.conn)
  })

  it('CBS-35 探活还没到点、新连接自己先断了：不抛、不登记、markReady 一次都没调；旧的已经先关掉了，于是这个 installId 最后一条就绪连接也没有', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const onReady = vi.fn()
    const server = fakeServer({ onReady })
    const a = fakeConnect(server)
    onReady.mockClear()

    const b = fakeConnect(server, { runId: 'r2' })
    const markReady = vi.spyOn(b.conn, 'markReady')
    await vi.advanceTimersByTimeAsync(0)
    expect(pingsIn(written(a.sock))).toHaveLength(1)

    b.sock.emit('close')
    await vi.advanceTimersByTimeAsync(2000)

    expect(a.sock.destroy).toHaveBeenCalled()
    expect(markReady).not.toHaveBeenCalled()
    expect(b.conn.ready).toBe(false)
    expect(written(b.sock).some((m) => m.type === 'welcome' && m.ok === true)).toBe(false)
    expect(server.connectionFor('i1')).toBeUndefined()
    expect(server.readyConnections()).toEqual([])
    expect(onReady).not.toHaveBeenCalled()
  })

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
