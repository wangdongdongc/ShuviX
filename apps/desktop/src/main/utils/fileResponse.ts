/**
 * 把本机文件回给页面时的两样纯计算 —— 桌面的 `shuvix-preview://`（services/customProtocols.ts）与网络服务的
 * `/files/*`（frontend/network/fileRoutes.ts，server mode phase D）共用：
 *
 *  - `previewMimeOf`：显式的 Content-Type —— Chromium 的媒体元素没有它就不让拖进度条，`<img>` 也可能不渲染；
 *  - `parseByteRange`：`Range: bytes=start-end` → 整个 / 一段 / 不可满足（206 / 416 的依据）。
 *
 * 不碰磁盘、不碰 Electron。
 */
import { extname } from 'path'

/** 预览 / 媒体资源的显式 Content-Type —— Chromium 媒体元素强制要求才允许 seek */
export const PREVIEW_MIME_BY_EXT: Readonly<Record<string, string>> = {
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

/** 文件名 → Content-Type（不认识的扩展名 → `application/octet-stream`） */
export function previewMimeOf(path: string): string {
  return PREVIEW_MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** 一个 Range 头对一个文件的意思 */
export type ByteRange =
  /** 没有 Range 头，或认不出的写法：整个文件（200） */
  | { readonly kind: 'full' }
  /** 一段：`start`…`end`（含两端，206） */
  | { readonly kind: 'partial'; readonly start: number; readonly end: number }
  /** 认得出、但落在文件外（416） */
  | { readonly kind: 'unsatisfiable' }

/** 后缀范围（`bytes=-N`）怎么读 */
export interface ByteRangeOptions {
  /**
   * `'legacy'`（缺省，桌面的 `shuvix-preview://` 改造前就是这样）：按「从 0 到 N」读 —— Chromium 的媒体元素
   * 从不发后缀范围，桌面行为因此保持原样；`'rfc'`（网络服务的 `/files/*`，面对的是局域网里任何浏览器）：
   * RFC 9110 的意思，最后 N 个字节（`bytes=-0` 不可满足，`bytes=-` 认不出、按整个文件）
   */
  readonly suffix?: 'legacy' | 'rfc'
}

/**
 * `Range` 头 → 要回的那一段。只认单段的 `bytes=start-end` / `bytes=start-` / `bytes=-end`（后缀范围的读法见
 * `ByteRangeOptions`）；多段或别的单位按整个文件回。
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
  options: ByteRangeOptions = {}
): ByteRange {
  if (!header) return { kind: 'full' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!m) return { kind: 'full' }
  if (options.suffix === 'rfc' && !m[1]) {
    if (!m[2]) return { kind: 'full' }
    const length = parseInt(m[2], 10)
    if (!(length > 0) || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'partial', start: Math.max(0, size - length), end: size - 1 }
  }
  const start = m[1] ? parseInt(m[1], 10) : 0
  const end = m[2] ? parseInt(m[2], 10) : size - 1
  if (start < size && start <= end && end < size) return { kind: 'partial', start, end }
  return { kind: 'unsatisfiable' }
}
