/**
 * `frontend/network/widgetProxy.ts`（server mode phase D §D2）—— 网络服务把 `/w/…` 原样转给只绑 127.0.0.1 的 widget 服务。
 * 上游是一个真的 `node:http` 服务（127.0.0.1 随机端口），记下每个请求的方法 / 路径 / 头 / 正文，怎么回由每条用例的脚本定；
 * 网络服务是真的 `createNetworkServer`，`widgetProxy: () => ({ target, logger })`，`target` 是现取的间谍。
 *
 *   WP-1  forwardableHeaders（纯）：九个逐跳头（不分大小写）丢掉；Connection 里点名的、额外点名的（不分大小写）丢掉；
 *         留下的键小写；undefined 跳过；set-cookie 数组原样
 *   WP-2  GET 带查询串：上游收到同样的路径与查询串、GET、Host 换成上游自己的；普通头与 cookie 到了，逐跳头与
 *         Connection 点名的没到。上游 201 + content-type / ACAO / 两条 set-cookie / Connection 点名的头 / keep-alive
 *         → 客户端 201、同样的正文与普通头、两条 cookie 都在，点名的与 keep-alive 的值没转回来
 *   WP-3  POST / PUT / PATCH / DELETE 方法不变；1 MiB 的二进制 POST 逐字节到上游；OPTIONS → 204 + allow-*、没正文；
 *         HEAD 只有头
 *   WP-4  事件流：上游只写了头（flushHeaders）客户端就收到应答；`:\n\n` 在上游还开着时作为一块到达；再来
 *         `event: reload`
 *   WP-5  客户端中途断开 → 上游请求 2 秒内关掉；没有 warn；下一个转发照常
 *   WP-6  target() 是 undefined → 503 no-store 与那句话，上游没收到请求；target() 每个请求现取
 *   WP-7  502：没人在听 → `The ShuviX widget server did not answer.` + 一条带方法与路径的 warn；上游没回就断开 →
 *         502；上游回了头与半截正文再断开 → 客户端那次应答不完整、服务还活着，下一个请求照常
 *   WP-8  `/w`、`/W/demo/`、`/wx/a`、`/files/w/` 不转（静态 404）；没给 widgetProxy → `/w/demo-widget/` 静态 404
 *   WP-9  坏 Host → 421；target() 一次都不调
 *   WP-10 转发着一条事件流时 server.stop() 1.5 秒内 resolve，上游看到断开
 *   WP-11 HTML 应答加沙箱 CSP（`WIDGET_DOCUMENT_CSP`）；上游自带 CSP → 接在后面；不是 HTML 的应答原样
 *   WP-12 widget 文件路由（`/w/<id>/fs/…`）的应答补 `Access-Control-Allow-Origin: *`：
 *         a 上游不带 → 客户端带，上游收到同样的路径与查询串；HEAD 只回头、GET + Range 的 206 也带
 *         b 上游的错误（404 文本、400 JSON）状态与正文照搬、也带
 *         c 上游自带别的 ACAO → 文件路由上换成 `*`，别的路由原样
 *         d 转发自己回的 503（target 不在）/ 502（上游没在听）：文件路由带，别的路由不带
 *         e 不是文件路由（页面、db、`fsx`、`FS`、`//fs`）且上游不带 → 不补
 *         f 文件路由上 text/html 的应答照样加沙箱 CSP，也带 ACAO
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNetworkDispatcher } from '../dispatch'
import { createNetworkLinkHub } from '../networkLinks'
import { createNetworkServer, type NetworkServer, type NetworkServerDeps } from '../server'
import { createNetworkTransport } from '../transport'
import { WIDGET_DOCUMENT_CSP, forwardableHeaders, type WidgetProxyTarget } from '../widgetProxy'

const NOT_RUNNING = 'The ShuviX widget server is not running. Open the widget again.'
const NO_ANSWER = 'The ShuviX widget server did not answer.'

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: Buffer
}

type Script = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void

let tmp: string
let upstream: Server
let upstreamPort: number
let seen: Seen[]
let script: Script
let server: NetworkServer | undefined
let port: number
let current: WidgetProxyTarget | undefined
let target: ReturnType<typeof vi.fn<() => WidgetProxyTarget | undefined>>
let warn: ReturnType<typeof vi.fn<(message: string) => void>>

const ok: Script = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('upstream ok')
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-net-widget-'))
  writeFileSync(join(tmp, 'web.html'), '<p>web</p>')
  seen = []
  script = ok
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      script(req, res, body)
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  upstreamPort = (upstream.address() as { port: number }).port
  current = { host: '127.0.0.1', port: upstreamPort }
  target = vi.fn(() => current)
  warn = vi.fn()
  server = undefined
})

afterEach(async () => {
  await server?.stop()
  upstream.closeAllConnections()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  rmSync(tmp, { recursive: true, force: true })
})

async function boot(overrides: Partial<NetworkServerDeps> = {}): Promise<number> {
  const transport = createNetworkTransport()
  server = createNetworkServer({
    transport,
    dispatcher: createNetworkDispatcher({ definitionOf: transport.definitionOf }),
    links: createNetworkLinkHub({ accept: () => {} }),
    rendererDir: () => tmp,
    widgetProxy: () => ({ target, logger: { warn } }),
    heartbeatMs: 60_000,
    ...overrides
  })
  port = await server.start(0, '127.0.0.1')
  return port
}

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

function http(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        headers: options.headers,
        agent: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

async function freePort(): Promise<number> {
  const probe = createNetServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port: free } = probe.address() as { port: number }
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return free
}

/** 一次事件流：应答到了就交出来，块随到随记 */
interface Stream {
  response: Promise<IncomingMessage>
  chunks: string[]
  abort(): void
}

