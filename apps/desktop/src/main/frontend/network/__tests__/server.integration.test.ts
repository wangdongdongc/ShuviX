/**
 * `frontend/network/server.ts` —— 真的 `createNetworkServer`（server mode phase B §B2），绑 127.0.0.1 的随机端口：静态路由、
 * 三道门、`/ws` 升级、请求分发、推送、视图同步、断开、停止、心跳、慢客户端。HTTP 用 `node:http`（`agent:false`，不归一路径与
 * Host），WebSocket 用 `ws` 的客户端。传输 / 分发器 / 链路表是真的；定义经 `transport.serve` 交进去，`accept` 是 spy。
 * 渲染端产物目录是临时目录（`rendererDir` 现取，用例可以换）；`connectionSeq` 是进程级的，所以只断言 `/^ws:\d+$/`。
 *
 *   NS-1  start(0,'127.0.0.1') 回 > 0 的端口，等于 server.port
 *   NSL-14 server.host：start 之前 undefined；start(port,'127.0.0.1') 之后 '127.0.0.1'；stop() 之后 undefined
 *   NS-2  GET / 与 /web.html → 200，web.html 的内容；content-type / cache-control / nosniff / content-length
 *   NS-3  资源：js / css / woff2 的 MIME；HEAD → 200、content-length、空 body
 *   NS-4  404 'Not found.'：/index.html、/assets/、/assets（目录）、/missing.js
 *   NS-5  原样路径出不了目录（404）；NUL / 编码的反斜杠 → 400 'Bad request.'；从不给出目录外文件的内容
 *   NS-6  隐藏文件 → 404
 *   NS-7  POST / → 405 + allow: GET, HEAD；POST 带坏 Host → 421（门先于路由）
 *   NS-8  web.html 不在 → 503（一句话）；缺资源仍是 404；换回来 → 200（目录每次现取）
 *   NS-9  HTTP 的 Host 门：坏 Host / 缺端口 / 别的端口 / 缺 Host → 拒（connection: close）；localhost / 大小写 / [::1] /
 *         局域网 IP 带端口 → 200
 *   NS-10 /ws 升级成功：open、onConnection 一次、client 形状（UA 截到 512、没有 → ''）；回调里传输已经有它；/ws?x=1 也行
 *   NS-11 升级被拒（读出完整状态与 body）：403（没 Origin / 跨站 / https / 换了主机名）、404（/other、/ws/）、421（坏 Host）；
 *         onConnection 不调、connections() 为空
 *   NS-12 maxClients:1：第二个 → 503；第一个走了之后新的照连
 *   NS-13 invoke 往返：结果解得出来；处理函数收到 (ctx, undefined, {profile:'chat'})，ctx 的 client 就是这条连接
 *   NS-14 结果：undefined → 线上没有 value 键；表外 → unknown_channel；桌面专属 → desktop_only（spy 不调）；抛 → ok:false
 *   NS-15 处理函数回 BigInt / 循环对象 → 一条 handler_error 失败结果；socket 还开着，下一个 invoke 照答
 *   NS-16 send → listen 定义收到 (ctx, params)
 *   NS-17 'not json'、没有 id 的 invoke、二进制帧 → 不回、不调处理函数；连接还开着，下一个合法 invoke 照答
 *   NS-17b 认得出 id 的坏 invoke → {ok:false, error:{message:'Malformed request.', code:'bad_request'}}
 *   NS-18 推送：pushTo 的 undefined 经 u 保住；broadcast 到两个客户端；编不出来的推送丢掉、连接还开着、下一条照到
 *   NS-19 视图同步：hello → accept（主体由服务端盖章）；acceptedLink.send → 客户端收到 {t:'sync', link, frame}
 *   NS-20 客户端关掉：onDisconnection 一次（同一个连接对象），回调里传输与链路表都已摘掉；链路以
 *         'network client disconnected' 结束；onClientGone 触发一次；之后的 pushTo 无操作
 *   NS-21 stop()：每个客户端 1001 'network access turned off'（stop('bye') → 'bye'）；port undefined；onDisconnection 每个
 *         一次；端口放开（ECONNREFUSED、能再绑）；再 stop 无事；同一端口能再 start
 *   NS-22 第二次 start → 拒绝 'network server is already running'
 *   NS-23 端口被占 → EADDRINUSE，port undefined；之后 start(0) 照样成功
 *   NS-24 heartbeatMs:30：正常客户端 200ms 后还开着；不回 pong 的客户端以 1006 断开，onDisconnection 调到
 *   NS-25 maxBufferedBytes:-1：第一条服务端消息改成以 1008 'client too slow' 断开，没有结果帧
 *   NS-26 两条连接的 id 不同，后一条的序号更大
 *   NS-27 一个乱发的原始 socket 被断开；之后 GET / 照样 200
 *   NS-28 GET /INDEX.HTML → 404（大小写不敏感的文件系统上也不给桌面入口）
 *   NS-29 全栈：渲染端 createWsConnection + createWebApi 经真的 ws 调到处理函数；stop → reconnecting；同端口再 start → open
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { createServer as createNetServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Link } from '@earendil-works/chord'
import type { ViewPrincipal } from '@shuvix/agent-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage
} from '../../../../shared/networkEnvelope'
import type { ClientContext } from '../../../ipc/registry'
import { createNetworkDispatcher } from '../dispatch'
import { createNetworkLinkHub, type NetworkLinkHub } from '../networkLinks'
import { createNetworkServer, type NetworkServer, type NetworkServerDeps } from '../server'
import { createNetworkTransport, type NetworkConnection, type NetworkTransport } from '../transport'
// eslint-disable-next-line boundaries/dependencies -- 全栈用例：浏览器那一半（渲染端的 web 客户端）接到真的服务端上
import { createWsConnection, type WebSocketLike } from '../../../../renderer/src/web/wsConnection'
// eslint-disable-next-line boundaries/dependencies -- 同上
import { createWebApi } from '../../../../renderer/src/web/webApi'

const WEB_HTML = '<!doctype html><title>web</title><p>ShuviX web client ✓</p>'
const INDEX_HTML = '<!doctype html><title>desktop</title>'
const APP_JS = 'console.log("app")\n'
const STYLE_CSS = 'body{color:red}'
const FONT = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3])
const SECRET = 'TOP-SECRET-CONTENT'
const HELLO = { t: 'hello', name: 'renderer', kind: 'client', epoch: 1 }

let tmp: string
let rendererDir: string
let emptyDir: string
let currentDir: string

let transport: NetworkTransport
let links: NetworkLinkHub
let accepted: Array<{ link: Link; principal: ViewPrincipal; reasons: string[] }>
let accept: ReturnType<typeof vi.fn<(link: Link, principal: ViewPrincipal) => void>>
let onConnection: ReturnType<typeof vi.fn<(connection: NetworkConnection) => void>>
let onDisconnection: ReturnType<typeof vi.fn<(connection: NetworkConnection) => void>>
let server: NetworkServer | undefined
let port: number
let clients: WebSocket[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-net-'))
  rendererDir = join(tmp, 'renderer')
  emptyDir = join(tmp, 'empty')
  mkdirSync(join(rendererDir, 'assets'), { recursive: true })
  mkdirSync(join(rendererDir, 'sub'), { recursive: true })
  mkdirSync(emptyDir)
  writeFileSync(join(rendererDir, 'web.html'), WEB_HTML)
  writeFileSync(join(rendererDir, 'index.html'), INDEX_HTML)
  writeFileSync(join(rendererDir, 'assets', 'app.js'), APP_JS)
  writeFileSync(join(rendererDir, 'assets', 'style.css'), STYLE_CSS)
  writeFileSync(join(rendererDir, 'assets', 'font.woff2'), FONT)
  writeFileSync(join(rendererDir, '.hidden'), SECRET)
  writeFileSync(join(rendererDir, 'assets', '.secret'), SECRET)
  writeFileSync(join(tmp, 'secret.txt'), SECRET)
  currentDir = rendererDir

  transport = createNetworkTransport()
  accepted = []
  accept = vi.fn((link: Link, principal: ViewPrincipal) => {
    const entry = { link, principal, reasons: [] as string[] }
    accepted.push(entry)
    link.receive(() => {})
    link.onClose((reason) => entry.reasons.push(reason))
  })
  links = createNetworkLinkHub({ accept })
  onConnection = vi.fn()
  onDisconnection = vi.fn()
  clients = []
  server = undefined
})

afterEach(async () => {
  for (const ws of clients) ws.terminate()
  await server?.stop()
  rmSync(tmp, { recursive: true, force: true })
})

async function boot(overrides: Partial<NetworkServerDeps> = {}): Promise<number> {
  const dispatcher = createNetworkDispatcher({ definitionOf: transport.definitionOf })
  server = createNetworkServer({
    transport,
    dispatcher,
    links,
    rendererDir: () => currentDir,
    onConnection,
    onDisconnection,
    heartbeatMs: 60_000,
    ...overrides
  })
  port = await server.start(0, '127.0.0.1')
  return port
}

const handle = (channel: string, fn: (...args: any[]) => unknown): void =>
  transport.serve({ kind: 'handle', channel, fn })
const listen = (channel: string, fn: (...args: any[]) => void): void =>
  transport.serve({ kind: 'listen', channel, fn })

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port: free } = probe.address() as { port: number }
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return free
}

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function http(
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    setHost?: boolean
    port?: number
  } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port ?? port,
        method: options.method ?? 'GET',
        path,
        headers: options.headers,
        setHost: options.setHost ?? true,
        agent: false
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end()
  })
}

interface TestClient {
  ws: WebSocket
  messages: string[]
  closed: Promise<{ code: number; reason: string }>
}

interface WsOptions {
  path?: string
  origin?: string | null
  headers?: Record<string, string>
  autoPong?: boolean
}

function wsUrl(path = '/ws'): string {
  return `ws://127.0.0.1:${port}${path}`
}

function wsClient(options: WsOptions = {}): WebSocket {
  const origin =
    options.origin === null ? undefined : (options.origin ?? `http://127.0.0.1:${port}`)
  const ws = new WebSocket(wsUrl(options.path), {
    ...(origin === undefined ? {} : { origin }),
    headers: options.headers,
    autoPong: options.autoPong ?? true
  })
  clients.push(ws)
  return ws
}

async function connect(options: WsOptions = {}): Promise<TestClient> {
  const ws = wsClient(options)
  const messages: string[] = []
  ws.on('message', (data, isBinary) => {
    if (!isBinary) messages.push(data.toString())
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  )
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`upgrade refused: ${res.statusCode}`))
    )
  })
  return { ws, messages, closed }
}

/** 一次被拒的升级：读出完整的状态与 body */
function refused(options: WsOptions = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = wsClient(options)
    let settled = false
    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => {
        settled = true
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    ws.on('open', () => {
      settled = true
      reject(new Error('the upgrade was accepted'))
    })
    ws.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

const sendMessage = (client: TestClient, message: ClientMessage): void =>
  client.ws.send(encodeClientMessage(message))

async function nextMessages(client: TestClient, count: number): Promise<ServerMessage[]> {
  await vi.waitFor(() => expect(client.messages.length).toBeGreaterThanOrEqual(count), {
    timeout: 3000
  })
  return client.messages.map((text) => decodeServerMessage(text)!)
}

async function invokeOnce(
  client: TestClient,
  id: number,
  channel: string,
  args: unknown[] = []
): Promise<ServerMessage> {
  const before = client.messages.length
  sendMessage(client, { t: 'invoke', id, channel, args })
  const all = await nextMessages(client, before + 1)
  return all[before]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('NS-1 start', () => {
  it('NS-1 回 > 0 的端口，等于 server.port', async () => {
    const bound = await boot()
    expect(bound).toBeGreaterThan(0)
    expect(server!.port).toBe(bound)
  })
})

describe('NSL-14 host', () => {
  it("NSL-14 start 之前 undefined；start(port,'127.0.0.1') 之后 '127.0.0.1'；stop() 之后 undefined", async () => {
    const dispatcher = createNetworkDispatcher({ definitionOf: transport.definitionOf })
    server = createNetworkServer({ transport, dispatcher, links, rendererDir: () => currentDir })
    expect(server.host).toBeUndefined()
    const free = await freePort()
    port = await server.start(free, '127.0.0.1')
    expect(port).toBe(free)
    expect(server.host).toBe('127.0.0.1')
    await server.stop()
    expect(server.host).toBeUndefined()
    expect(server.port).toBeUndefined()
  })
})

describe('NS-2..NS-8 静态路由', () => {
  beforeEach(async () => {
    await boot()
  })

  it('NS-2 GET / 与 /web.html → 200，web.html 的内容与头', async () => {
    for (const path of ['/', '/web.html']) {
      const res = await http(path)
      expect(res.status).toBe(200)
      expect(res.body).toBe(WEB_HTML)
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(res.headers['cache-control']).toBe('no-cache')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(WEB_HTML)))
    }
  })

  it('NS-3 资源的 MIME；HEAD → 200、content-length、空 body', async () => {
    const js = await http('/assets/app.js')
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(js.body).toBe(APP_JS)
    const css = await http('/assets/style.css')
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8')
    const font = await http('/assets/font.woff2')
    expect(font.status).toBe(200)
    expect(font.headers['content-type']).toBe('font/woff2')
    const head = await http('/assets/app.js', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(APP_JS)))
    expect(head.body).toBe('')
  })

  it("NS-4 404 'Not found.'", async () => {
    for (const path of ['/index.html', '/assets/', '/assets', '/missing.js']) {
      const res = await http(path)
      expect(res.status, path).toBe(404)
      expect(res.body, path).toBe('Not found.')
    }
  })

  it('NS-5 原样路径出不了目录；NUL / 反斜杠 → 400；从不给出目录外文件', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await http(path)
      expect(res.status, path).toBe(404)
      expect(res.body).not.toContain(SECRET)
    }
    for (const path of ['/a%00b', '/%5c..%5csecret.txt']) {
      const res = await http(path)
      expect(res.status, path).toBe(400)
      expect(res.body).toBe('Bad request.')
    }
  })

  it('NS-6 隐藏文件 → 404', async () => {
    for (const path of ['/.hidden', '/assets/.secret']) {
      const res = await http(path)
      expect(res.status, path).toBe(404)
      expect(res.body).not.toContain(SECRET)
    }
  })

  it('NS-7 POST / → 405 + allow；POST 带坏 Host → 421', async () => {
    const res = await http('/', { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.body).toBe('Method not allowed.')
    expect(res.headers.allow).toBe('GET, HEAD')
    const bad = await http('/', { method: 'POST', headers: { Host: `evil:${port}` } })
    expect(bad.status).toBe(421)
  })

  it('NS-8 web.html 不在 → 503；缺资源仍 404；换回来 → 200', async () => {
    currentDir = emptyDir
    const missing = await http('/')
    expect(missing.status).toBe(503)
    expect(missing.body).toBe('The ShuviX web client is not built (web.html is missing).')
    expect((await http('/assets/app.js')).status).toBe(404)
    currentDir = rendererDir
    const back = await http('/')
    expect(back.status).toBe(200)
    expect(back.body).toBe(WEB_HTML)
  })
})

