/**
 * `GET|HEAD /w/<id>/lib/<name>@<version>/<file>` —— 由宿主单独发的库（widgetLibs.json 里带 `served` 的，目前是
 * three）。组件打包时把它留作外部模块，页面骨架的 import map 指到这里（bundler/widgetLibs.ts widgetImportMap）。
 *
 * - 只发 vendor 里那个库的文件，版本必须对上。vendor 里 served 库本来就只有挑出来的那几个文件加上它们相对 import
 *   到的（three.module.js → three.core.js），所以「在 vendor 里」就是边界。地址带版本，可以一年长缓存：应用升级
 *   换了版本，地址跟着变（远程浏览器经网络服务转发时地址跨重启不变，靠的就是这个）
 * - 浏览器说收 gzip 就发 gzip（压一次缓存在内存里）：three 不压缩约 0.7 MB，手机远程打开时这是直传的
 * - 令牌照常要（widgetServer.ts 在这之前验过）：页面自己发的子资源请求由宿主补头
 */

import type { IncomingMessage, ServerResponse } from 'http'
import { gzipSync } from 'zlib'
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { bundlerResourcePath } from '../bundler'
import { widgetLibraryOf } from '../bundler/widgetLibs'

/** 请求路径（`/w/<id>` 之后那段）是不是库文件路由 */
export const WIDGET_LIB_SEGMENT = '/lib/'

const LIB_PATH = /^\/lib\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)\/(.+)$/

const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8'
}

/** 压过的文件（绝对路径 → gzip 字节）：vendor 只在安装时变，进程内不用失效 */
const gzipCache = new Map<string, Buffer>()

/** 浏览器收不收 gzip：`Accept-Encoding` 里有 gzip（或 `*`）且 q 不为 0 */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(',') : (header ?? '')
  for (const part of value.split(',')) {
    const [coding, ...params] = part.trim().toLowerCase().split(';')
    if (coding !== 'gzip' && coding !== '*') continue
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='))
    return q === undefined || Number(q.slice(2)) > 0
  }
  return false
}

/** 解析出 vendor 里的文件；不该发 → null（一律 404，不说为什么） */
export function resolveWidgetLibFile(rest: string, vendorDir: string): string | null {
  const m = rest.match(LIB_PATH)
  if (!m) return null
  const [, name, version, file] = m
  const lib = widgetLibraryOf(name)
  if (!lib || lib.name !== name || !lib.served || lib.version !== version) return null
  const segments = file.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) return null
  const ext = file.slice(file.lastIndexOf('.') + 1)
  if (!CONTENT_TYPES[ext]) return null
  const abs = join(vendorDir, 'node_modules', name, ...segments)
  try {
    if (!statSync(abs).isFile()) return null
  } catch {
    return null
  }
  return abs
}

/** 发一个库文件；路由不对或文件不在 → 404 */
export function serveWidgetLib(rest: string, req: IncomingMessage, res: ServerResponse): void {
  const abs = resolveWidgetLibFile(rest, bundlerResourcePath('vendor'))
  const method = (req.method ?? 'GET').toUpperCase()
  if (!abs || (method !== 'GET' && method !== 'HEAD')) {
    res.writeHead(abs ? 405 : 404, { 'Content-Type': 'text/plain' })
    res.end(abs ? 'Method not allowed' : 'Not found')
    return
  }
  const gzip = acceptsGzip(req.headers['accept-encoding'])
  let body: Buffer
  if (gzip) {
    body = gzipCache.get(abs) ?? gzipSync(readFileSync(abs))
    gzipCache.set(abs, body)
  } else {
    body = readFileSync(abs)
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[abs.slice(abs.lastIndexOf('.') + 1)],
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    Vary: 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {})
  })
  res.end(method === 'HEAD' ? undefined : body)
}
