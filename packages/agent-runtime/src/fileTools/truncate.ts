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

/** 一个码点的 UTF-8 字节数（孤立的代理项按 TextEncoder 的做法算作 U+FFFD，3 字节） */
function utf8Size(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
}

/**
 * 按 UTF-8 字节数截取字符串的开头 / 结尾，不劈开字符。只走到预算用完为止 —— 几 MB 的一整行也
 * 不会被整个拆成字符数组。用于「只剩一行、它自己就超过上限」的场合：整行丢掉就什么都不剩了。
 */
function sliceBytes(text: string, maxBytes: number, from: 'start' | 'end'): string {
  if (maxBytes <= 0 || !text) return ''
  let used = 0
  if (from === 'start') {
    let i = 0
    while (i < text.length) {
      const cp = text.codePointAt(i)!
      const size = utf8Size(cp)
      if (used + size > maxBytes) break
      used += size
      i += cp > 0xffff ? 2 : 1
    }
    return text.slice(0, i)
  }
  let j = text.length
  while (j > 0) {
    let cp = text.charCodeAt(j - 1)
    let units = 1
    if (cp >= 0xdc00 && cp <= 0xdfff && j >= 2) {
      const hi = text.charCodeAt(j - 2)
      if (hi >= 0xd800 && hi <= 0xdbff) {
        cp = ((hi - 0xd800) << 10) + (cp - 0xdc00) + 0x10000
        units = 2
      }
    }
    const size = utf8Size(cp)
    if (used + size > maxBytes) break
    used += size
    j -= units
  }
  return text.slice(j)
}

/**
 * 中间截断（保留首尾，砍掉中间）—— 适用于 bash/ssh 工具。
 * 默认比例：头部 30%、尾部 70%（尾部权重更高，错误信息通常在末尾）。
 *
 * 首尾两段从**实际有的行**里按比例分（`min(行数, maxLines)`），两段不重叠：只因字节超限而截断时
 * （行数远小于 maxLines），按 maxLines 分出的头尾各自都能罩住全文，同样的内容会在首尾各出现一遍，
 * 省略的行数还会算成负数。只剩一行而这一行自己就超过字节上限时，在行内按字节截首尾 ——
 * 否则结果里只剩一句「省略了多少行」。
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

  const budget = Math.min(originalLines, maxLines)
  let headCount = Math.floor(budget * headRatio)
  let tailCount = budget - headCount

  let head = lines.slice(0, headCount)
  let tail = tailCount > 0 ? lines.slice(-tailCount) : []

  const marker = (omitted: number): string => `\n... [${omitted} lines omitted] ...\n`
  while (
    head.length + tail.length > 0 &&
    byteLength([...head, marker(originalLines - headCount - tailCount), ...tail].join('\n')) >
      maxBytes
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

  if (head.length + tail.length > 0) {
    const omitted = originalLines - headCount - tailCount
    return {
      text: [...head, marker(omitted), ...tail].join('\n'),
      truncated: true,
      originalLines,
      originalBytes
    }
  }

  // 一行都放不下（有一行自己就超过上限）：在全文里按字节截首尾，中间标出省略了多少字节
  const room = Math.max(0, maxBytes - byteLength('\n... [99999999999 bytes omitted] ...\n'))
  const start = sliceBytes(text, Math.floor(room * headRatio), 'start')
  const end = sliceBytes(text, room - byteLength(start), 'end')
  const omittedBytes = originalBytes - byteLength(start) - byteLength(end)
  return {
    text: `${start}\n... [${omittedBytes} bytes omitted] ...\n${end}`,
    truncated: true,
    originalLines,
    originalBytes
  }
}