describe('NS-9 HTTP 的 Host 门', () => {
  beforeEach(async () => {
    await boot()
  })

  it('NS-9 坏 Host / 缺端口 / 别的端口 → 421 + connection: close', async () => {
    for (const host of [`evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`]) {
      const res = await http('/', { headers: { Host: host } })
      expect(res.status, host).toBe(421)
      expect(res.headers.connection, host).toBe('close')
      expect(res.body).toBe('Use an IP address or localhost with the ShuviX port.')
    }
  })

  it('NS-9 缺 Host → 拒，从不 200', async () => {
    // Node 的 http 服务在 HTTP/1.1 缺 Host 时自己先回 400（requireHostHeader 缺省开）；走到我们的门则是 421
    const res = await http('/', { setHost: false })
    expect([400, 421]).toContain(res.status)
    expect(res.body).not.toContain(WEB_HTML)
  })

  it('NS-9 localhost / 大小写 / [::1] / 局域网 IP 带端口 → 200', async () => {
    for (const host of [
      `localhost:${port}`,
      `LOCALHOST:${port}`,
      `[::1]:${port}`,
      `192.168.1.5:${port}`
    ]) {
      const res = await http('/', { headers: { Host: host } })
      expect(res.status, host).toBe(200)
    }
  })
})

