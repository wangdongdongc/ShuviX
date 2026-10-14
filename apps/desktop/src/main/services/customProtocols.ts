/**
 * 自定义协议 —— 让 renderer 通过 URL scheme 访问本地资源
 *
 * 两个协议：
 *
 *  - `shuvix-media://<absolutePath>`
 *      给 TTS 音频等"内部生成、路径可信"的文件做直通 <audio> 标签播放。
 *      不做准入校验：调用方（TTS 服务）写出文件后自己构造 URL，外部 URL 拼不出来。
 *
 *  - `shuvix-preview://load/?session=<sid>&path=<encodedAbs>`
 *      文件预览面板的 PDF / 视频 / 音频统一资源协议。
 *      与 shuvix-media 的关键差异：
 *        1. 相对路径按会话的工作目录解析（与 files.read 同口径；不限路径）
 *        2. Range-aware：解析 `Range: bytes=start-end` 返回 206 Partial Content，
 *           否则 <video>/<audio> 进度条不可拖、PDFium 翻页慢
 *        3. 显式 Content-Type，否则 Chromium 媒体元素拒绝 seek
 *
 *  - `shuvix-lib://<name>`
 *      交互图（```interactive 围栏）沙箱里 `<script src>` 能加载的库。只按名字查白名单
 *      （chat-protocol 的 SANDBOX_LIBS），路径部分一概不看，名字不在表里就 404 —— 它不是一个
 *      文件服务器，只是两份随包静态文件的固定地址。**刻意不开 bypassCSP**：沙箱的 meta CSP 与
 *      宿主页面的 script-src 都显式列了 `shuvix-lib:`，放行是写在策略里的，而不是协议一句话绕过。
 *
 * 调用约定：
 *   - 在 app.whenReady 之前 调 `registerCustomProtocolSchemes()`（设置 privileges）
 *   - 在 app.whenReady 之后 调 `registerCustomProtocolHandlers()`（安装 handler）
 */

import { protocol, net } from 'electron'
import { createReadStream } from 'fs'
import { stat as fsStat } from 'fs/promises'
import { Readable } from 'stream'
import { SANDBOX_LIB_SCHEME } from '@shuvix/chat-protocol/utils/interactiveFence'
import { readSandboxLib, resolvePreviewFilePath } from './fileServing'
import { parseByteRange, previewMimeOf } from '../utils/fileResponse'
import { createLogger } from '../logger'

const log = createLogger('CustomProtocols')

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
    },
    {
      // standard：`shuvix-lib://chart.js` 按标准 URL 解析，名字落在 host 上；
      // secure：不被当成混合内容。没有 bypassCSP —— 见文件头
      scheme: SANDBOX_LIB_SCHEME,
      privileges: { standard: true, secure: true }
    }
  ])
}

/**
 * 注册请求处理器。**必须在 app.whenReady 之后调用**，否则 protocol.handle 拒绝注册。
 */
export function registerCustomProtocolHandlers(): void {
  protocol.handle('shuvix-media', handleMediaRequest)
  protocol.handle('shuvix-preview', handlePreviewRequest)
  protocol.handle(SANDBOX_LIB_SCHEME, handleSandboxLibRequest)
}

/**
 * shuvix-lib —— 名字（URL 的 host）查白名单，命中就回随包文件。路径、查询串一概不看，
 * 所以 `shuvix-lib://chart.js/../../etc/passwd` 与 `shuvix-lib://chart.js` 是同一个请求。
 * 白名单与读法与网络服务的 `/lib/<名字>` 共用（fileServing.ts）。
 */
export async function handleSandboxLibRequest(request: GlobalRequest): Promise<GlobalResponse> {
  let name: string
  try {
    name = new URL(request.url).hostname
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (request.method !== 'GET') return new Response('Not found', { status: 404 })
  try {
    const body = await readSandboxLib(name)
    if (!body) return new Response('Not found', { status: 404 })
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { 'Content-Type': 'text/javascript; charset=utf-8' }
    })
  } catch (err) {
    log.warn(`shuvix-lib handler error: ${err instanceof Error ? err.message : String(err)}`)
    return new Response('Internal error', { status: 500 })
  }
}

/** shuvix-media —— 路径在 URL pathname 里，调用方可信，net.fetch 直通 file:// */
function handleMediaRequest(request: GlobalRequest): Promise<GlobalResponse> {
  const filePath = decodeURIComponent(new URL(request.url).pathname)
  return net.fetch(`file://${filePath}`)
}

/** shuvix-preview —— 路径解析 + Range 完整实现（与网络服务的 `/files/preview` 共用 fileServing.ts） */
async function handlePreviewRequest(request: GlobalRequest): Promise<GlobalResponse> {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session')
    const rawPath = url.searchParams.get('path')
    if (!sessionId || !rawPath) {
      return new Response('Bad request', { status: 400 })
    }

    const absolutePath = resolvePreviewFilePath(sessionId, rawPath)

    const stat = await fsStat(absolutePath)
    const totalSize = stat.size
    const mime = previewMimeOf(absolutePath)

    // Range 请求 → 206 Partial Content；浏览器据此实现 seek
    const range = parseByteRange(request.headers.get('range'), totalSize)
    if (range.kind === 'partial') {
      const { start, end } = range
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
    if (range.kind === 'unsatisfiable') {
      return new Response('', {
        status: 416,
        headers: { 'Content-Range': `bytes */${totalSize}` }
      })
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
