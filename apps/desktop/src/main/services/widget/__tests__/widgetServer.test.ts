/**
 * `services/widget/widgetServer.ts` —— widget 服务的门（Host、文件路由不带 CORS 头、每个路由要那个 widget 的令牌）与文件路由的接线。
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
 *   WS-K1 每个路由（页面、bundle、tailwind、sse、db、fs/file、fs/list）不带令牌 / 带空的 / 带乱写的 → 403，
 *         正文里没有文件内容与数据（沙箱里的命令 curl 过来就是这样）；db 与 fs/list 的 403 是 JSON { code, message }；
 *         Host 不对的照旧先 421
 *   WS-K2 别的 widget 的令牌 → 403（A 的令牌用不了 B 的任何路由）
 *   WS-K4 没注册的 widget：不带令牌 → 403（不带令牌的人问不出有哪些 widget）；带它的令牌 → 404 not registered
 *   WS-K5 预检 OPTIONS 不要令牌（它什么也不返回）
 *   WT4-PV-04 签名有效、范围是旧的 `cli` 的令牌 → 页面、bundle、api、db、fs/file、fs/list 一律 403，不出文件、不调数据库
 *   WT4-PV-05 preview 令牌（会话 s1）+ 判定放行读 → fs/file（绝对路径、`~/x` 展开成家目录）、fs/list 照常；判定拿到的是
 *         (s1, 展开归一后的绝对路径)
 *   WT4-PV-06 判定不放行 / 没注入判定 → fs/file 403 纯文本、fs/list 403 JSON FORBIDDEN（都点名那个路径、不出内容）；
 *         preview 令牌不带会话 → 403，判定一次都不问
 *   WT4-PV-07 preview 令牌 + 没有 path / 相对路径 / 带 \0 → 400（与 ui 一样），判定不问
 *   WT4-PV-08 preview 令牌打老组件的 db/：GET 问 read、别的方法（含 HEAD）问 write；不放行 → 403 JSON FORBIDDEN，
 *         数据库不调；放行 → 照常处理；ui 令牌从不问判定
 *   WT4-PV-09 preview 令牌拿页面、bundle、sse → 照常，不问判定
 *
 * 除 WS-K 外，http() 自动给 `/w/<id>/…` 带上那个 widget 的 ui 令牌（widget 页面经主进程补头的样子）。
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
  handleRestRequest: vi.fn(async () => ({ rows: [] as unknown[] })),
  tmp: ''
}))

vi.mock('../../bundler', () => ({
  bundlerService: { build: mocks.build },
  bundlerResourcePath: (p: string) => p
}))
vi.mock('../widgetDb', () => ({
  handleRestRequest: mocks.handleRestRequest,
  WidgetDbError: class WidgetDbError extends Error {}
}))
// 组件 API（api/widgetApi.ts）按数据目录判存储归属：指到每条用例的临时目录里（不存在 = 老组件，`/db` 照旧），不碰真家目录
vi.mock('../../../utils/paths', () => ({
  getWidgetsDataDir: () => join(mocks.tmp, 'widgets-data')
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { setWidgetPreviewJudge, WidgetServer } from '../widgetServer'
import { issueWidgetToken, WIDGET_TOKEN_HEADER } from '../widgetToken'

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
  options: {
    method?: string
    host?: string
    headers?: Record<string, string>
    body?: string
    /** 令牌：缺省 = 路径里那个 widget 的 ui 令牌；null = 不带；字符串 = 带这个 */
    token?: string | null
  } = {}
): Promise<HttpResult> {
  const widgetId = path.split('?')[0].match(/^\/w\/([^/]+)/)?.[1]
  const token =
    options.token === undefined
      ? widgetId
        ? issueWidgetToken(widgetId, 'ui')
        : null
      : options.token
  const key = token === null ? {} : { [WIDGET_TOKEN_HEADER]: token }
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        headers: { host: options.host ?? `127.0.0.1:${port}`, ...key, ...options.headers },
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
  mocks.tmp = tmp
  secretFile = join(tmp, 'secret.txt')
  writeFileSync(secretFile, SECRET)
  writeFileSync(join(tmp, 'index.tsx'), 'export {}')
  server = new WidgetServer()
  await server.registerAndBuild('photo-wall', tmp, 'index.tsx')
  port = server.getStatus().port
})