describe('NS-10 / NS-11 升级', () => {
  beforeEach(async () => {
    await boot()
  })

  it('NS-10 升级成功：onConnection 一次，client 形状，回调里传输已经有它', async () => {
    let seenInCallback: { same: boolean; count: number } | undefined
    onConnection.mockImplementation((connection) => {
      seenInCallback = {
        same: transport.connection(connection.client.id) === connection,
        count: transport.connections().length
      }
    })
    await connect({ headers: { 'user-agent': 'ua/1' } })
    expect(onConnection).toHaveBeenCalledTimes(1)
    const connection = onConnection.mock.calls[0][0]
    expect(connection.client).toStrictEqual({
      kind: 'network',
      id: expect.stringMatching(/^ws:\d+$/),
      remoteAddress: '127.0.0.1',
      userAgent: 'ua/1'
    })
    expect(seenInCallback).toStrictEqual({ same: true, count: 1 })
  })

  it('NS-10 /ws?x=1 也行；没有 UA → ""；600 字符的 UA 截到 512', async () => {
    await connect({ path: '/ws?x=1' })
    expect(onConnection.mock.calls[0][0].client.userAgent).toBe('')
    await connect({ headers: { 'user-agent': 'u'.repeat(600) } })
    expect(onConnection.mock.calls[1][0].client.userAgent).toHaveLength(512)
  })

  it('NS-11 403：没 Origin / 跨站 / https / 换了主机名', async () => {
    for (const origin of [
      null,
      'http://evil.example',
      `https://127.0.0.1:${port}`,
      `http://localhost:${port}`
    ]) {
      const res = await refused({ origin })
      expect(res.status, String(origin)).toBe(403)
      expect(res.body).toBe('Cross-origin WebSocket connections are refused.')
    }
    expect(onConnection).not.toHaveBeenCalled()
    expect(transport.connections()).toHaveLength(0)
  })

  it('NS-11 404：/other、/ws/', async () => {
    for (const path of ['/other', '/ws/']) {
      const res = await refused({ path })
      expect(res.status, path).toBe(404)
      expect(res.body).toBe('Not found.')
    }
    expect(onConnection).not.toHaveBeenCalled()
  })

  it('NS-11 421：坏 Host', async () => {
    const res = await refused({ headers: { Host: `evil:${port}` } })
    expect(res.status).toBe(421)
    expect(res.body).toBe('Use an IP address or localhost with the ShuviX port.')
    expect(onConnection).not.toHaveBeenCalled()
    expect(transport.connections()).toHaveLength(0)
  })
})

