/**
 * `services/widget/widgetServer.ts` —— widget 服务的两道门（Host、文件路由不带 CORS 头）与文件路由的接线。
 * 真的 `WidgetServer`（127.0.0.1 随机端口）；打包服务、widget 数据库、logger 换成空壳。注册的 widget `photo-wall`
 * 的打包产物是 `js` / `css`。请求用 `node:http`（`agent:false`），Host 头显式给出；没有 Host 的 HTTP/1.0 请求走裸 socket。
 *
 *   WS-G1 Host `127.0.0.1:P` / `localhost:P`（不分大小写）→ 照常
 *   WS-G2 别的 Host（外域、外域带端口、不带端口、别的端口、`localhost.`、`[::1]`、`127.0.0.2`）→ 421 + connection: close，
 *         没有 ACAO；各条路由都一样（文件路由不出文件内容）；OPTIONS 也是 421；数据库接口一次都不调
 *   WS-G3 HTTP/1.0 不带 Host → 421（HTTP/1.1 不带 Host 由 Node 自己回 400，到不了这道门）
 *   WS-C1 非文件路由带 ACAO * 与 allow-methods / allow-headers（含 404）
 *   WS-C2 非文件路由的 OPTIONS → 204 空正文 + ACAO *
 *   WS-C3 文件路由的应答（200 / 404 / 400）没有 ACAO、没有 allow-methods
 *   WS-C4 文件路由的预检形状 OPTIONS → 405（file 纯文本 / list JSON），没有 ACAO
 *   WS-C5 没注册的 widget 的文件路由 → 404 `Widget … not registered`；id 不合规 → 404 `Not found`；都不带 ACAO、不出文件
 *   WS-C6 长得像文件路由的（`//fs/`、`FS`、`%66s`）→ 落到页面或 404，正文里没有秘密文件的内容
 *   WS-C7 unregisterWidget 之后文件路由 → 404 not registered
 *   WS-R1 fs/file png → 200 image/png 字节一致；Range → 206
 *   WS-R2 fs/list → 200 JSON，名字对得上
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  build: vi.fn(async () => ({ success: true, outputJS: 'js', outputCSS: 'css' })),
  handleRestRequest: vi.fn(async () => ({ rows: [] as unknown[] }))
}))

vi.mock('../../bundler', () => ({
  bundlerService: { build: mocks.build },
  bundlerResourcePath: (p: string) => p
}))
vi.mock('../widgetDb', () => ({
  handleRestRequest: mocks.handleRestRequest,
  WidgetDbError: class WidgetDbError extends Error {}
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { WidgetServer } from '../widgetServer'

const SECRET = 'top-secret-file-contents-42'

let tmp: string
let secretFile: string
let server: WidgetServer
let port: number

interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

function http(
  path: string,
  options: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<HttpResult> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        headers: { host: options.host ?? `127.0.0.1:${port}`, ...options.headers },
        agent: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        )
        res.on('error', fail)
      }
    )
    req.on('error', fail)
    req.end(options.body)
  })
}

const q = (p: string): string => encodeURIComponent(p)

beforeEach(async () => {
  mocks.build.mockClear()
  mocks.handleRestRequest.mockClear()
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-server-'))
  secretFile = join(tmp, 'secret.txt')
  writeFileSync(secretFile, SECRET)
  writeFileSync(join(tmp, 'index.tsx'), 'export {}')
  server = new WidgetServer()
  await server.registerAndBuild('photo-wall', tmp, 'index.tsx')
  port = server.getStatus().port
})

afterEach(() => {
  server.dispose()
  rmSync(tmp, { recursive: true, force: true })
})

describe('WS-G Host 那道门', () => {
  it('WS-G1 127.0.0.1 / localhost（不分大小写）带本端口 → 照常', async () => {
    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `LOCALHOST:${port}`,
      `LocalHost:${port}`
    ]) {
      const res = await http('/w/photo-wall/bundle.js', { host })
      expect(res.status, host).toBe(200)
      expect(res.body.toString(), host).toBe('js')
    }
  })

  it('WS-G2 别的 Host → 421 + connection: close，各条路由一样，不出文件、数据库不调', async () => {
    const hosts = [
      'evil.example',
      `evil.example:${port}`,
      '127.0.0.1',
      `127.0.0.1:${port + 1}`,
      `localhost.:${port}`,
      `[::1]:${port}`,
      `127.0.0.2:${port}`
    ]
    const routes: Array<{ path: string; method?: string; body?: string }> = [
      { path: '/w/photo-wall/' },
      { path: '/w/photo-wall/bundle.js' },
      { path: '/w/photo-wall/db/todos' },
      { path: '/w/photo-wall/db/todos', method: 'POST', body: '{"a":1}' },
      { path: '/w/photo-wall/db/todos', method: 'OPTIONS' },
      { path: `/w/photo-wall/fs/file?path=${q(secretFile)}` },
      { path: `/w/photo-wall/fs/list?path=${q(tmp)}` },
      { path: '/w/nope-x/' },
      { path: '/' }
    ]
    for (const host of hosts) {
      for (const route of routes) {
        const label = `${host} ${route.method ?? 'GET'} ${route.path}`
        const res = await http(route.path, {
          host,
          method: route.method,
          body: route.body,
          headers: route.body ? { 'content-type': 'application/json' } : {}
        })
        expect(res.status, label).toBe(421)
        expect(res.headers.connection, label).toBe('close')
        expect(res.body.toString(), label).toBe('Misdirected request')
        expect(res.headers['access-control-allow-origin'], label).toBeUndefined()
      }
    }
    expect(mocks.handleRestRequest).not.toHaveBeenCalled()
  })

  it('WS-G3 HTTP/1.0 不带 Host → 421', async () => {
    // HTTP/1.1 不带 Host 由 Node 的解析器自己回 400，到不了这道门；只有 HTTP/1.0 能不带 Host 走到这里
    const raw = await new Promise<string>((done, fail) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write('GET /w/photo-wall/ HTTP/1.0\r\n\r\n')
      })
      let text = ''
      sock.setEncoding('utf8')
      sock.on('data', (chunk: string) => (text += chunk))
      sock.on('end', () => done(text))
      sock.on('error', fail)
    })
    expect(raw.split('\r\n')[0]).toMatch(/^HTTP\/1\.[01] 421 /)
  })
})

describe('WS-C CORS 头：只有非文件路由带', () => {
  it('WS-C1 非文件路由（含 404）带 ACAO * 与 allow-*', async () => {
    for (const path of ['/w/photo-wall/bundle.js', '/w/photo-wall/', '/w/nope-x/', '/']) {
      const res = await http(path)
      expect(res.headers['access-control-allow-origin'], path).toBe('*')
      expect(res.headers['access-control-allow-methods'], path).toBe(
        'GET, POST, PATCH, DELETE, OPTIONS'
      )
      expect(res.headers['access-control-allow-headers'], path).toBe('Content-Type')
    }
    expect((await http('/w/nope-x/')).status).toBe(404)
    expect((await http('/')).status).toBe(404)
  })

  it('WS-C2 非文件路由的 OPTIONS → 204 空正文 + ACAO *', async () => {
    for (const path of ['/w/photo-wall/db/todos', '/anything']) {
      const res = await http(path, { method: 'OPTIONS' })
      expect(res.status, path).toBe(204)
      expect(res.body.length, path).toBe(0)
      expect(res.headers['access-control-allow-origin'], path).toBe('*')
    }
    expect(mocks.handleRestRequest).not.toHaveBeenCalled()
  })

  it('WS-C3 文件路由的应答（200 / 404 / 400）没有 ACAO 与 allow-methods', async () => {
    const cases: Array<[string, number]> = [
      [`/w/photo-wall/fs/file?path=${q(secretFile)}`, 200],
      [`/w/photo-wall/fs/list?path=${q(tmp)}`, 200],
      [`/w/photo-wall/fs/file?path=${q(join(tmp, 'nope.txt'))}`, 404],
      ['/w/photo-wall/fs/list?path=rel', 400]
    ]
    for (const [path, status] of cases) {
      const res = await http(path)
      expect(res.status, path).toBe(status)
      expect(res.headers['access-control-allow-origin'], path).toBeUndefined()
      expect(res.headers['access-control-allow-methods'], path).toBeUndefined()
    }
    const bad = await http('/w/photo-wall/fs/list?path=rel')
    expect(JSON.parse(bad.body.toString()).code).toBe('BAD_PATH')
  })

  it('WS-C4 文件路由的预检形状 OPTIONS → 405，没有 ACAO', async () => {
    const headers = { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' }
    const file = await http(`/w/photo-wall/fs/file?path=${q(secretFile)}`, {
      method: 'OPTIONS',
      headers
    })
    expect(file.status).toBe(405)
    expect(file.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(file.headers.allow).toBe('GET, HEAD')
    expect(file.headers['access-control-allow-origin']).toBeUndefined()

    const list = await http(`/w/photo-wall/fs/list?path=${q(tmp)}`, { method: 'OPTIONS', headers })
    expect(list.status).toBe(405)
    expect(JSON.parse(list.body.toString()).code).toBe('METHOD_NOT_ALLOWED')
    expect(list.headers.allow).toBe('GET, HEAD')
    expect(list.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('WS-C5 没注册 / id 不合规的文件路由 → 404，没有 ACAO，不出文件', async () => {
    const unregistered = await http(`/w/nope-x/fs/file?path=${q(secretFile)}`)
    expect(unregistered.status).toBe(404)
    expect(unregistered.body.toString()).toBe('Widget nope-x not registered')
    expect(unregistered.headers['access-control-allow-origin']).toBeUndefined()

    const invalid = await http(`/w/NotValid/fs/file?path=${q(secretFile)}`)
    expect(invalid.status).toBe(404)
    expect(invalid.body.toString()).toBe('Not found')
    expect(invalid.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('WS-C6 长得像文件路由的 → 页面或 404，不出秘密文件', async () => {
    for (const path of [
      `/w/photo-wall//fs/file?path=${q(secretFile)}`,
      `/w/photo-wall/FS/file?path=${q(secretFile)}`,
      `/w/photo-wall/%66s/file?path=${q(secretFile)}`
    ]) {
      const res = await http(path)
      if (res.status === 200) {
        expect(res.headers['content-type'], path).toMatch(/^text\/html/)
      } else {
        expect(res.status, path).toBe(404)
      }
      expect(res.body.toString(), path).not.toContain(SECRET)
    }
  })

  it('WS-C7 unregisterWidget 之后文件路由 → 404 not registered', async () => {
    server.unregisterWidget('photo-wall')
    const res = await http(`/w/photo-wall/fs/file?path=${q(secretFile)}`)
    expect(res.status).toBe(404)
    expect(res.body.toString()).toBe('Widget photo-wall not registered')
    expect(res.body.toString()).not.toContain(SECRET)
  })
})

describe('WS-R 文件路由接上了', () => {
  it('WS-R1 fs/file png → 200 image/png 字节一致；Range → 206', async () => {
    const bytes = randomBytes(256)
    const png = join(tmp, 'p.png')
    writeFileSync(png, bytes)
    const res = await http(`/w/photo-wall/fs/file?path=${q(png)}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.body.equals(bytes)).toBe(true)

    const part = await http(`/w/photo-wall/fs/file?path=${q(png)}`, {
      headers: { Range: 'bytes=0-1' }
    })
    expect(part.status).toBe(206)
    expect(part.body.equals(bytes.subarray(0, 2))).toBe(true)
  })

  it('WS-R2 fs/list → 200 JSON，名字对得上', async () => {
    const dir = join(tmp, 'pics')
    mkdirSync(dir)
    writeFileSync(join(dir, 'b.png'), '')
    writeFileSync(join(dir, 'a.png'), '')
    const res = await http(`/w/photo-wall/fs/list?path=${q(dir)}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    const body = JSON.parse(res.body.toString()) as { entries: Array<{ name: string }> }
    expect(body.entries.map((e) => e.name)).toEqual(['a.png', 'b.png'])
  })
})
