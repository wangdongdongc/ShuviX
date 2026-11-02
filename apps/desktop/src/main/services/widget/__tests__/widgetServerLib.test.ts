/**
 * 库文件路由经过真的 `WidgetServer`（`GET|HEAD /w/<id>/lib/<name>@<version>/…`，widgetLibFiles.ts），以及页面骨架里的
 * import map（bundler/widgetLibs.ts widgetImportMap）。与 widgetServer.test.ts 同样的搭法（127.0.0.1 随机端口、打包服务
 * 与数据库换成空壳、请求用 node:http + 显式 Host），区别是 `bundlerResourcePath('vendor')` 指到仓库里拷好的
 * `resources/bundler/vendor`（LS-5 / LS-10 换成临时目录）—— 所以单独一个文件。注册的 widget 是 `abc-def`；
 * http() 自动带它的 ui 令牌（widget 页面经主进程补头的样子），LS-7 另给。
 *
 *   LS-1  GET three.module.js，不带 Accept-Encoding → 200、text/javascript、一年 immutable、Vary、没有 content-encoding；
 *         content-length 与正文 = 文件；带 ACAO *（网页端的沙箱 iframe 是不透明来源，模块脚本要它）
 *   LS-2  Accept-Encoding: gzip, deflate, br → gzip；解开 = 文件；content-length = gzip 长度；再取一次逐字节相同（缓存）
 *   LS-2b `gzip;q=0` 与 `x-gzip` → 不压（F-13 修好之后）
 *   LS-3  HEAD（压与不压）→ 200、与 GET 一样的头（对应那一份的长度）、空正文
 *   LS-4  POST 到有的文件 → 405 `Method not allowed`；到没有的 → 404 `Not found`
 *   LS-5  假 vendor 里的 .mjs / .css → 各自的 content-type
 *   LS-6  纯函数里给 null 的每条路径 → 404 `Not found`（text/plain），正文不带文件内容
 *   LS-7  门：不带 / 空的 / 乱写的令牌 → 403 不出内容；别的 widget 的令牌 → 403；Host 不对 → 421；
 *         preview 令牌（带会话）→ 200 且判定一次都不问；OPTIONS → 204（普通的非文件路由预检，不要令牌）
 *   LS-8  没注册的 widget（带它自己的令牌）→ 404 `Widget … not registered`
 *   LS-9  带查询串 `?v=1` → 200（路由之前剥掉）
 *   LS-10 vendor 目录不存在 → 404，不崩、不 500
 *   LS-11 GET basis_transcoder.wasm → 200、application/wasm、一年 immutable、Vary、ACAO *，正文 = 文件
 *   LS-12 Accept-Encoding: gzip → 解开 = 文件、类型还是 application/wasm；HEAD → 同样的头、空正文
 *   LS-13 不带令牌 → 403 不出字节；preview 令牌 → 200，判定一次都不问
 *   IM-1  页面里恰好一段 `<script type="importmap">`，JSON = widgetImportMap('/w/abc-def/')
 *   IM-2  顺序：主题脚本仍是第一个 <script、就绪脚本在 bundle 之前；import map 在 <base> 之后、第一个模块脚本之前，
 *         之前没有 modulepreload；带 ?shuvix-scheme=dark 也一样
 *   IM-3  map 里的每个地址（three、three/addons/ + controls/OrbitControls.js）带令牌取 → 200
 *   IM-3b 按 three 的地址解析 `./three.core.js` 再取 → 200（F-1 修好之后）
 *   IM-4  构建失败页照旧（WS-RD2 管细节；这里只看它还出得来）
 *   IM-5  按 map 的 three/addons/ 取 libs/draco/ 的 draco_decoder.wasm、draco_wasm_wrapper.js 与 libs/basis/basis_transcoder.js
 *         → 200，类型各自对
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const RESOURCES = join(DESKTOP_DIR, 'resources/bundler')
const REAL_VENDOR = join(RESOURCES, 'vendor')

const mocks = vi.hoisted(() => ({
  build: vi.fn(async () => ({ success: true, outputJS: 'js', outputCSS: 'css' })),
  handleRestRequest: vi.fn(async () => ({ rows: [] as unknown[] })),
  tmp: '',
  vendor: ''
}))

vi.mock('../../bundler', () => ({
  bundlerService: { build: mocks.build },
  bundlerResourcePath: (p: string) => (p === 'vendor' ? mocks.vendor : join(RESOURCES, p))
}))
vi.mock('../widgetDb', () => ({
  handleRestRequest: mocks.handleRestRequest,
  WidgetDbError: class WidgetDbError extends Error {}
}))
vi.mock('../../../utils/paths', () => ({
  getWidgetsDataDir: () => join(mocks.tmp, 'widgets-data')
}))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { setWidgetPreviewJudge, WidgetServer } from '../widgetServer'
import { issueWidgetToken, WIDGET_TOKEN_HEADER } from '../widgetToken'
import { setWidgetThemeReader, themeBootScript, type WidgetThemeState } from '../widgetTheme'
import { widgetReadyScript } from '../../../../shared/widgetReady'
import { widgetImportMap } from '../../bundler/widgetLibs'

const ID = 'abc-def'
const LIB = `/w/${ID}/lib/three@0.187.0`
const MODULE_URL = `${LIB}/build/three.module.js`
const MODULE_FILE = join(REAL_VENDOR, 'node_modules/three/build/three.module.js')

let tmp: string
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
    /** 缺省 = 路径里那个 widget 的 ui 令牌；null = 不带；字符串 = 带这个 */
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
    req.end()
  })
}