describe('NS-12 maxClients', () => {
  it('NS-12 第二个 → 503；第一个走了之后新的照连', async () => {
    await boot({ maxClients: 1 })
    const first = await connect()
    const res = await refused()
    expect(res.status).toBe(503)
    expect(res.body).toBe('Too many ShuviX web clients are connected.')
    first.ws.close()
    await vi.waitFor(() => expect(onDisconnection).toHaveBeenCalledTimes(1))
    await connect()
    expect(onConnection).toHaveBeenCalledTimes(2)
  })

  it('NS-12 握手途中的也算上：同时到的两次升级只放进一个', async () => {
    await boot({ maxClients: 1 })
    const results = await Promise.allSettled([connect(), connect()])
    const opened = results.filter((r) => r.status === 'fulfilled')
    expect(opened).toHaveLength(1)
    expect(transport.connections()).toHaveLength(1)
  })
})

describe('NS-13..NS-17 请求', () => {
  beforeEach(async () => {
    await boot()
  })

  it('NS-13 invoke 往返；处理函数收到 (ctx, undefined, {profile})', async () => {
    const fn = vi.fn((..._args: unknown[]) => ({ tools: ['a'] }))
    handle('tools:list', fn)
    const client = await connect()
    const reply = await invokeOnce(client, 1, 'tools:list', [undefined, { profile: 'chat' }])
    expect(reply).toStrictEqual({ t: 'result', id: 1, ok: true, value: { tools: ['a'] } })
    expect(fn).toHaveBeenCalledTimes(1)
    const [ctx, ...rest] = fn.mock.calls[0] as [ClientContext, ...unknown[]]
    expect(rest).toStrictEqual([undefined, { profile: 'chat' }])
    expect(rest.length).toBe(2)
    expect(ctx.transport).toBe('network')
    expect(ctx.client.id).toBe(onConnection.mock.calls[0][0].client.id)
  })

  it('NS-14 undefined → 线上没有 value；表外 / 桌面专属 / 抛', async () => {
    handle('tools:list', () => undefined)
    const openFolder = vi.fn()
    handle('app:open-folder', openFolder)
    handle('agent:getInfo', () => {
      throw new Error('kaboom')
    })
    const client = await connect()
    await invokeOnce(client, 1, 'tools:list')
    expect('value' in JSON.parse(client.messages[0])).toBe(false)
    expect(await invokeOnce(client, 2, 'nope:x')).toMatchObject({
      ok: false,
      error: { code: 'unknown_channel' }
    })
    expect(await invokeOnce(client, 3, 'app:open-folder', ['/x'])).toMatchObject({
      ok: false,
      error: { code: 'desktop_only' }
    })
    expect(openFolder).not.toHaveBeenCalled()
    expect(await invokeOnce(client, 4, 'agent:getInfo', ['s', undefined])).toStrictEqual({
      t: 'result',
      id: 4,
      ok: false,
      error: { message: 'kaboom', code: 'handler_error' }
    })
  })

  it('NS-15 BigInt / 循环对象 → handler_error 失败结果；socket 还开着', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    handle('tools:list', () => 10n)
    handle('agent:getInfo', () => circular)
    handle('app:version', () => '1.2.3')
    const client = await connect()
    const failure = {
      ok: false,
      error: { message: 'The result could not be sent over the network.', code: 'handler_error' }
    }
    expect(await invokeOnce(client, 1, 'tools:list')).toStrictEqual({
      t: 'result',
      id: 1,
      ...failure
    })
    expect(await invokeOnce(client, 2, 'agent:getInfo')).toStrictEqual({
      t: 'result',
      id: 2,
      ...failure
    })
    expect(await invokeOnce(client, 3, 'app:version')).toStrictEqual({
      t: 'result',
      id: 3,
      ok: true,
      value: '1.2.3'
    })
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('NS-16 send → listen 定义收到 (ctx, params)', async () => {
    const spy = vi.fn()
    listen('terminal:write', spy)
    const client = await connect()
    sendMessage(client, {
      t: 'send',
      channel: 'terminal:write',
      args: [{ terminalId: 't', data: 'x' }]
    })
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    const [ctx, params] = spy.mock.calls[0] as [ClientContext, unknown]
    expect(spy.mock.calls[0]).toHaveLength(2)
    expect(ctx.transport).toBe('network')
    expect(params).toStrictEqual({ terminalId: 't', data: 'x' })
  })

  it('NS-17 坏帧与二进制帧：不回、不调处理函数；下一个合法 invoke 照答', async () => {
    const fn = vi.fn(() => 'ok')
    handle('tools:list', fn)
    const client = await connect()
    client.ws.send('not json')
    client.ws.send('{"t":"invoke"}')
    client.ws.send(
      Buffer.from(encodeClientMessage({ t: 'invoke', id: 9, channel: 'tools:list', args: [] })),
      { binary: true }
    )
    const reply = await invokeOnce(client, 1, 'tools:list')
    expect(reply).toStrictEqual({ t: 'result', id: 1, ok: true, value: 'ok' })
    expect(client.messages).toHaveLength(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('NS-17b 认得出 id 的坏 invoke → bad_request', async () => {
    const fn = vi.fn(() => 'ok')
    handle('tools:list', fn)
    const client = await connect()
    client.ws.send(JSON.stringify({ t: 'invoke', id: 5, channel: '', args: [] }))
    client.ws.send(JSON.stringify({ t: 'invoke', id: 6, channel: 'tools:list', args: [1], u: [3] }))
    const all = await nextMessages(client, 2)
    expect(all).toStrictEqual([
      {
        t: 'result',
        id: 5,
        ok: false,
        error: { message: 'Malformed request.', code: 'bad_request' }
      },
      {
        t: 'result',
        id: 6,
        ok: false,
        error: { message: 'Malformed request.', code: 'bad_request' }
      }
    ])
    expect(fn).not.toHaveBeenCalled()
    expect(await invokeOnce(client, 7, 'tools:list')).toMatchObject({ ok: true, value: 'ok' })
  })
})

describe('NS-18 推送', () => {
  beforeEach(async () => {
    await boot()
  })

  it('NS-18 pushTo 的 undefined 经 u 保住', async () => {
    const client = await connect()
    const id = onConnection.mock.calls[0][0].client
    const ev = { type: 'agent_start', sessionId: 's1' }
    transport.pushTo(id, 'agent:event', [ev, undefined])
    await nextMessages(client, 1)
    expect(JSON.parse(client.messages[0]).u).toStrictEqual([1])
    expect(decodeServerMessage(client.messages[0])).toStrictEqual({
      t: 'push',
      channel: 'agent:event',
      args: [ev, undefined]
    })
  })

  it('NS-18 broadcast 到两个客户端', async () => {
    const a = await connect()
    const b = await connect()
    transport.broadcast('app:event', [{ type: 'bot.changed' }])
    const expected = { t: 'push', channel: 'app:event', args: [{ type: 'bot.changed' }] }
    expect((await nextMessages(a, 1))[0]).toStrictEqual(expected)
    expect((await nextMessages(b, 1))[0]).toStrictEqual(expected)
  })

  it('NS-18 编不出来的推送丢掉；连接还开着，下一条照到', async () => {
    const client = await connect()
    const ref = onConnection.mock.calls[0][0].client
    transport.pushTo(ref, 'agent:event', [10n])
    transport.pushTo(ref, 'agent:event', [{ ok: 1 }])
    const all = await nextMessages(client, 1)
    expect(all[0]).toStrictEqual({ t: 'push', channel: 'agent:event', args: [{ ok: 1 }] })
    await sleep(30)
    expect(client.messages).toHaveLength(1)
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
    expect(transport.isClientAlive(ref)).toBe(true)
  })
})

describe('NS-19 / NS-20 视图同步与断开', () => {
  beforeEach(async () => {
    await boot()
  })

  it('NS-19 hello → accept（主体由服务端盖章）；link.send → 客户端收到 sync 帧', async () => {
    const client = await connect()
    const id = onConnection.mock.calls[0][0].client.id
    sendMessage(client, { t: 'sync', link: 'L1', frame: { ...HELLO, clientId: 'spoofed' } })
    await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1))
    expect(accepted[0].principal).toStrictEqual({
      kind: 'network',
      clientId: id,
      remoteAddress: '127.0.0.1'
    })
    accepted[0].link.send({ t: 'x' } as never)
    expect((await nextMessages(client, 1))[0]).toStrictEqual({
      t: 'sync',
      link: 'L1',
      frame: { t: 'x' }
    })
  })

  it('NS-20 客户端关掉：onDisconnection 一次、表都已摘掉、链路结束、onClientGone 一次、之后 pushTo 无操作', async () => {
    const client = await connect()
    const connection = onConnection.mock.calls[0][0]
    const id = connection.client.id
    sendMessage(client, { t: 'sync', link: 'L1', frame: HELLO })
    await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1))
    const gone = vi.fn()
    transport.onClientGone(connection.client, gone)
    let inCallback: { listed: boolean; links: number } | undefined
    onDisconnection.mockImplementation((c) => {
      inCallback = {
        listed: transport.connections().includes(c),
        links: links.linkCount(c.client.id)
      }
    })
    client.ws.close()
    await vi.waitFor(() => expect(onDisconnection).toHaveBeenCalledTimes(1))
    expect(onDisconnection.mock.calls[0][0]).toBe(connection)
    expect(inCallback).toStrictEqual({ listed: false, links: 0 })
    expect(accepted[0].reasons).toStrictEqual(['network client disconnected'])
    expect(gone).toHaveBeenCalledTimes(1)
    expect(links.linkCount(id)).toBe(0)
    expect(() => transport.pushTo(connection.client, 'agent:event', [{}])).not.toThrow()
    expect(transport.isClientAlive(connection.client)).toBe(false)
  })
})

