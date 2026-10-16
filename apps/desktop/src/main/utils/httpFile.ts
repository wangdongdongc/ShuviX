/**
 * 用 node:http 把本机文件回给请求方 —— 网络服务的 `/files/*`（frontend/network/fileRoutes.ts）与 widget 服务的
 * `/w/<id>/fs/file`（services/widget/widgetFiles.ts）共用。从 fileRoutes.ts 挪出来，是因为 widget 是内聚模块，
 * 按分层规则引不了 frontend/network。
 *
 * MIME 表与 Range 解析在 fileResponse.ts（那边是纯计算，不碰磁盘）。
 */
import { open, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseByteRange, previewMimeOf } from './fileResponse'

/** 一句纯文本应答（no-store、nosniff）；头已经发出去了就只能断开 */
export function plainResponse(res: ServerResponse, status: number, text: string): void {
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
 * 能当文档跑脚本的类型：直接打开（顶层导航到这个地址）时与页面同源，脚本就能连上 `/ws`。给它们加
 * `Content-Security-Policy: sandbox`（不透明源，连接的 Origin 是 `null`，过不了升级那道门）；当作 `<img>` 加载时
 * 这个头不起作用，预览照常
 */
const SCRIPTABLE_TYPES = new Set(['image/svg+xml'])

/**
 * 把一个文件回给请求方（Range → 206 / 416；HEAD 只回头）。先打开文件再写头：打不开（不在 / 不是普通文件 → 404，
 * 没权限 → 403）还来得及回一个干净的错误，而不是 200 之后断开。后缀范围按 RFC 读（面对的是任何浏览器）
 */
export async function sendFileResponse(
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
    if (code === 'EACCES' || code === 'EPERM') plainResponse(res, 403, 'Forbidden.')
    else plainResponse(res, 404, 'Not found.')
    return
  }
  let size: number
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('not a file')
    size = info.size
  } catch {
    await handle.close().catch(() => undefined)
    plainResponse(res, 404, 'Not found.')
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
  // 后缀范围按 RFC 读：这里面对的是任何浏览器（桌面协议保留旧读法，见 fileResponse.ts）
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