function requireVendor(): void {
  if (!statSync(join(REAL_VENDOR, 'manifest.json'), { throwIfNoEntry: false })) {
    throw new Error(`${REAL_VENDOR}/manifest.json is missing: run npm install`)
  }
}

/** 文件里一段一眼认得出的内容（404 的正文里不该出现） */
const MODULE_SNIPPET = (): string => readFileSync(MODULE_FILE, 'utf8').slice(0, 200)

beforeEach(async () => {
  mocks.build.mockClear()
  mocks.handleRestRequest.mockClear()
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-server-lib-'))
  mocks.tmp = tmp
  mocks.vendor = REAL_VENDOR
  writeFileSync(join(tmp, 'index.tsx'), 'export {}')
  server = new WidgetServer()
  await server.registerAndBuild(ID, tmp, 'index.tsx')
  port = server.getStatus().port
})

afterEach(() => {
  server.dispose()
  setWidgetPreviewJudge(null)
  setWidgetThemeReader(null)
  rmSync(tmp, { recursive: true, force: true })
})

describe('LS 库文件路由（真的 WidgetServer）', () => {
  it('LS-1 GET three.module.js，不压 → 200 与该有的头，正文 = 文件', async () => {
    requireVendor()
    const res = await http(MODULE_URL)
    const file = readFileSync(MODULE_FILE)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(res.headers.vary).toBe('Accept-Encoding')
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['content-length']).toBe(String(file.length))
    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.body.equals(file)).toBe(true)
  })

  it('LS-2 Accept-Encoding: gzip, deflate, br → gzip；解开 = 文件；第二次逐字节相同', async () => {
    requireVendor()
    const headers = { 'accept-encoding': 'gzip, deflate, br' }
    const res = await http(MODULE_URL, { headers })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(res.headers.vary).toBe('Accept-Encoding')
    expect(res.headers['content-length']).toBe(String(res.body.length))
    const file = readFileSync(MODULE_FILE)
    expect(res.body.length).toBeLessThan(file.length)
    expect(gunzipSync(res.body).equals(file)).toBe(true)

    const again = await http(MODULE_URL, { headers })
    expect(again.body.equals(res.body)).toBe(true)
  })

  it.each(['gzip;q=0', 'x-gzip'])('LS-2b Accept-Encoding: %s → 不压（F-13）', async (value) => {
    requireVendor()
    const res = await http(MODULE_URL, { headers: { 'accept-encoding': value } })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body.equals(readFileSync(MODULE_FILE))).toBe(true)
  })

  it.each<[string, Record<string, string>]>([
    ['不压', {}],
    ['gzip', { 'accept-encoding': 'gzip' }]
  ])('LS-3 HEAD（%s）→ 200、与 GET 一样的头、空正文', async (_what, headers) => {
    requireVendor()
    const get = await http(MODULE_URL, { headers })
    const head = await http(MODULE_URL, { headers, method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body.length).toBe(0)
    for (const name of [
      'content-type',
      'content-length',
      'cache-control',
      'vary',
      'content-encoding',
      'access-control-allow-origin'
    ]) {
      expect(head.headers[name], name).toEqual(get.headers[name])
    }
    expect(head.headers['content-length']).toBe(String(get.body.length))
  })

  it('LS-4 POST 到有的文件 → 405；到没有的 → 404', async () => {
    requireVendor()
    const valid = await http(MODULE_URL, { method: 'POST' })
    expect(valid.status).toBe(405)
    expect(valid.body.toString()).toBe('Method not allowed')
    const missing = await http(`${LIB}/build/nope.js`, { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(missing.body.toString()).toBe('Not found')
  })

  it('LS-5 假 vendor 里的 .mjs / .css → 各自的 content-type', async () => {
    const vendor = join(tmp, 'vendor')
    const put = (rel: string, content: string): void => {
      const full = join(vendor, 'node_modules/three/examples/jsm', rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    put('m.mjs', 'export const m = 1')
    put('s.css', '.x{color:red}')
    mocks.vendor = vendor

    const mjs = await http(`${LIB}/examples/jsm/m.mjs`)
    expect(mjs.status).toBe(200)
    expect(mjs.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(mjs.body.toString()).toBe('export const m = 1')
    const css = await http(`${LIB}/examples/jsm/s.css`)
    expect(css.status).toBe(200)
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(css.body.toString()).toBe('.x{color:red}')
  })

  it.each([
    '/lib/three@0.186.0/build/three.module.js',
    '/lib/three@0.187.0-beta/build/three.module.js',
    '/lib/three@/build/three.module.js',
    '/lib/three@0.187.0/',
    '/lib/three/build/three.module.js',
    '/lib/chart.js@4.6.1/dist/chart.js',
    '/lib/lucide-react@0.564.0/dist/esm/lucide-react.js',
    '/lib/left-pad@1.0.0/index.js',
    '/lib/Three@0.187.0/build/three.module.js',
    '/lib/@scope/pkg@1/x.js',
    '/lib/three@0.187.0/examples/jsm/../../package.json',
    '/lib/three@0.187.0/examples/jsm/./controls/OrbitControls.js',
    '/lib/three@0.187.0/examples/jsm//controls/OrbitControls.js',
    '/lib/three@0.187.0/examples\\jsm\\controls\\OrbitControls.js',
    '/lib/three@0.187.0/examples/jsm/%2e%2e/%2e%2e/package.json',
    '/lib/three@0.187.0/build/../build/three.module.js',
    '/lib/three@0.187.0/package.json',
    '/lib/three@0.187.0/LICENSE',
    '/lib/three@0.187.0/build/three.module.js/'
  ])('LS-6 %s → 404 Not found（text/plain），不出内容', async (rest) => {
    requireVendor()
    const res = await http(`/w/${ID}${rest}`)
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toBe('text/plain')
    expect(res.body.toString()).toBe('Not found')
  })

  it('LS-7 门：没有 / 空 / 乱写 / 别人的令牌 → 403；Host 不对 → 421；不出内容', async () => {
    requireVendor()
    const snippet = MODULE_SNIPPET()
    for (const token of [null, '', 'garbage.token', issueWidgetToken('other-widget', 'ui')]) {
      const res = await http(MODULE_URL, { token })
      expect(res.status, String(token)).toBe(403)
      expect(res.body.toString(), String(token)).not.toContain(snippet)
    }
    const wrongHost = await http(MODULE_URL, { host: `evil.example:${port}` })
    expect(wrongHost.status).toBe(421)
    expect(wrongHost.body.toString()).not.toContain(snippet)
  })

  it('LS-7 preview 令牌（带会话）→ 200，判定一次都不问', async () => {
    requireVendor()
    const judge = { widget: vi.fn(() => false), readPath: vi.fn(() => false) }
    setWidgetPreviewJudge(judge)
    const res = await http(MODULE_URL, { token: issueWidgetToken(ID, 'preview', 's1') })
    expect(res.status).toBe(200)
    expect(res.body.equals(readFileSync(MODULE_FILE))).toBe(true)
    expect(judge.widget).not.toHaveBeenCalled()
    expect(judge.readPath).not.toHaveBeenCalled()
  })

  it('LS-7 OPTIONS → 204（普通的预检，不要令牌）', async () => {
    const res = await http(MODULE_URL, {
      method: 'OPTIONS',
      token: null,
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' }
    })
    expect(res.status).toBe(204)
    expect(res.body.length).toBe(0)
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('LS-8 没注册的 widget（带它自己的令牌）→ 404 not registered', async () => {
    requireVendor()
    const res = await http('/w/xyz-abc/lib/three@0.187.0/build/three.module.js')
    expect(res.status).toBe(404)
    expect(res.body.toString()).toBe('Widget xyz-abc not registered')
  })

  it('LS-9 带查询串 → 200', async () => {
    requireVendor()
    const res = await http(`${MODULE_URL}?v=1`)
    expect(res.status).toBe(200)
    expect(res.body.equals(readFileSync(MODULE_FILE))).toBe(true)
  })

  describe('LS-11..13 解码器的 .wasm', () => {
    const WASM_URL = `${LIB}/examples/jsm/libs/basis/basis_transcoder.wasm`
    const WASM_FILE = join(
      REAL_VENDOR,
      'node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm'
    )

    it('LS-11 GET .wasm → 200、application/wasm、长缓存、Vary、ACAO *，正文 = 文件', async () => {
      requireVendor()
      const res = await http(WASM_URL)
      const file = readFileSync(WASM_FILE)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('application/wasm')
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(res.headers.vary).toBe('Accept-Encoding')
      expect(res.headers['access-control-allow-origin']).toBe('*')
      expect(res.headers['content-length']).toBe(String(file.length))
      expect(res.body.equals(file)).toBe(true)
    })

    it('LS-12 gzip：解开 = 文件，类型不变；HEAD → 同样的头、空正文', async () => {
      requireVendor()
      const headers = { 'accept-encoding': 'gzip' }
      const res = await http(WASM_URL, { headers })
      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBe('gzip')
      expect(res.headers['content-type']).toBe('application/wasm')
      expect(gunzipSync(res.body).equals(readFileSync(WASM_FILE))).toBe(true)

      const head = await http(WASM_URL, { headers, method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.body.length).toBe(0)
      for (const name of ['content-type', 'content-length', 'cache-control', 'content-encoding']) {
        expect(head.headers[name], name).toEqual(res.headers[name])
      }
    })

    it('LS-13 不带令牌 → 403 不出字节；preview 令牌 → 200，判定不问', async () => {
      requireVendor()
      const denied = await http(WASM_URL, { token: null })
      expect(denied.status).toBe(403)
      expect(denied.body.includes(readFileSync(WASM_FILE).subarray(0, 64))).toBe(false)

      const judge = { widget: vi.fn(() => false), readPath: vi.fn(() => false) }
      setWidgetPreviewJudge(judge)
      const res = await http(WASM_URL, { token: issueWidgetToken(ID, 'preview', 's1') })
      expect(res.status).toBe(200)
      expect(res.body.equals(readFileSync(WASM_FILE))).toBe(true)
      expect(judge.widget).not.toHaveBeenCalled()
      expect(judge.readPath).not.toHaveBeenCalled()
    })
  })

  it('LS-10 vendor 目录不存在 → 404，不崩', async () => {
    mocks.vendor = join(tmp, 'no-vendor-here')
    const res = await http(MODULE_URL)
    expect(res.status).toBe(404)
    expect(res.body.toString()).toBe('Not found')
    // 服务器还活着
    const again = await http(`/w/${ID}/bundle.js`)
    expect(again.status).toBe(200)
  })
})

describe('IM 页面骨架里的 import map', () => {
  const SYSTEM: WidgetThemeState = { mode: 'system', light: 'one-light', dark: 'nord' }
  const OPEN = '<script type="importmap">'
  const BUNDLE_TAG = '<script type="module" src="bundle.js"></script>'
  const occurrences = (text: string, part: string): number => text.split(part).length - 1

  async function page(query = ''): Promise<string> {
    setWidgetThemeReader(() => SYSTEM)
    const res = await http(`/w/${ID}/${query}`)
    expect(res.status).toBe(200)
    return res.body.toString()
  }

  function importMapOf(html: string): unknown {
    const start = html.indexOf(OPEN)
    const end = html.indexOf('</script>', start)
    return JSON.parse(html.slice(start + OPEN.length, end))
  }

  it('IM-1 恰好一段 import map，JSON = widgetImportMap("/w/abc-def/")', async () => {
    const html = await page()
    expect(occurrences(html, OPEN)).toBe(1)
    expect(occurrences(html, 'type="importmap"')).toBe(1)
    expect(importMapOf(html)).toEqual(widgetImportMap(`/w/${ID}/`))
  })

  it.each<[string, 'dark' | null]>([
    ['', null],
    ['?shuvix-scheme=dark', 'dark']
  ])('IM-2 页面 %j 的顺序', async (query, forced) => {
    const html = await page(query)
    const themeTag = `<script>${themeBootScript(SYSTEM, forced)}</script>`
    const at = {
      theme: html.indexOf(themeTag),
      ready: html.indexOf(`<script>${widgetReadyScript()}</script>`),
      base: html.indexOf(`<base href="/w/${ID}/" />`),
      map: html.indexOf(OPEN),
      firstModule: html.indexOf('<script type="module"'),
      bundle: html.indexOf(BUNDLE_TAG)
    }
    for (const [what, i] of Object.entries(at)) expect(i, what).toBeGreaterThan(-1)
    expect(html.indexOf('<script')).toBe(at.theme)
    expect(at.ready).toBeLessThan(at.bundle)
    expect(at.base).toBeLessThan(at.map)
    expect(at.map).toBeLessThan(at.firstModule)
    expect(at.firstModule).toBe(at.bundle)
    expect(html.slice(0, at.map)).not.toContain('modulepreload')
    expect(importMapOf(html)).toEqual(widgetImportMap(`/w/${ID}/`))
  })

  it('IM-3 map 里的每个地址带令牌取 → 200', async () => {
    requireVendor()
    const { imports } = importMapOf(await page()) as { imports: Record<string, string> }
    const urls = [imports.three, `${imports['three/addons/']}controls/OrbitControls.js`]
    for (const url of urls) {
      const res = await http(url)
      expect(res.status, url).toBe(200)
      expect(res.headers['content-type'], url).toBe('text/javascript; charset=utf-8')
    }
  })

  it('IM-3b 按 three 的地址解析 ./three.core.js 再取 → 200（F-1）', async () => {
    requireVendor()
    const { imports } = importMapOf(await page()) as { imports: Record<string, string> }
    // three.module.js 确实相对 import 它
    expect(readFileSync(MODULE_FILE, 'utf8')).toMatch(/from\s*["']\.\/three\.core\.js["']/)
    const core = new URL('./three.core.js', `http://127.0.0.1:${port}${imports.three}`).pathname
    expect(core).toBe(`${LIB}/build/three.core.js`)
    const res = await http(core)
    expect(res.status).toBe(200)
    expect(
      res.body.equals(readFileSync(join(REAL_VENDOR, 'node_modules/three/build/three.core.js')))
    ).toBe(true)
  })

  it.each([
    ['libs/draco/draco_decoder.wasm', 'application/wasm'],
    ['libs/draco/draco_wasm_wrapper.js', 'text/javascript; charset=utf-8'],
    ['libs/basis/basis_transcoder.js', 'text/javascript; charset=utf-8']
  ])('IM-5 经 map 的 three/addons/ 取 %s → 200，类型对', async (file, type) => {
    requireVendor()
    const { imports } = importMapOf(await page()) as { imports: Record<string, string> }
    const res = await http(`${imports['three/addons/']}${file}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe(type)
    expect(
      res.body.equals(readFileSync(join(REAL_VENDOR, 'node_modules/three/examples/jsm', file)))
    ).toBe(true)
  })

  it('IM-4 构建失败页照旧出得来', async () => {
    mocks.build.mockImplementationOnce((async () => ({
      success: false,
      errors: ['boom']
    })) as never)
    await server.rebuild(ID)
    const res = await http(`/w/${ID}/`)
    expect(res.status).toBe(200)
    expect(res.body.toString()).toContain('Build Error')
    expect(res.body.toString()).toContain('boom')
  })
})
