/**
 * 文本截断工具函数
 * 从 pi-coding-agent 移植，支持按行数和字节数截断
 */

/** 默认最大行数 */
export const DEFAULT_MAX_LINES = 2000

/** 默认最大字节数（50KB） */
export const DEFAULT_MAX_BYTES = 50 * 1024

/** 单行最大字符数 */
export const MAX_LINE_LENGTH = 2000

/** 单行截断后缀 */
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

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

/** 计算字符串的 UTF-8 字节数 */
function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf-8')
}

/**
 * 从头部截断（保留尾部内容）
 * 适用于 read 工具：用户关注文件尾部内容
 */
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

  // 先按行数截断（保留尾部）
  let result = lines.slice(-maxLines)

  // 再按字节数截断
  while (result.length > 0 && byteLength(result.join('\n')) > maxBytes) {
    result = result.slice(1)
  }

  const truncatedText = result.join('\n')
  return {
    text: truncatedText,
    truncated: true,
    originalLines,
    originalBytes
  }
}

/**
 * 从尾部截断（保留头部内容）
 * 适用于 bash 工具：用户关注命令开头的输出
 */
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

  // 先按行数截断（保留头部）
  let result = lines.slice(0, maxLines)

  // 再按字节数截断
  while (result.length > 0 && byteLength(result.join('\n')) > maxBytes) {
    result = result.slice(0, -1)
  }

  const truncatedText = result.join('\n')
  return {
    text: truncatedText,
    truncated: true,
    originalLines,
    originalBytes
  }
}
