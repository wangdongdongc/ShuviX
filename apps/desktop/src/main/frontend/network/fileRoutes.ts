/**
 * 网络服务的文件路由（server mode phase D，docs/server/phase-d-web-fallbacks.md §D1）—— 浏览器里的 web 客户端
 * 用它们代替桌面的自定义协议（路由表见 `shared/networkRoutes.ts`）：
 *
 *  - `GET /files/media?path=<绝对路径>`            流式回文件，按扩展名给 MIME，支持 Range（≈ `shuvix-media://`）；
 *  - `GET /files/preview?session=<id>&path=<路径>` 同上，路径按会话解析（≈ `shuvix-preview://`，同一份
 *    `resolvePreviewFilePath`）；
 *  - `GET /files/download?path=<绝对路径>`         同上，外加 `Content-Disposition: attachment`（导出后的下载）；
 *  - `GET /lib/<名字>`                             沙箱库（≈ `shuvix-lib://`，同一张白名单、同一份缓存）。
 *
 * 读法与桌面协议共用 `utils/fileResponse.ts` / `services/fileServing.ts`（MIME 表、Range 解析、路径解析、库白名单）。
 * 只认 GET / HEAD；文件不在 / 不是文件 → 404，没权限 → 403；Range 落在文件外 → 416（后缀范围按 RFC 读）。
 * **不限路径**（用户裁决，与那几个协议一样）。
 * 三道门（对端地址、Host）由服务端在进到这里之前就过完了。
 *
 * 不碰 Electron：路径解析与库读取由调用方交进来（单测给假的或真的 fileServing）。
 */
import { open, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, isAbsolute } from 'node:path'
import {
  NETWORK_DOWNLOAD_PATH,
  NETWORK_LIB_PREFIX,
  NETWORK_MEDIA_PATH,
  NETWORK_PREVIEW_PATH
} from '../../../shared/networkRoutes'
import { parseByteRange, previewMimeOf } from '../../utils/fileResponse'

/** 一条文件路由 */
export type FileRoute = 'media' | 'preview' | 'download' | 'lib'

export interface FileRouteDeps {
  /** 预览资源的路径解析（相对路径按会话的工作目录）；解析不了可以抛 */
  readonly resolvePreviewPath: (sessionId: string, path: string) => string
  /** 沙箱库的字节：不在白名单 → undefined；读失败可以抛 */
  readonly readSandboxLib: (name: string) => Promise<Buffer | undefined>
  readonly logger?: { warn(message: string): void }
}

/** 路径（不含查询串）→ 文件路由；不是文件路由 → undefined */
export function fileRouteOf(pathname: string): FileRoute | undefined {
  if (pathname === NETWORK_MEDIA_PATH) return 'media'
  if (pathname === NETWORK_PREVIEW_PATH) return 'preview'
  if (pathname === NETWORK_DOWNLOAD_PATH) return 'download'
  if (pathname.startsWith(NETWORK_LIB_PREFIX)) return 'lib'
  return undefined
}

function plain(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(text)
}

/**
 * `Content-Disposition: attachment` 的值：ASCII 的回落名（非 ASCII、引号、反斜杠换成 `_`）加 RFC 5987 的
 * `filename*`（原名的 UTF-8 百分号编码）
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download'
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * 能当文档跑脚本的类型：直接打开（顶层导航到 `/files/…`）时与 web 客户端同源，脚本就能连上 `/ws`。给它们加
 * `Content-Security-Policy: sandbox`（不透明源，连接的 Origin 是 `null`，过不了升级那道门）；当作 `<img>` 加载时
 * 这个头不起作用，预览照常
 */
const SCRIPTABLE_TYPES = new Set(['image/svg+xml'])

/**
 * 把一个文件回给请求方（Range → 206 / 416；HEAD 只回头）。先打开文件再写头：打不开（不在 / 不是普通文件 → 404，
 * 没权限 → 403）还来得及回一个干净的错误，而不是 200 之后断开
 */
