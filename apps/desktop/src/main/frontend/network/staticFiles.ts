/**
 * 网络服务的静态文件（server mode phase B/C）—— 浏览器里的 web 客户端就是渲染端构建产物里的 `web.html` 加它的
 * 资源（`out/renderer/`）。路由只有这些：
 *
 *  - `GET /`、`GET /web.html` → `web.html`（不在 → 503，一句短话：web 客户端没构建）；
 *  - `GET /<资源>` → 渲染端产物目录下的那个**文件**（目录不列、不出目录、不给桌面入口 `index.html` ——
 *    它要 preload，在浏览器里只会白屏）；不在 → 404；
 *  - 其余方法 → 405。
 *
 * 纯路径解析 + MIME 表（`resolveStaticRequest`），真正读文件的是服务端。phase D 在这里加文件路由。
 */
import { extname, resolve, sep } from 'node:path'

/** web 客户端的入口文件名（渲染端构建的第二个入口） */
export const WEB_ENTRY_FILE = 'web.html'

/** 不经网络给出去的文件（桌面窗口的入口：要 preload） */
const REFUSED_FILES = new Set(['index.html'])

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm'
}

/** 文件名 → Content-Type（不认识的扩展名 → `application/octet-stream`） */
export function mimeTypeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** 一次静态请求的去向 */
export type StaticResolution =
  | { readonly kind: 'file'; readonly path: string; readonly entry: boolean }
  | { readonly kind: 'bad-request' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'method-not-allowed' }

/**
 * 请求（方法 + 原始 URL）→ 去向。`root` 是渲染端产物目录（绝对路径）。只做路径上的判断（不碰磁盘）：
 * 解码失败 / 含 NUL → bad-request；解析之后出了 `root` → not-found；`/` → 入口。
 */
export function resolveStaticRequest(
  method: string | undefined,
  rawUrl: string | undefined,
  root: string
): StaticResolution {
  if (method !== 'GET' && method !== 'HEAD') return { kind: 'method-not-allowed' }
  const url = typeof rawUrl === 'string' && rawUrl.length > 0 ? rawUrl : '/'
  const pathPart = url.split('?')[0].split('#')[0]
  let pathname: string
  try {
    pathname = decodeURIComponent(pathPart)
  } catch {
    return { kind: 'bad-request' }
  }
  if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) {
    return { kind: 'bad-request' }
  }
  if (pathname === '/' || pathname === `/${WEB_ENTRY_FILE}`) {
    return { kind: 'file', path: resolve(root, WEB_ENTRY_FILE), entry: true }
  }
  if (pathname.endsWith('/')) return { kind: 'not-found' }
  const base = resolve(root)
  const target = resolve(base, `.${pathname}`)
  if (!target.startsWith(base + sep)) return { kind: 'not-found' }
  const relativeName = target.slice(base.length + 1)
  // 大小写不敏感的文件系统（macOS 缺省的 APFS、Windows）上 `/INDEX.HTML` 照样读到那个文件
  if (REFUSED_FILES.has(relativeName.toLowerCase())) return { kind: 'not-found' }
  // 隐藏文件（.DS_Store 之类）不给
  if (relativeName.split(sep).some((segment) => segment.startsWith('.'))) {
    return { kind: 'not-found' }
  }
  return { kind: 'file', path: target, entry: false }
}