function openStream(path: string): Stream {
  const chunks: string[] = []
  let req!: ReturnType<typeof httpRequest>
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => chunks.push(chunk))
      res.on('error', () => {})
      resolve(res)
    })
    req.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
    })
    req.end()
  })
  return { response, chunks, abort: () => req.destroy() }
}

/** 上游这条应答（或它的连接）关掉了 */
function upstreamClosed(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => res.on('close', () => resolve()))
}

describe('WP-1 forwardableHeaders', () => {
  it('WP-1 九个逐跳头不分大小写丢掉；留下的键小写', () => {
    const out = forwardableHeaders({
      Connection: 'close',
      'KEEP-ALIVE': 'timeout=5',
      'Proxy-Authenticate': 'Basic',
      'proxy-authorization': 'Basic x',
      'Proxy-Connection': 'keep-alive',
      TE: 'trailers',
      Trailer: 'x',
      'Transfer-Encoding': 'chunked',
      Upgrade: 'websocket',
      'X-Test': '1',
      Accept: 'text/html'
    } as unknown as IncomingHttpHeaders)
    expect(out).toStrictEqual({ 'x-test': '1', accept: 'text/html' })
  })

  it('WP-1 Connection 里点名的、额外点名的（不分大小写）丢掉', () => {
    const out = forwardableHeaders(
      {
        connection: 'close, X-Secret ,x-other',
        'x-secret': 's',
        'x-other': 'o',
        host: 'h:1',
        'x-keep': 'k'
      },
      ['HOST']
    )
    expect(out).toStrictEqual({ 'x-keep': 'k' })
  })

  it('WP-1 undefined 跳过；set-cookie 数组原样', () => {
    const cookies = ['a=1; Path=/', 'b=2; HttpOnly']
    const out = forwardableHeaders({ 'set-cookie': cookies, 'x-none': undefined, 'x-a': 'a' })
    expect(out).toStrictEqual({ 'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'], 'x-a': 'a' })
    expect('x-none' in out).toBe(false)
  })
})