describe('NS-21..NS-23 停止与端口', () => {
  it('NS-21 stop()：每个客户端 1001，端口放开，再 stop 无事，同一端口能再 start', async () => {
    await boot()
    const a = await connect()
    const b = await connect()
    await server!.stop()
    expect(await a.closed).toStrictEqual({ code: 1001, reason: 'network access turned off' })
    expect(await b.closed).toStrictEqual({ code: 1001, reason: 'network access turned off' })
    expect(server!.port).toBeUndefined()
    expect(onDisconnection).toHaveBeenCalledTimes(2)
    await expect(http('/')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    const probe = createNetServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => resolve())
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    await expect(server!.stop()).resolves.toBeUndefined()
    await expect(server!.start(port, '127.0.0.1')).resolves.toBe(port)
    expect((await http('/')).status).toBe(200)
  })

  it("NS-21 stop('bye') → 原因 'bye'", async () => {
    await boot()
    const a = await connect()
    await server!.stop('bye')
    expect(await a.closed).toStrictEqual({ code: 1001, reason: 'bye' })
  })

  it('NS-22 第二次 start → 拒绝', async () => {
    await boot()
    await expect(server!.start(0, '127.0.0.1')).rejects.toThrow('network server is already running')
    expect(server!.port).toBe(port)
  })

  it('NS-23 端口被占 → EADDRINUSE，port undefined；之后 start(0) 照样成功', async () => {
    const occupied = await freePort()
    const blocker = createNetServer()
    await new Promise<void>((resolve) => blocker.listen(occupied, '127.0.0.1', () => resolve()))
    try {
      const dispatcher = createNetworkDispatcher({ definitionOf: transport.definitionOf })
      server = createNetworkServer({ transport, dispatcher, links, rendererDir: () => currentDir })
      await expect(server.start(occupied, '127.0.0.1')).rejects.toMatchObject({
        code: 'EADDRINUSE'
      })
      expect(server.port).toBeUndefined()
      port = await server.start(0, '127.0.0.1')
      expect(port).toBeGreaterThan(0)
      expect((await http('/')).status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})

describe('NS-24 / NS-25 心跳与慢客户端', () => {
  it('NS-24 正常客户端还开着；不回 pong 的以 1006 断开', async () => {
    await boot({ heartbeatMs: 30 })
    const healthy = await connect()
    const silent = await connect({ autoPong: false })
    const silentClosed = await Promise.race([
      silent.closed,
      sleep(1500).then(() => 'timeout' as const)
    ])
    expect(silentClosed).toMatchObject({ code: 1006 })
    await vi.waitFor(() => expect(onDisconnection).toHaveBeenCalledTimes(1))
    await sleep(200)
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN)
    expect(onDisconnection).toHaveBeenCalledTimes(1)
  })

  it("NS-25 maxBufferedBytes:-1：第一条服务端消息改成 1008 'client too slow'", async () => {
    await boot({ maxBufferedBytes: -1 })
    handle('tools:list', () => 'never seen')
    const client = await connect()
    sendMessage(client, { t: 'invoke', id: 1, channel: 'tools:list', args: [] })
    expect(await client.closed).toStrictEqual({ code: 1008, reason: 'client too slow' })
    expect(client.messages).toStrictEqual([])
    await vi.waitFor(() => expect(onDisconnection).toHaveBeenCalledTimes(1))
  })
})

describe('NS-26..NS-28 杂项', () => {
  beforeEach(async () => {
    await boot()
  })

  it('NS-26 两条连接的 id 不同，后一条的序号更大', async () => {
    await connect()
    await connect()
    const [a, b] = onConnection.mock.calls.map(([c]) => c.client.id)
    expect(a).not.toBe(b)
    const n = (id: string): number => Number(id.slice('ws:'.length))
    expect(n(b)).toBeGreaterThan(n(a))
  })

  it('NS-27 乱发的原始 socket 被断开；之后 GET / 照样 200', async () => {
    const socket = new Socket()
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
    socket.on('error', () => {})
    socket.connect(port, '127.0.0.1', () => socket.write('GARBAGE\r\n\r\n'))
    await Promise.race([closed, sleep(2000).then(() => Promise.reject(new Error('not closed')))])
    expect((await http('/')).status).toBe(200)
  })

  it('NS-28 GET /INDEX.HTML → 404', async () => {
    for (const path of ['/INDEX.HTML', '/Index.html']) {
      const res = await http(path)
      expect(res.status, path).toBe(404)
      expect(res.body).not.toContain(INDEX_HTML)
    }
  })
})

describe('NS-29 全栈：渲染端的 web 客户端', () => {
  it('NS-29 api.tools.list 调到处理函数；stop → reconnecting；同端口再 start → open', async () => {
    await boot()
    const fn = vi.fn((..._args: unknown[]) => ['tool-a'])
    handle('tools:list', fn)
    const conn = createWsConnection({
      url: wsUrl(),
      createSocket: (url) =>
        new WebSocket(url, { origin: `http://127.0.0.1:${port}` }) as unknown as WebSocketLike,
      minDelayMs: 20,
      maxDelayMs: 50
    })
    try {
      const api = createWebApi(conn)
      await expect(api.tools.list(undefined, { profile: 'chat' })).resolves.toStrictEqual([
        'tool-a'
      ])
      expect(conn.state()).toBe('open')
      const [ctx, ...rest] = fn.mock.calls[0] as [ClientContext, ...unknown[]]
      expect(ctx.transport).toBe('network')
      expect(rest).toStrictEqual([undefined, { profile: 'chat' }])
      expect(rest.length).toBe(2)

      await server!.stop()
      await vi.waitFor(() => expect(conn.state()).toBe('reconnecting'))
      await server!.start(port, '127.0.0.1')
      await vi.waitFor(() => expect(conn.state()).toBe('open'), { timeout: 3000 })
      await expect(api.tools.list('s1')).resolves.toStrictEqual(['tool-a'])
    } finally {
      conn.dispose()
    }
  })
})
