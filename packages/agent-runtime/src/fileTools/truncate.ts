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
 * 一段文本的 UTF-8 字节数，不分配内存（与 TextEncoder 同一个算法：孤立的代理项按 U+FFFD 算 3 字节）。
 * 按行统计成千上万行时，逐行 encode 一遍就是逐行分配一次。
 */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** 一个码点的 UTF-8 字节数（孤立的代理项按 U+FFFD 算 3 字节） */
function utf8Size(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
}

/**
 * 按 UTF-8 字节数截取字符串的开头 / 结尾，不劈开字符。只走到预算用完为止 —— 几 MB 的一整行也
 * 不会被整个拆成字符数组。
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

/** 截在行内时，每一侧至少留这么多字节 —— 少于它，那一侧的开头 / 结尾就什么也看不出来 */
const MIN_SIDE_BYTES = 8

/** 省略标记（单独一行） */
function omittedMarker(count: number, unit: 'lines' | 'bytes'): string {
  return `... [${count} ${unit} omitted] ...`
}

/**
 * 中间截断（保留首尾，砍掉中间）—— bash / ssh，以及宿主给所有超限工具结果的缺省截法。
 * 默认比例：头部 30%、尾部 70%（尾部权重更高，错误信息通常在末尾）。
 *
 * 两个上限内原样返回。否则结果恰好是「头部 + 一行省略标记 + 尾部」，不超过 `maxLines` 行、
 * `maxBytes` 字节：
 *  - 首行与末行放得下就整行保留；首尾两段不重叠、不重复；其余的行按比例从两端交替往里取，
 *    一侧的下一行放不下就让另一侧接着取（一趟线性，不反复重算已保留的部分）；
 *  - 首行或末行自己就超过它那一份时，在那一行**里面**按字节截（不劈开字符），取到它那一份为止，
 *    最后没用完的预算再还给它 —— 一整段巨大的段落、压缩过的一行文件，开头与结尾都还在；
 *  - 标记里的数字是真实省略的量：只取整行时是 `... [N lines omitted] ...`，有一侧截在行内时是
 *    `... [N bytes omitted] ...`（原文 = 头部 + 省略的字节 + 尾部）。
 *
 * 上限小到放不下一行标记加两侧一点内容（`maxLines < 3`、字节预算不够两侧各 8 字节）时，
 * 只留开头、不带标记 —— 仍守住两个上限。
 */
export function truncateMiddle(
  text: string,
  maxLines = DEFAULT_MAX_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
  headRatio = 0.3
): { text: string; truncated: boolean; originalLines: number; originalBytes: number } {
  const lines = text.split('\n')
  const n = lines.length
  const originalBytes = utf8Length(text)
  if (n <= maxLines && originalBytes <= maxBytes) {
    return { text, truncated: false, originalLines: n, originalBytes }
  }
  const done = (out: string): ReturnType<typeof truncateMiddle> => ({
    text: out,
    truncated: true,
    originalLines: n,
    originalBytes
  })

  const ratio = Math.min(1, Math.max(0, headRatio))
  // 标记按最长的写法预留（字节数的位数不会少于行数的位数）
  const budget = maxBytes - utf8Length(omittedMarker(originalBytes, 'bytes'))
  const lineBudget = maxLines - 1
  if (lineBudget < 2 || budget < MIN_SIDE_BYTES * 2) {
    const kept = lines.slice(0, Math.max(0, maxLines)).join('\n')
    return done(sliceBytes(kept, Math.max(0, maxBytes), 'start'))
  }

  // 每行的代价 = 它的字节数 + 一个换行（接下一行或接标记）
  const cost = lines.map((line) => utf8Length(line) + 1)
  const headShare = Math.min(
    budget - MIN_SIDE_BYTES,
    Math.max(MIN_SIDE_BYTES, Math.floor(budget * ratio))
  )
  const tailShare = budget - headShare

  let h = 0 // 头部整行数
  let t = 0 // 尾部整行数
  let headCut = 0 // 首行截在行内时它的字节预算（含换行）；0 = 没截
  let tailCut = 0

  if (n === 1) {
    headCut = headShare
    tailCut = tailShare
  } else if (cost[0] + cost[n - 1] <= budget) {
    h = 1
    t = 1
  } else if (cost[n - 1] > tailShare) {
    tailCut = tailShare
    if (cost[0] <= budget - tailShare) h = 1
    else headCut = headShare
  } else {
    // 末行放得进它那一份，所以大的是首行
    t = 1
    headCut = headShare
  }

  let used = (headCut || (h ? cost[0] : 0)) + (tailCut || (t ? cost[n - 1] : 0))
  const claimed = (): number => (headCut ? 1 : h) + (tailCut ? 1 : t)
  while (claimed() < n && claimed() < lineBudget) {
    const headOk = !headCut && h > 0 && used + cost[h] <= budget
    const tailOk = !tailCut && t > 0 && used + cost[n - 1 - t] <= budget
    const preferHead = h + 1 <= ratio * (claimed() + 1)
    if (headOk && (preferHead || !tailOk)) {
      used += cost[h]
      h++
    } else if (tailOk) {
      used += cost[n - 1 - t]
      t++
    } else break
  }

  // 没用完的预算还给截在行内的那一侧（两侧都截了就按比例分）
  const leftover = budget - used
  if (leftover > 0 && headCut && tailCut) {
    const add = Math.floor(leftover * ratio)
    headCut += add
    tailCut += leftover - add
  } else if (leftover > 0 && headCut) headCut += leftover
  else if (leftover > 0 && tailCut) tailCut += leftover

  const head = headCut ? sliceBytes(lines[0], headCut - 1, 'start') : lines.slice(0, h).join('\n')
  const tail = tailCut
    ? sliceBytes(lines[n - 1], tailCut - 1, 'end')
    : lines.slice(n - t).join('\n')
  const marker =
    headCut || tailCut
      ? omittedMarker(originalBytes - utf8Length(head) - utf8Length(tail), 'bytes')
      : omittedMarker(n - h - t, 'lines')
  return done(`${head}\n${marker}\n${tail}`)
}