describe('WP-2 / WP-3 请求与应答照搬', () => {
  beforeEach(async () => {
    await boot()
  })

  it('WP-2 路径与查询串、方法、Host、普通头照搬；逐跳头与 Connection 点名的不转；应答同理', async () => {
    script = (_req, res) => {
      res.writeHead(201, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'set-cookie': ['a=1; Path=/', 'b=2; Path=/'],
        connection: 'x-hop',
        'x-hop': 'hop-value',
        'keep-alive': 'timeout=99, max=7'
      })
      res.end('{"rows":[1]}')
    }
    const res = await http('/w/demo-widget/db/items?select=*&id=eq.1', {
      headers: {
        'x-test': 't',
        cookie: 'sid=abc',
        te: 'trailers',
        connection: 'keep-alive, x-secret',
        'x-secret': 'do-not-forward',
        'proxy-authorization': 'Basic Zm9vOmJhcg=='
      }
    })

    expect(seen).toHaveLength(1)
    const up = seen[0]
    expect(up.method).toBe('GET')
    expect(up.url).toBe('/w/demo-widget/db/items?select=*&id=eq.1')
    expect(up.headers.host).toBe(`127.0.0.1:${upstreamPort}`)
    expect(up.headers['x-test']).toBe('t')
    expect(up.headers.cookie).toBe('sid=abc')
    expect(up.headers.te).toBeUndefined()
    expect(up.headers['x-secret']).toBeUndefined()
    expect(up.headers['proxy-authorization']).toBeUndefined()
    expect(up.headers['keep-alive']).toBeUndefined()
    // 上游那一段的 Connection 是转发请求自己的（agent:false → close），不是浏览器那一段的
    expect(String(up.headers.connection ?? '')).not.toContain('x-secret')

    expect(res.status).toBe(201)
    expect(res.body.toString()).toBe('{"rows":[1]}')
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['set-cookie']).toStrictEqual(['a=1; Path=/', 'b=2; Path=/'])
    expect(res.headers['x-hop']).toBeUndefined()
    // 客户端这一段的 keep-alive（如有）是网络服务自己的，不是上游那条
    expect(String(res.headers['keep-alive'] ?? '')).not.toContain('max=7')
    expect(String(res.headers.connection ?? '')).not.toContain('x-hop')
  })

  it('WP-3 POST / PUT / PATCH / DELETE 方法不变', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const body = Buffer.from(`{"m":"${method}"}`)
      // 长度写明：Node 的客户端给 DELETE 的正文不自己加 Content-Length（浏览器总会加）
      const res = await http('/w/demo-widget/db/items', {
        method,
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        body
      })
      expect(res.status, method).toBe(200)
      const up = seen.at(-1)!
      expect(up.method, method).toBe(method)
      expect(up.url, method).toBe('/w/demo-widget/db/items')
      expect(up.body.toString(), method).toBe(`{"m":"${method}"}`)
    }
  })

  it('WP-3 1 MiB 的二进制 POST 逐字节到上游', async () => {
    const payload = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) % 256
    script = (_req, res, body) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(String(body.length))
    }
    const res = await http('/w/demo-widget/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(payload.length)
      },
      body: payload
    })
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe(String(payload.length))
    expect(seen.at(-1)!.body.equals(payload)).toBe(true)
  })

  it('WP-3 OPTIONS → 204 + allow-*、没正文；HEAD 只有头', async () => {
    script = (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
          'access-control-allow-headers': 'content-type, prefer'
        })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '11' })
      res.end(req.method === 'HEAD' ? undefined : 'hello world')
    }
    const options = await http('/w/demo-widget/db/items', { method: 'OPTIONS' })
    expect(options.status).toBe(204)
    expect(options.headers['access-control-allow-origin']).toBe('*')
    expect(options.headers['access-control-allow-methods']).toBe('GET, POST, PATCH, DELETE')
    expect(options.headers['access-control-allow-headers']).toBe('content-type, prefer')
    expect(options.body.length).toBe(0)
    expect(seen.at(-1)!.method).toBe('OPTIONS')

    const head = await http('/w/demo-widget/', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['content-type']).toBe('text/html')
    expect(head.headers['content-length']).toBe('11')
    expect(head.body.length).toBe(0)
    expect(seen.at(-1)!.method).toBe('HEAD')
  })
})

