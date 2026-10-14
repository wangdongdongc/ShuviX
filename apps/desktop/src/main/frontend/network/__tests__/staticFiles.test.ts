/**
 * `frontend/network/staticFiles.ts` —— 静态路由的纯路径解析与 MIME 表（server mode phase B/C）：`/` 与 `/web.html` 是入口，
 * 其余是渲染端产物目录下的文件（不出目录、不给隐藏文件、不给桌面入口 index.html），GET / HEAD 之外 405。不碰磁盘。
 *
 *   SF-1 入口：GET `/`、空、缺失、带查询、`/web.html` 带 hash / 查询；HEAD `/`
 *   SF-2 method-not-allowed：POST、OPTIONS、缺失、小写 get
 *   SF-3 资源：`/assets/app.js`；`/a/./b.js` 归一；`%2e` 段解码后归一
 *   SF-4 not-found：index.html（各种写法）、出目录（含编码的 `..` 与 `/`）、隐藏文件 / 目录、末尾斜杠；
 *        子目录里的 index.html 照给
 *   SF-5 bad-request：编码的反斜杠、NUL、坏转义、绝对形式、`*`
 *   SF-6 `/assets`（不带斜杠）→ file（由服务端 stat 判成 404，见 NS-4）
 *   SF-7 mimeTypeOf：常见扩展名（不分大小写）；不认识 / 没有扩展名 → application/octet-stream
 *   SF-8 index.html 不分大小写地拒掉：`/INDEX.HTML`、`/Index.html` → not-found
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mimeTypeOf, resolveStaticRequest } from '../staticFiles'

const root = resolve('/srv/r')
const ENTRY = { kind: 'file', path: resolve(root, 'web.html'), entry: true }
const get = (url: string | undefined): ReturnType<typeof resolveStaticRequest> =>
  resolveStaticRequest('GET', url, root)

describe('SF-1 入口', () => {
  it.each(['/', '', '/?x=1', '/web.html#a', '/web.html?v=2', '/web.html'])('SF-1 GET %j', (url) => {
    expect(get(url)).toStrictEqual(ENTRY)
  })

  it('SF-1 GET 缺失的 URL；HEAD /', () => {
    expect(get(undefined)).toStrictEqual(ENTRY)
    expect(resolveStaticRequest('HEAD', '/', root)).toStrictEqual(ENTRY)
  })
})

describe('SF-2 method-not-allowed', () => {
  it.each(['POST', 'OPTIONS', undefined, 'get'])('SF-2 %s', (method) => {
    expect(resolveStaticRequest(method, '/', root)).toStrictEqual({ kind: 'method-not-allowed' })
  })
})

describe('SF-3 资源', () => {
  it('SF-3 /assets/app.js；/a/./b.js；/assets/%2e/app.js', () => {
    expect(get('/assets/app.js')).toStrictEqual({
      kind: 'file',
      path: resolve(root, 'assets/app.js'),
      entry: false
    })
    expect(get('/a/./b.js')).toStrictEqual({
      kind: 'file',
      path: resolve(root, 'a/b.js'),
      entry: false
    })
    expect(get('/assets/%2e/app.js')).toStrictEqual({
      kind: 'file',
      path: resolve(root, 'assets/app.js'),
      entry: false
    })
  })
})

describe('SF-4 not-found', () => {
  it.each([
    '/index.html',
    '/./index.html',
    '/assets/../index.html',
    '/../etc/passwd',
    '/assets/../../x',
    '/%2e%2e/x',
    '/%2E%2E%2Fx',
    '/..%2fx',
    '/.env',
    '/assets/.hidden',
    '/.git/config',
    '/assets/',
    '/web.html/'
  ])('SF-4 %s', (url) => {
    expect(get(url)).toStrictEqual({ kind: 'not-found' })
  })

  it('SF-4 只拒顶层的 index.html：/sub/index.html 照给', () => {
    expect(get('/sub/index.html')).toStrictEqual({
      kind: 'file',
      path: resolve(root, 'sub/index.html'),
      entry: false
    })
  })
})

describe('SF-5 bad-request', () => {
  it.each(['/%5c..%5cx', '/a%00b', '/%E0%A4%A', 'http://h/x', '*'])('SF-5 %s', (url) => {
    expect(get(url)).toStrictEqual({ kind: 'bad-request' })
  })
})

describe('SF-6 不带斜杠的目录名', () => {
  it('SF-6 /assets → file（entry:false）', () => {
    expect(get('/assets')).toStrictEqual({
      kind: 'file',
      path: resolve(root, 'assets'),
      entry: false
    })
  })
})

describe('SF-7 mimeTypeOf', () => {
  it('SF-7 常见扩展名', () => {
    expect(mimeTypeOf('a.html')).toBe('text/html; charset=utf-8')
    expect(mimeTypeOf('A.JS')).toBe('text/javascript; charset=utf-8')
    expect(mimeTypeOf('a.mjs')).toBe('text/javascript; charset=utf-8')
    expect(mimeTypeOf('a.css')).toBe('text/css; charset=utf-8')
    expect(mimeTypeOf('a.json')).toBe('application/json; charset=utf-8')
    expect(mimeTypeOf('a.js.map')).toBe('application/json; charset=utf-8')
    expect(mimeTypeOf('a.txt')).toBe('text/plain; charset=utf-8')
    expect(mimeTypeOf('a.svg')).toBe('image/svg+xml')
    expect(mimeTypeOf('a.png')).toBe('image/png')
    expect(mimeTypeOf('a.jpeg')).toBe('image/jpeg')
    expect(mimeTypeOf('a.ico')).toBe('image/x-icon')
    expect(mimeTypeOf('a.woff2')).toBe('font/woff2')
    expect(mimeTypeOf('a.wasm')).toBe('application/wasm')
  })

  it('SF-7 不认识 / 没有扩展名 → application/octet-stream', () => {
    expect(mimeTypeOf('a.bin')).toBe('application/octet-stream')
    expect(mimeTypeOf('Makefile')).toBe('application/octet-stream')
  })
})

describe('SF-8 index.html 不分大小写', () => {
  it.each(['/INDEX.HTML', '/Index.html', '/index.HTML'])('SF-8 %s → not-found', (url) => {
    expect(get(url)).toStrictEqual({ kind: 'not-found' })
  })
})
