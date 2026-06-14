/**
 * 自定义协议 —— 让 renderer 通过 URL scheme 访问本地资源
 *
 * 两个协议：
 *
 *  - `shuvix-media://<absolutePath>`
 *      给 TTS 音频等"内部生成、路径可信"的文件做直通 <audio> 标签播放。
 *      不做沙箱校验：调用方（TTS 服务）写出文件后自己构造 URL，外部 URL 拼不出来。
 *
 *  - `shuvix-preview://load/?session=<sid>&path=<encodedAbs>`
 *      文件预览面板的 PDF / 视频 / 音频统一资源协议。
 *      与 shuvix-media 的关键差异：
 *        1. 强制沙箱归属校验（isPathInSandboxRead），renderer 拿不到工作区外的文件
 *        2. Range-aware：解析 `Range: bytes=start-end` 返回 206 Partial Content，
 *           否则 <video>/<audio> 进度条不可拖、PDFium 翻页慢
 *        3. 显式 Content-Type，否则 Chromium 媒体元素拒绝 seek
 *
 * 调用约定：
 *   - 在 app.whenReady 之前 调 `registerCustomProtocolSchemes()`（设置 privileges）
 *   - 在 app.whenReady 之后 调 `registerCustomProtocolHandlers()`（安装 handler）
 */

import { protocol, net } from 'electron'
import { createReadStream } from 'fs'
import { stat as fsStat } from 'fs/promises'
import { extname } from 'path'
import { Readable } from 'stream'
import { isPathInSandboxRead, resolveProjectConfig } from './toolContext'
import { resolveReadPath } from '../utils/toolUtils/pathUtils'
import { createLogger } from '../logger'

const log = createLogger('CustomProtocols')

/** preview 协议显式 Content-Type 映射 —— Chromium 媒体元素强制要求才允许 seek */
const PREVIEW_MIME_BY_EXT: Record<string, string> = {
  // 图片：供 <img src="shuvix-preview://..."> 加载（Markdown 内嵌 ![[img]]）。
  // 缺这些会回落 application/octet-stream，部分场景 <img> 不渲染。
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus'
}

/**
 * 注册 scheme + privileges。**必须在 app.whenReady 之前调用**，否则 Chromium 会按默认
 * 权限处理（CSP 拦截、不可 fetch、不被识别为 standard URL）。
 */
export function registerCustomProtocolSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'shuvix-media',
      privileges: { stream: true, supportFetchAPI: true, bypassCSP: true }
    },
    {
      // iframe 把本地 PDF 喂给 Chromium 内置 PDFium 渲染。
      // standard 让 URL 走标准解析（host/pathname/search），secure 让协议视为安全上下文，
      // bypassCSP 避免渲染端 frame-src 卡住，stream 允许大文件流式响应。
      scheme: 'shuvix-preview',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true
      }
    }
  ])
}

/**
 * 注册请求处理器。**必须在 app.whenReady 之后调用**，否则 protocol.handle 拒绝注册。
 */
export function registerCustomProtocolHandlers(): void {
  protocol.handle('shuvix-media', handleMediaRequest)
  protocol.handle('shuvix-preview', handlePreviewRequest)
}

/** shuvix-media —— 路径在 URL pathname 里，调用方可信，net.fetch 直通 file:// */
function handleMediaRequest(request: GlobalRequest): Promise<GlobalResponse> {
  const filePath = decodeURIComponent(new URL(request.url).pathname)
  return net.fetch(`file://${filePath}`)
}

/** shuvix-preview —— 沙箱 + Range 完整实现 */
async function handlePreviewRequest(request: GlobalRequest): Promise<GlobalResponse> {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session')
    const rawPath = url.searchParams.get('path')
    if (!sessionId || !rawPath) {
      return new Response('Bad request', { status: 400 })
    }

    const config = resolveProjectConfig(sessionId)
    const absolutePath = resolveReadPath(rawPath, config.workingDirectory)
    if (!isPathInSandboxRead(config, absolutePath)) {
      return new Response('Forbidden', { status: 403 })
    }

    const stat = await fsStat(absolutePath)
    const totalSize = stat.size
    const mime =
      PREVIEW_MIME_BY_EXT[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream'

    // Range 请求 → 206 Partial Content；浏览器据此实现 seek
    const rangeHeader = request.headers.get('range')
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0
        const end = m[2] ? parseInt(m[2], 10) : totalSize - 1
        if (start < totalSize && start <= end && end < totalSize) {
          const stream = createReadStream(absolutePath, { start, end })
          return new Response(Readable.toWeb(stream) as ReadableStream, {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${totalSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(end - start + 1),
              'Content-Type': mime
            }
          })
        }
        return new Response('', {
          status: 416,
          headers: { 'Content-Range': `bytes */${totalSize}` }
        })
      }
    }

    // 完整响应：仍带 Accept-Ranges，告诉浏览器后续可以发 Range
    const stream = createReadStream(absolutePath)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(totalSize),
        'Content-Type': mime
      }
    })
  } catch (err) {
    log.warn(`shuvix-preview handler error: ${err instanceof Error ? err.message : String(err)}`)
    return new Response('Internal error', { status: 500 })
  }
}