describe('WP-4 / WP-5 事件流', () => {
  beforeEach(async () => {
    await boot()
  })

  it('WP-4 只写了头就到客户端；块在上游还开着时一块一块到', async () => {
    let upstreamRes!: ServerResponse
    let upstreamOpen = false
    const ready = new Promise<void>((resolve) => {
      script = (_req, res) => {
        upstreamRes = res
        upstreamOpen = true
        res.on('close', () => (upstreamOpen = false))
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.flushHeaders()
        resolve()
      }
    })
    const stream = openStream('/w/demo-widget/sse')
    await ready
    const res = await stream.response
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(upstreamOpen).toBe(true)
    expect(stream.chunks).toStrictEqual([])

    upstreamRes.write(':\n\n')
    await vi.waitFor(() => expect(stream.chunks.join('')).toBe(':\n\n'))
    expect(upstreamOpen).toBe(true)

    upstreamRes.write('event: reload\ndata: {}\n\n')
    await vi.waitFor(() => expect(stream.chunks.join('')).toBe(':\n\nevent: reload\ndata: {}\n\n'))
    expect(upstreamOpen).toBe(true)
    stream.abort()
  })

  it('WP-5 客户端中途断开 → 上游 2 秒内关掉；没有 warn；下一个转发照常', async () => {
    let closed!: Promise<void>
    const ready = new Promise<void>((resolve) => {
      script = (_req, res) => {
        closed = upstreamClosed(res)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(':\n\n')
        resolve()
      }
    })
    const stream = openStream('/w/demo-widget/sse')
    await ready
    await stream.response
    await vi.waitFor(() => expect(stream.chunks.join('')).toBe(':\n\n'))

    const started = Date.now()
    stream.abort()
    await closed
    expect(Date.now() - started).toBeLessThan(2000)

    script = ok
    const next = await http('/w/demo-widget/x')
    expect(next.status).toBe(200)
    expect(next.body.toString()).toBe('upstream ok')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('WP-6 / WP-7 上游不在 / 出错', () => {
  it('WP-6 target() undefined → 503 no-store 与那句话，上游没收到；target() 每个请求现取', async () => {
    await boot()
    current = undefined
    const res = await http('/w/demo-widget/')
    expect(res.status).toBe(503)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.toString()).toBe(NOT_RUNNING)
    expect(seen).toHaveLength(0)
    expect(target).toHaveBeenCalledTimes(1)

    current = { host: '127.0.0.1', port: upstreamPort }
    const later = await http('/w/demo-widget/')
    expect(later.status).toBe(200)
    expect(later.body.toString()).toBe('upstream ok')
    expect(target).toHaveBeenCalledTimes(2)
  })

  it('WP-7 没人在听 → 502 + 一条带方法与路径的 warn', async () => {
    await boot()
    current = { host: '127.0.0.1', port: await freePort() }
    const res = await http('/w/demo-widget/x?y=1')
    expect(res.status).toBe(502)
    expect(res.body.toString()).toBe(NO_ANSWER)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('GET')
    expect(warn.mock.calls[0][0]).toContain('/w/demo-widget/x?y=1')
  })

  it('WP-7 上游没回就断开 → 502', async () => {
    await boot()
    script = (req) => req.socket.destroy()
    const res = await http('/w/demo-widget/x')
    expect(res.status).toBe(502)
    expect(res.body.toString()).toBe(NO_ANSWER)
  })

  it('WP-7 上游回了头与半截正文再断开 → 客户端应答不完整；服务还活着，下一个照常', async () => {
    await boot()
    script = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' })
      res.write('part', () => setTimeout(() => req.socket.destroy(), 20))
    }
    const outcome = await new Promise<{ complete: boolean; body: string }>((resolve) => {
      let body = ''
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/w/demo-widget/x', agent: false },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => (body += chunk))
          res.on('error', () => {})
          res.on('close', () => resolve({ complete: res.complete, body }))
        }
      )
      req.on('error', () => resolve({ complete: false, body }))
      req.end()
    })
    expect(outcome.complete).toBe(false)
    expect(outcome.body.length).toBeLessThan(1000)

    script = ok
    const next = await http('/w/demo-widget/y')
    expect(next.status).toBe(200)
    expect(next.body.toString()).toBe('upstream ok')
  })
})

