/**
 * 浏览器「重料」读取（Stage 2）—— 图片（base64 多模态）+ URL 抓取（HTML→Markdown）。
 *
 * 这两类是平台胶水（非共享内核）：桌面用 nativeImage / markitdown-ts，浏览器用 Canvas / fetch+turndown。
 * heavy 库（turndown）按需 import()，不进主包。富文档（PDF/Word/Excel）仍未支持。
 */
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ReadToolDetails } from '@shuvix/chat-protocol/types/chatMessage'
import { formatSize } from '@shuvix/agent-runtime'
import { getFile } from './fsaPort'

type ReadResult = AgentToolResult<ReadToolDetails>

/** 检测是否为 HTTP/HTTPS URL */
export function isUrl(path: string): boolean {
  return /^https?:\/\//i.test(path)
}

/** 支持作为图像返回的扩展名 → MIME（与桌面 IMAGE_MIME_BY_EXT 一致） */
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

/** 取小写扩展名（含点）；无扩展名返回 '' */
export function extOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i).toLowerCase()
}

/** 单张图片返回给模型的字节上限；超过则自动缩放 + JPEG 重编码 */
const MAX_IMAGE_BYTES = 1 * 1024 * 1024

/** 图像压缩阶梯（最大宽度 × JPEG 质量），命中首个 ≤ 上限的即返回（与桌面一致） */
const IMAGE_COMPRESS_STEPS: ReadonlyArray<{ maxWidth: number; quality: number }> = [
  { maxWidth: 2000, quality: 85 },
  { maxWidth: 1600, quality: 80 },
  { maxWidth: 1200, quality: 75 },
  { maxWidth: 1000, quality: 65 },
  { maxWidth: 800, quality: 55 }
]

/** URL 抓取超时 / 响应体上限 / 转换后 Markdown 字符上限 */
const FETCH_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_MARKDOWN_CHARS = 200_000

/** Blob → base64（分块避免 String.fromCharCode 爆栈） */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 超限图片：解码 → 阶梯压缩为 JPEG，命中首个 ≤ 上限的即返回 */
async function compressImage(
  file: File,
  origFormat: string
): Promise<{ base64: string; note: string; size: number }> {
  const bitmap = await createImageBitmap(file)
  const origW = bitmap.width
  const origH = bitmap.height
  try {
    for (const step of IMAGE_COMPRESS_STEPS) {
      const targetWidth = Math.min(origW, step.maxWidth)
      const scale = targetWidth / origW
      const w = Math.max(1, Math.round(origW * scale))
      const h = Math.max(1, Math.round(origH * scale))
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D context unavailable')
      ctx.drawImage(bitmap, 0, 0, w, h)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: step.quality / 100 })
      if (blob.size <= MAX_IMAGE_BYTES) {
        const base64 = await blobToBase64(blob)
        const note =
          `Auto-compressed from ${origFormat} ${origW}×${origH} ${formatSize(file.size)} → ` +
          `JPEG ${w}×${h} ${formatSize(blob.size)} (quality ${step.quality})`
        return { base64, note, size: blob.size }
      }
    }
  } finally {
    bitmap.close()
  }
  throw new Error(
    `Image too large to compress under ${formatSize(MAX_IMAGE_BYTES)}: ${origFormat} ` +
      `${origW}×${origH} (${formatSize(file.size)}). Re-capture with a narrower viewport.`
  )
}

/** 读图片：≤1MB 直出原图（base64），否则 Canvas 阶梯压缩为 JPEG */
export async function readImage(
  root: FileSystemDirectoryHandle,
  path: string,
  ext: string
): Promise<ReadResult> {
  const file = await getFile(root, path)
  const fileSize = file.size
  const format = ext.slice(1).toUpperCase()

  if (fileSize <= MAX_IMAGE_BYTES) {
    const base64 = await blobToBase64(file)
    const mimeType = IMAGE_MIME_BY_EXT[ext] ?? 'image/png'
    return {
      content: [
        { type: 'image' as const, data: base64, mimeType },
        { type: 'text' as const, text: `Image: ${path} (${format}, ${formatSize(fileSize)})` }
      ],
      details: { type: 'read', fileSize, format, truncated: false }
    }
  }

  const { base64, note, size } = await compressImage(file, format)
  return {
    content: [
      { type: 'image' as const, data: base64, mimeType: 'image/jpeg' },
      { type: 'text' as const, text: `Image: ${path}\n${note}` }
    ],
    details: { type: 'read', fileSize: size, format: 'JPEG', truncated: true }
  }
}

/** 抓取 URL：HTML → Markdown（turndown 按需加载）；非 HTML 返回纯文本 */
export async function readUrl(url: string, signal?: AbortSignal): Promise<ReadResult> {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  // 扩展页持有 <all_urls> host_permissions，可跨源 fetch（无 CORS 限制）。
  // 浏览器 fetch 不允许设置 User-Agent，沿用默认 UA。
  const res = await fetch(url, { signal: combined })
  if (!res.ok) throw new Error(`Failed to fetch URL (${res.status} ${res.statusText}): ${url}`)

  const contentLength = res.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Response too large (${formatSize(parseInt(contentLength, 10))}). ` +
        `Maximum allowed: ${formatSize(MAX_RESPONSE_BYTES)}.`
    )
  }

  const contentType = res.headers.get('content-type') || ''
  const raw = await res.text()

  let body: string
  if (/html/i.test(contentType) || /^\s*<(?:!doctype|html)/i.test(raw)) {
    const { default: TurndownService } = await import('turndown')
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    body = td.turndown(raw)
  } else {
    body = raw
  }

  let truncated = false
  if (body.length > MAX_MARKDOWN_CHARS) {
    body = body.slice(0, MAX_MARKDOWN_CHARS) + '\n\n[Output truncated — content exceeded limit.]'
    truncated = true
  }

  return {
    content: [{ type: 'text' as const, text: `URL: ${url} — converted to Markdown\n\n${body}` }],
    details: { type: 'read', format: 'URL', converted: true, truncated, url }
  }
}
