/**
 * 文本截断工具函数
 * 供主程序工具和插件共用，运行于 Node.js 环境。
 */

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024
export const MAX_LINE_LENGTH = 2000

const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf-8')
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