describe('WP-8 / WP-9 不转的路径与 Host 那道门', () => {
  it('WP-8 /w、/W/demo/、/wx/a、/files/w/ 不转（静态 404）', async () => {
    await boot()
    for (const path of ['/w', '/W/demo/', '/wx/a', '/files/w/']) {
      const res = await http(path)
      expect(res.status, path).toBe(404)
      expect(res.body.toString(), path).toBe('Not found.')
    }
    expect(seen).toHaveLength(0)
  })

  it('WP-8 没给 widgetProxy → /w/demo-widget/ 静态 404', async () => {
    await boot({ widgetProxy: undefined })
    const res = await http('/w/demo-widget/')
    expect(res.status).toBe(404)
    expect(res.body.toString()).toBe('Not found.')
    expect(seen).toHaveLength(0)
    expect(target).not.toHaveBeenCalled()
  })

  it('WP-9 坏 Host → 421；target() 一次都不调', async () => {
    await boot()
    const res = await http('/w/demo-widget/', { headers: { Host: `evil.example:${port}` } })
    expect(res.status).toBe(421)
    expect(res.headers.connection).toBe('close')
    expect(target).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })
})

describe('WP-10 停止', () => {
  it('WP-10 转发着事件流时 stop() 1.5 秒内 resolve，上游看到断开', async () => {
    await boot()
    let closed!: Promise<void>
    const ready = new Promise<void>((resolve) => {
      script = (_req, res) => {
        closed = upstreamClosed(res)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(':\n\n')
        resolve()
      }
    })
    const stream = openStream('/w/demo-widget/sse')
    await ready
    await stream.response

    const started = Date.now()
    await server!.stop()
    expect(Date.now() - started).toBeLessThan(1500)
    await closed
    server = undefined
  })
})

describe('WP-11 HTML 应答的沙箱 CSP', () => {
  beforeEach(async () => {
    await boot()
  })

  it('WP-11 text/html（不分大小写、带 charset）→ 加 WIDGET_DOCUMENT_CSP', async () => {
    expect(WIDGET_DOCUMENT_CSP).toBe(
      'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'
    )
    for (const type of ['text/html', 'text/html; charset=utf-8', 'TEXT/HTML']) {
      script = (_req, res) => {
        res.writeHead(200, { 'content-type': type })
        res.end('<!doctype html><p>widget</p>')
      }
      const res = await http('/w/demo-widget/')
      expect(res.status, type).toBe(200)
      expect(res.headers['content-security-policy'], type).toBe(WIDGET_DOCUMENT_CSP)
      expect(res.body.toString(), type).toBe('<!doctype html><p>widget</p>')
    }
  })

  it('WP-11 上游自带 CSP → 接在后面', async () => {
    script = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'self'"
      })
      res.end('<p>w</p>')
    }
    const res = await http('/w/demo-widget/')
    expect(res.headers['content-security-policy']).toBe(
      `default-src 'self', ${WIDGET_DOCUMENT_CSP}`
    )
  })

  it('WP-11 不是 HTML 的应答原样：不加 CSP；自带的原样转回', async () => {
    script = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('[]')
    }
    const json = await http('/w/demo-widget/db/items')
    expect(json.headers['content-security-policy']).toBeUndefined()

    script = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/javascript',
        'content-security-policy': "script-src 'none'"
      })
      res.end('1')
    }
    const js = await http('/w/demo-widget/bundle.js')
    expect(js.headers['content-security-policy']).toBe("script-src 'none'")
  })
})