afterEach(() => {
  server.dispose()
  setWidgetPreviewJudge(null)
  vi.unstubAllEnvs()
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

describe('WS-K 每个路由要那个 widget 的令牌', () => {
  const ROUTES = (): string[] => [
    '/w/photo-wall/',
    '/w/photo-wall/bundle.js',
    '/w/photo-wall/bundle.css',
    '/w/photo-wall/tailwind.js',
    '/w/photo-wall/db/items',
    `/w/photo-wall/fs/file?path=${q(secretFile)}`,
    `/w/photo-wall/fs/list?path=${q(tmp)}`
  ]
  const forbidden = (res: HttpResult, path: string): void => {
    expect(res.status, path).toBe(403)
    const text = res.body.toString()
    expect(text, path).not.toContain(SECRET)
    expect(text, path).not.toContain('secret.txt')
    if (path.includes('/db/') || path.includes('/fs/list')) {
      expect(JSON.parse(text).code, path).toBe('FORBIDDEN')
    }
  }

  it('WS-K1 不带 / 带空的 / 带乱写的令牌 → 403；Host 不对的先 421', async () => {
    for (const path of ROUTES()) {
      for (const token of [null, '', 'garbage', 'a.b.c']) {
        forbidden(await http(path, { token }), `${path} ${token}`)
      }
    }
    // sse 是一条不结束的流：没令牌直接 403，不挂上去
    forbidden(await http('/w/photo-wall/sse', { token: null }), '/w/photo-wall/sse')
    expect(mocks.handleRestRequest).not.toHaveBeenCalled()

    const misdirected = await http(ROUTES()[5], { token: null, host: 'evil.example' })
    expect(misdirected.status).toBe(421)
  })

  it('WS-K2 别的 widget 的令牌 → 403', async () => {
    const other = issueWidgetToken('other-widget', 'ui')
    for (const path of ROUTES()) forbidden(await http(path, { token: other }), path)
  })

  it('WS-K4 没注册的 widget：不带令牌 403，带它的令牌 404', async () => {
    expect((await http('/w/nope-x/', { token: null })).status).toBe(403)
    const withToken = await http('/w/nope-x/')
    expect(withToken.status).toBe(404)
    expect(withToken.body.toString()).toBe('Widget nope-x not registered')
  })

  it('WS-K5 预检 OPTIONS 不要令牌', async () => {
    const res = await http('/w/photo-wall/db/items', {
      method: 'OPTIONS',
      token: null,
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' }
    })
    expect(res.status).toBe(204)
    expect(res.body.length).toBe(0)
  })
})

describe('WT4-PV 预览令牌（按发起预览的会话判）', () => {
  const ID = 'photo-wall'
  const preview = (sid?: string): string => issueWidgetToken(ID, 'preview', sid)
  /** 判定：两样都是间谍，缺省都不放行 */
  const judge = (
    opts: { readPath?: boolean; widget?: (access: 'read' | 'write') => boolean } = {}
  ): {
    widget: ReturnType<typeof vi.fn>
    readPath: ReturnType<typeof vi.fn>
  } => {
    const j = {
      widget: vi.fn(
        (_sid: string, access: 'read' | 'write', _id: string, _op: string) =>
          opts.widget?.(access) ?? false
      ),
      readPath: vi.fn((_sid: string, _path: string) => opts.readPath ?? false)
    }
    setWidgetPreviewJudge(j)
    return j
  }

  it('WT4-PV-04 旧的 cli 令牌（签名有效）→ 每个路由 403，不出文件、不调数据库', async () => {
    const cli = issueWidgetToken(ID, 'cli' as never)
    const routes: Array<{ path: string; method?: string; body?: string }> = [
      { path: `/w/${ID}/` },
      { path: `/w/${ID}/bundle.js` },
      { path: `/w/${ID}/api/x`, method: 'POST', body: '{}' },
      { path: `/w/${ID}/db/items` },
      { path: `/w/${ID}/fs/file?path=${q(secretFile)}` },
      { path: `/w/${ID}/fs/list?path=${q(tmp)}` }
    ]
    for (const route of routes) {
      const res = await http(route.path, {
        token: cli,
        method: route.method,
        body: route.body,
        headers: route.body ? { 'content-type': 'application/json' } : {}
      })
      expect(res.status, route.path).toBe(403)
      const text = res.body.toString()
      expect(text, route.path).not.toContain(SECRET)
      expect(text, route.path).not.toContain('secret.txt')
      expect(text, route.path).not.toBe('js')
    }
    expect(mocks.handleRestRequest).not.toHaveBeenCalled()
  })

  it('WT4-PV-05 判定放行读 → fs/file、`~/x`、fs/list 照常；判定拿到 (会话, 展开后的绝对路径)', async () => {
    const j = judge({ readPath: true })
    vi.stubEnv('HOME', tmp)
    writeFileSync(join(tmp, 'x'), 'home-file')

    const file = await http(`/w/${ID}/fs/file?path=${q(secretFile)}`, { token: preview('s1') })
    expect(file.status).toBe(200)
    expect(file.body.toString()).toBe(SECRET)

    const home = await http(`/w/${ID}/fs/file?path=${q('~/x')}`, { token: preview('s1') })
    expect(home.status).toBe(200)
    expect(home.body.toString()).toBe('home-file')

    const list = await http(`/w/${ID}/fs/list?path=${q(tmp)}`, { token: preview('s1') })
    expect(list.status).toBe(200)
    const names = (
      JSON.parse(list.body.toString()) as { entries: Array<{ name: string }> }
    ).entries.map((e) => e.name)
    expect(names).toContain('secret.txt')

    expect(j.readPath.mock.calls).toEqual([
      ['s1', secretFile],
      ['s1', join(tmp, 'x')],
      ['s1', tmp]
    ])
    expect(j.widget).not.toHaveBeenCalled()
  })

  it('WT4-PV-06 判定不放行 → fs/file 403 纯文本、fs/list 403 JSON，都点名路径、不出内容', async () => {
    const j = judge({ readPath: false })
    const file = await http(`/w/${ID}/fs/file?path=${q(secretFile)}`, { token: preview('s1') })
    expect(file.status).toBe(403)
    expect(file.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(file.body.toString()).toBe(
      `This preview's session may not read ${secretFile} without asking.`
    )

    const list = await http(`/w/${ID}/fs/list?path=${q(tmp)}`, { token: preview('s1') })
    expect(list.status).toBe(403)
    expect(JSON.parse(list.body.toString())).toEqual({
      code: 'FORBIDDEN',
      message: `This preview's session may not read ${tmp} without asking.`
    })
    expect(list.body.toString()).not.toContain('secret.txt')
    expect(j.readPath.mock.calls).toEqual([
      ['s1', secretFile],
      ['s1', tmp]
    ])
  })

  it('WT4-PV-06 没注入判定 → 一样 403', async () => {
    setWidgetPreviewJudge(null)
    const file = await http(`/w/${ID}/fs/file?path=${q(secretFile)}`, { token: preview('s1') })
    expect(file.status).toBe(403)
    expect(file.body.toString()).not.toContain(SECRET)
    const list = await http(`/w/${ID}/fs/list?path=${q(tmp)}`, { token: preview('s1') })
    expect(list.status).toBe(403)
    expect(JSON.parse(list.body.toString()).code).toBe('FORBIDDEN')
  })

  it('WT4-PV-06 preview 令牌不带会话 → 403，判定一次都不问', async () => {
    const j = judge({ readPath: true, widget: () => true })
    for (const token of [preview(), preview('')]) {
      const file = await http(`/w/${ID}/fs/file?path=${q(secretFile)}`, { token })
      expect(file.status).toBe(403)
      expect(file.body.toString()).not.toContain(SECRET)
      const list = await http(`/w/${ID}/fs/list?path=${q(tmp)}`, { token })
      expect(list.status).toBe(403)
    }
    expect(j.readPath).not.toHaveBeenCalled()
  })

  it.each([
    ['没有 path', ''],
    ['相对路径', '?path=rel/x.txt'],
    ['带 \\0', `?path=${q(`${tmp}/a\0b`)}`]
  ])('WT4-PV-07 %s → 400（与 ui 一样），判定不问', async (_label, query) => {
    const j = judge({ readPath: true })
    for (const route of ['fs/file', 'fs/list']) {
      const path = `/w/${ID}/${route}${query}`
      const asPreview = await http(path, { token: preview('s1') })
      const asUi = await http(path)
      expect(asPreview.status, path).toBe(400)
      expect(asPreview.status, path).toBe(asUi.status)
      expect(asPreview.body.toString(), path).toBe(asUi.body.toString())
    }
    expect(j.readPath).not.toHaveBeenCalled()
  })

  it('WT4-PV-08 老组件的 db/：GET 问 read、别的方法问 write；不放行 → 403 JSON，数据库不调', async () => {
    const j = judge({ widget: () => false })
    const methods: Array<[string, 'read' | 'write']> = [
      ['GET', 'read'],
      ['POST', 'write'],
      ['PATCH', 'write'],
      ['DELETE', 'write'],
      ['HEAD', 'write']
    ]
    for (const [method, access] of methods) {
      j.widget.mockClear()
      const res = await http(`/w/${ID}/db/items`, {
        token: preview('s1'),
        method,
        body: method === 'POST' || method === 'PATCH' ? '{"a":1}' : undefined,
        headers: { 'content-type': 'application/json' }
      })
      expect(res.status, method).toBe(403)
      expect(j.widget.mock.calls, method).toEqual([['s1', access, ID, 'db/items']])
      if (method !== 'HEAD') {
        expect(JSON.parse(res.body.toString()), method).toEqual({
          code: 'FORBIDDEN',
          message: `This preview's session may not ${access === 'read' ? 'read' : 'change'} this widget's data.`
        })
      }
    }
    expect(mocks.handleRestRequest).not.toHaveBeenCalled()
  })

  it('WT4-PV-08 放行 → 照常处理（HEAD 由数据库路由回 405）', async () => {
    const j = judge({ widget: () => true })
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const res = await http(`/w/${ID}/db/items`, {
        token: preview('s1'),
        method,
        body: method === 'POST' || method === 'PATCH' ? '{"a":1}' : undefined,
        headers: { 'content-type': 'application/json' }
      })
      expect(res.status, method).toBe(200)
    }
    expect(mocks.handleRestRequest).toHaveBeenCalledTimes(4)
    const head = await http(`/w/${ID}/db/items`, { token: preview('s1'), method: 'HEAD' })
    expect(head.status).toBe(405)
    expect(mocks.handleRestRequest).toHaveBeenCalledTimes(4)
    expect(j.widget.mock.calls.map((c) => c[1])).toEqual([
      'read',
      'write',
      'write',
      'write',
      'write'
    ])
  })

  it('WT4-PV-08 ui 令牌从不问判定', async () => {
    const j = judge({ widget: () => false, readPath: false })
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await http(`/w/${ID}/db/items`, {
        method,
        body: method === 'POST' ? '{"a":1}' : undefined,
        headers: { 'content-type': 'application/json' }
      })
      expect(res.status, method).toBe(200)
    }
    expect((await http(`/w/${ID}/fs/file?path=${q(secretFile)}`)).status).toBe(200)
    expect(j.widget).not.toHaveBeenCalled()
    expect(j.readPath).not.toHaveBeenCalled()
  })

  it('WT4-PV-09 preview 令牌拿页面、bundle、sse → 照常，不问判定', async () => {
    const j = judge()
    const page = await http(`/w/${ID}/`, { token: preview('s1') })
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toMatch(/^text\/html/)
    const bundle = await http(`/w/${ID}/bundle.js`, { token: preview('s1') })
    expect(bundle.status).toBe(200)
    expect(bundle.body.toString()).toBe('js')

    // sse 是不结束的流：拿到响应头就断开
    const sse = await new Promise<{ status: number; type: string | undefined }>((done, fail) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: `/w/${ID}/sse`,
          headers: { host: `127.0.0.1:${port}`, [WIDGET_TOKEN_HEADER]: preview('s1') },
          agent: false
        },
        (res) => {
          done({ status: res.statusCode ?? 0, type: res.headers['content-type'] })
          req.destroy()
        }
      )
      req.on('error', () => {})
      req.once('error', fail)
      req.end()
    })
    expect(sse).toEqual({ status: 200, type: 'text/event-stream' })
    expect(j.widget).not.toHaveBeenCalled()
    expect(j.readPath).not.toHaveBeenCalled()
  })
})