async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  extraHeaders: Record<string, string> = {}
): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'EACCES' || code === 'EPERM') plain(res, 403, 'Forbidden.')
    else plain(res, 404, 'Not found.')
    return
  }
  let size: number
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('not a file')
    size = info.size
  } catch {
    await handle.close().catch(() => undefined)
    plain(res, 404, 'Not found.')
    return
  }
  const mime = previewMimeOf(path)
  const common = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(SCRIPTABLE_TYPES.has(mime) ? { 'Content-Security-Policy': 'sandbox' } : {}),
    ...extraHeaders
  }
  const rangeHeader = req.headers.range
  // 后缀范围按 RFC 读：这里面对的是局域网里任何浏览器（桌面协议保留旧读法，见 fileResponse.ts）
  const range = parseByteRange(typeof rangeHeader === 'string' ? rangeHeader : undefined, size, {
    suffix: 'rfc'
  })
  if (range.kind === 'unsatisfiable') {
    await handle.close().catch(() => undefined)
    res.writeHead(416, {
      'Content-Range': `bytes */${size}`,
      'Content-Length': 0,
      'Cache-Control': 'no-store'
    })
    res.end()
    return
  }
  const partial = range.kind === 'partial'
  const start = partial ? range.start : 0
  const end = partial ? range.end : size - 1
  res.writeHead(partial ? 206 : 200, {
    ...common,
    'Content-Length': partial ? end - start + 1 : size,
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {})
  })
  if (req.method === 'HEAD' || size === 0) {
    await handle.close().catch(() => undefined)
    res.end()
    return
  }
  // 流读的是已经打开的那个文件（autoClose：读完 / 出错 / 销毁时关掉句柄）
  const stream = handle.createReadStream({ start, end, autoClose: true })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/** 查询参数里的一个绝对路径（没有 / 不是绝对路径 / 带 NUL → undefined） */
function absolutePathParam(url: URL): string | undefined {
  const path = url.searchParams.get('path')
  if (!path || path.includes('\0') || !isAbsolute(path)) return undefined
  return path
}

/**
 * 回一次文件路由的请求。`url` 是解析过的请求地址（服务端拿 `req.url` 建的）。从不拒绝：出错回 500
 */
export async function serveFileRoute(
  route: FileRoute,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: FileRouteDeps
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    plain(res, 405, 'Method not allowed.')
    return
  }
  try {
    switch (route) {
      case 'media': {
        const path = absolutePathParam(url)
        if (path === undefined) return plain(res, 400, 'Bad request.')
        return await sendFile(req, res, path)
      }
      case 'download': {
        const path = absolutePathParam(url)
        if (path === undefined) return plain(res, 400, 'Bad request.')
        return await sendFile(req, res, path, {
          'Content-Disposition': attachmentDisposition(basename(path)),
          'Cache-Control': 'no-store'
        })
      }
      case 'preview': {
        const sessionId = url.searchParams.get('session')
        const rawPath = url.searchParams.get('path')
        if (!sessionId || !rawPath || rawPath.includes('\0')) {
          return plain(res, 400, 'Bad request.')
        }
        let path: string
        try {
          path = deps.resolvePreviewPath(sessionId, rawPath)
        } catch {
          return plain(res, 404, 'Not found.')
        }
        return await sendFile(req, res, path)
      }
      case 'lib': {
        let name: string
        try {
          name = decodeURIComponent(url.pathname.slice(NETWORK_LIB_PREFIX.length))
        } catch {
          return plain(res, 400, 'Bad request.')
        }
        const body = name.includes('/') ? undefined : await deps.readSandboxLib(name)
        if (body === undefined) return plain(res, 404, 'Not found.')
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff'
        })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }
    }
  } catch (error) {
    deps.logger?.warn(`network: ${route} request failed: ${String(error)}`)
    plain(res, 500, 'Internal error.')
  }
}