describe('WP-12 widget 文件路由补 ACAO *', () => {
  beforeEach(async () => {
    await boot()
  })

  it('WP-12a 上游不带 ACAO → 客户端带 *；路径与查询串照搬；HEAD 与 Range 的 206 也带', async () => {
    script = (req, res) => {
      if (req.url?.startsWith('/w/demo-widget/fs/list')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"path":"/tmp","entries":[],"truncated":false}')
        return
      }
      if (req.headers.range) {
        res.writeHead(206, {
          'content-type': 'image/png',
          'content-range': 'bytes 0-1/4',
          'content-length': '2'
        })
        res.end('ab')
        return
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4' })
      res.end(req.method === 'HEAD' ? undefined : 'abcd')
    }
    const list = await http('/w/demo-widget/fs/list?path=%2Ftmp')
    expect(list.status).toBe(200)
    expect(list.headers['access-control-allow-origin']).toBe('*')
    expect(list.body.toString()).toBe('{"path":"/tmp","entries":[],"truncated":false}')
    expect(seen.at(-1)!.url).toBe('/w/demo-widget/fs/list?path=%2Ftmp')

    const head = await http('/w/demo-widget/fs/file?path=%2Fa.png', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['access-control-allow-origin']).toBe('*')
    expect(head.headers['content-length']).toBe('4')
    expect(head.body.length).toBe(0)
    expect(seen.at(-1)!.method).toBe('HEAD')
    expect(seen.at(-1)!.url).toBe('/w/demo-widget/fs/file?path=%2Fa.png')

    const range = await http('/w/demo-widget/fs/file?path=%2Fa.png', {
      headers: { range: 'bytes=0-1' }
    })
    expect(range.status).toBe(206)
    expect(range.headers['access-control-allow-origin']).toBe('*')
    expect(range.headers['content-range']).toBe('bytes 0-1/4')
    expect(range.body.toString()).toBe('ab')
    expect(seen.at(-1)!.headers.range).toBe('bytes=0-1')
  })

  it('WP-12b 上游的错误状态与正文照搬，也带 ACAO *', async () => {
    script = (_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found.')
    }
    const missing = await http('/w/demo-widget/fs/file?path=%2Fnope')
    expect(missing.status).toBe(404)
    expect(missing.body.toString()).toBe('Not found.')
    expect(missing.headers['access-control-allow-origin']).toBe('*')

    const badBody = '{"code":"BAD_PATH","message":"path must be an absolute path or start with ~"}'
    script = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(badBody)
    }
    const bad = await http('/w/demo-widget/fs/list?path=rel')
    expect(bad.status).toBe(400)
    expect(bad.body.toString()).toBe(badBody)
    expect(bad.headers['access-control-allow-origin']).toBe('*')
  })

  it('WP-12c 上游自带别的 ACAO：文件路由上换成 *，别的路由原样', async () => {
    script = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'access-control-allow-origin': 'https://a.example'
      })
      res.end('x')
    }
    const files = await http('/w/demo-widget/fs/file?path=%2Fa')
    expect(files.headers['access-control-allow-origin']).toBe('*')
    const other = await http('/w/demo-widget/bundle.js')
    expect(other.headers['access-control-allow-origin']).toBe('https://a.example')
  })

  it('WP-12d 转发自己回的 503 / 502：文件路由带 ACAO *，别的路由不带', async () => {
    current = undefined
    const filesDown = await http('/w/demo-widget/fs/list?path=%2Ftmp')
    expect(filesDown.status).toBe(503)
    expect(filesDown.body.toString()).toBe(NOT_RUNNING)
    expect(filesDown.headers['access-control-allow-origin']).toBe('*')
    const pageDown = await http('/w/demo-widget/')
    expect(pageDown.status).toBe(503)
    expect(pageDown.headers['access-control-allow-origin']).toBeUndefined()

    current = { host: '127.0.0.1', port: await freePort() }
    const filesGone = await http('/w/demo-widget/fs/file?path=%2Fa')
    expect(filesGone.status).toBe(502)
    expect(filesGone.body.toString()).toBe(NO_ANSWER)
    expect(filesGone.headers['access-control-allow-origin']).toBe('*')
    const pageGone = await http('/w/demo-widget/')
    expect(pageGone.status).toBe(502)
    expect(pageGone.headers['access-control-allow-origin']).toBeUndefined()
    expect(seen).toHaveLength(0)
  })

  it('WP-12e 不是文件路由、上游不带 → 不补 ACAO', async () => {
    for (const path of [
      '/w/demo-widget/',
      '/w/demo-widget/db/todos',
      '/w/demo-widget/fsx/file',
      '/w/demo-widget/FS/file',
      '/w/demo-widget//fs/file'
    ]) {
      const res = await http(path)
      expect(res.status, path).toBe(200)
      expect(res.headers['access-control-allow-origin'], path).toBeUndefined()
    }
    expect(seen).toHaveLength(5)
  })

  it('WP-12f 文件路由上 text/html 的应答照样加沙箱 CSP，也带 ACAO *', async () => {
    script = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<p>x</p>')
    }
    const res = await http('/w/demo-widget/fs/file?path=%2Fa.html')
    expect(res.headers['content-security-policy']).toBe(WIDGET_DOCUMENT_CSP)
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })
})
