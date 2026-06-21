/**
 * 文本截断工具（宿主无关，桌面/扩展共用）。
 * 字节长度用 TextEncoder（浏览器 + Node 皆可），替代原 Node-only 的 Buffer.byteLength。
 */

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024
export const MAX_LINE_LENGTH = 2000

const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const encoder = new TextEncoder()

function byteLength(str: string): number {
  return encoder.encode(str).length
}

/** 截断超长单行（minified JS/CSS 等场景，避免浪费 token） */
export function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_LENGTH) return line
  return line.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
}

/** 格式化文件大小 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** 从头部截断（保留尾部内容），适用于 read 工具 */
export function truncateHead(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES
): { text: string; truncated: boolean; originalLines: number; originalBytes: number } {
  const lines = text.split('\n')
  const originalLines = lines.length
  const originalBytes = byteLength(text)

  if (originalLines <= maxLines && originalBytes <= maxBytes) {
    return { text, truncated: false, originalLines, originalBytes }
  }

  let result = lines.slice(-maxLines)
  while (result.length > 0 && byteLength(result.join('\n')) > maxBytes) {
    result = result.slice(1)
  }

  return { text: result.join('\n'), truncated: true, originalLines, originalBytes }
}

/** 从尾部截断（保留头部内容），适用于 bash 工具 */
export function truncateTail(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES
): { text: string; truncated: boolean; originalLines: number; originalBytes: number } {
  const lines = text.split('\n')
  const originalLines = lines.length
  const originalBytes = byteLength(text)

  if (originalLines <= maxLines && originalBytes <= maxBytes) {
    return { text, truncated: false, originalLines, originalBytes }
  }

  let result = lines.slice(0, maxLines)
  while (result.length > 0 && byteLength(result.join('\n')) > maxBytes) {
    result = result.slice(0, -1)
  }

  return { text: result.join('\n'), truncated: true, originalLines, originalBytes }
}

/**
 * 中间截断（保留首尾，砍掉中间）—— 适用于 bash/ssh 工具。
 * 默认比例：头部 30%、尾部 70%（尾部权重更高，错误信息通常在末尾）。
 */
export function truncateMiddle(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
  headRatio = 0.3
): { text: string; truncated: boolean; originalLines: number; originalBytes: number } {
  const lines = text.split('\n')
  const originalLines = lines.length
  const originalBytes = byteLength(text)

  if (originalLines <= maxLines && originalBytes <= maxBytes) {
    return { text, truncated: false, originalLines, originalBytes }
  }

  let headCount = Math.floor(maxLines * headRatio)
  let tailCount = maxLines - headCount

  let head = lines.slice(0, headCount)
  let tail = lines.slice(-tailCount)

  const separator = `\n... [${originalLines - headCount - tailCount} lines omitted] ...\n`
  while (
    head.length + tail.length > 0 &&
    byteLength(head.join('\n') + separator + tail.join('\n')) > maxBytes
  ) {
    if (head.length > 0 && head.length >= tail.length * headRatio) {
      head = head.slice(0, -1)
      headCount--
    } else if (tail.length > 0) {
      tail = tail.slice(1)
      tailCount--
    } else {
      head = head.slice(0, -1)
      headCount--
    }
  }

  const omitted = originalLines - headCount - tailCount
  const result = [...head, `\n... [${omitted} lines omitted] ...\n`, ...tail].join('\n')
  return { text: result, truncated: true, originalLines, originalBytes }
}
