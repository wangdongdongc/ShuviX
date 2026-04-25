/**
 * 多级匹配回退链（Replacer Chain）
 *
 * LLM 给出的 oldText 经常和文件实际内容有微小差异（缩进、空白、引号等）。
 * 本模块实现 6 级匹配策略，从严格到宽松依次尝试，直到找到唯一匹配：
 *
 *   1. ExactReplacer        — 精确匹配（最严格）
 *   2. UnicodeNormalizedReplacer — Unicode 智能引号/破折号/特殊空格归一化
 *   3. LineTrimmedReplacer  — 逐行 trimEnd 后匹配（容忍行尾空白差异）
 *   4. WhitespaceNormalizedReplacer — 连续空白归一化为单个空格
 *   5. IndentationFlexibleReplacer — 去除公共缩进后匹配（容忍缩进层级差异）
 *   6. BlockAnchorReplacer  — 首尾行锚定 + Levenshtein 模糊匹配（最宽松）
 *
 * 使用方式：调用 replaceWithFallback(content, oldText, newText)
 */

// ─── 类型定义 ──────────────────────────────────────────

/** 单次匹配结果 */
export interface ReplacerMatch {
  /** 匹配在原文中的起始位置 */
  index: number
  /** 匹配在原文中的长度 */
  length: number
}

/** 替换器接口 */
export interface Replacer {
  /** 替换器名称（调试用） */
  readonly name: string
  /** 在 content 中查找 oldText 的所有匹配 */
  findMatches(content: string, oldText: string): ReplacerMatch[]
}

/** replaceWithFallback 的返回值 */
export interface ReplaceResult {
  /** 替换后的完整内容 */
  content: string
  /** 命中的替换器名称 */
  replacerName: string
}

// ─── 工具函数 ──────────────────────────────────────────

/** Levenshtein 编辑距离 */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

/** 去除每行公共最小缩进 */
export function dedent(text: string): string {
  const lines = text.split('\n')
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0)
  if (nonEmptyLines.length === 0) return text

  const minIndent = Math.min(...nonEmptyLines.map((l) => l.match(/^(\s*)/)?.[0].length ?? 0))
  if (minIndent === 0) return text

  return lines.map((l) => (l.trim().length > 0 ? l.slice(minIndent) : l)).join('\n')
}

// ─── 替换器实现 ────────────────────────────────────────

/**
 * 第 1 级：精确匹配
 * 最严格，要求 oldText 与文件内容完全一致
 */
export const ExactReplacer: Replacer = {
  name: 'Exact',
  findMatches(content: string, oldText: string): ReplacerMatch[] {
    const matches: ReplacerMatch[] = []
    let pos = 0
    while (true) {
      const idx = content.indexOf(oldText, pos)
      if (idx === -1) break
      matches.push({ index: idx, length: oldText.length })
      pos = idx + 1
    }
    return matches
  }
}

/**
 * 第 2 级：Unicode 归一化匹配
 * 处理智能引号、Unicode 破折号、特殊空格字符等
 */
export const UnicodeNormalizedReplacer: Replacer = {
  name: 'UnicodeNormalized',
  findMatches(content: string, oldText: string): ReplacerMatch[] {
    const normalize = (s: string): string =>
      s
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')

    const normalizedContent = normalize(content)
    const normalizedOld = normalize(oldText)

    // 如果归一化后和原文一样，说明没有 Unicode 差异，跳过
    if (normalizedContent === content && normalizedOld === oldText) return []

    const matches: ReplacerMatch[] = []
    let pos = 0
    while (true) {
      const idx = normalizedContent.indexOf(normalizedOld, pos)
      if (idx === -1) break
      // 归一化不改变字符数量（都是 1:1 替换），所以 index 和 length 一致
      matches.push({ index: idx, length: normalizedOld.length })
      pos = idx + 1
    }
    return matches
  }
}

/**
 * 第 3 级：逐行 trimEnd 匹配
 * 容忍行尾空白差异（LLM 经常多加/少加行尾空格）
 */
export const LineTrimmedReplacer: Replacer = {
  name: 'LineTrimmed',
  findMatches(content: string, oldText: string): ReplacerMatch[] {
    const contentLines = content.split('\n')
    const searchLines = oldText.split('\n').map((l) => l.trimEnd())

    if (searchLines.length === 0) return []

    const matches: ReplacerMatch[] = []

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let allMatch = true
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trimEnd() !== searchLines[j]) {
          allMatch = false
          break
        }
      }

      if (allMatch) {
        // 计算原文中的精确位置
        let startIdx = 0
        for (let k = 0; k < i; k++) {
          startIdx += contentLines[k].length + 1 // +1 for '\n'
        }
        let matchLen = 0
        for (let k = 0; k < searchLines.length; k++) {
          matchLen += contentLines[i + k].length
          if (k < searchLines.length - 1) matchLen += 1 // '\n' between lines
        }
        matches.push({ index: startIdx, length: matchLen })
      }
    }
    return matches
  }
}

/**
 * 第 4 级：空白归一化匹配
 * 将连续空白字符（空格、tab、换行）归一化为单个空格后比较
 */
export const WhitespaceNormalizedReplacer: Replacer = {
  name: 'WhitespaceNormalized',
  findMatches(content: string, oldText: string): ReplacerMatch[] {
    const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim()
    const normalizedOld = normalize(oldText)
    if (!normalizedOld) return []

    // 对 content 的每个可能位置，提取子串并归一化后比较
    // 优化：先在全文归一化版本中查找，确认有匹配后再定位
    const normalizedContent = normalize(content)
    if (!normalizedContent.includes(normalizedOld)) return []

    // 找到匹配的原文范围：滑动窗口方式
    const matches: ReplacerMatch[] = []
    const contentLen = content.length

    // 提取所有"空白-分隔 token"的位置
    const tokens = [...normalizedOld.matchAll(/\S+/g)].map((m) => m[0])
    if (tokens.length === 0) return []

    // 在原文中找第一个 token 的所有出现位置，然后向后验证
    let searchStart = 0
    while (searchStart < contentLen) {
      // 跳过前导空白
      const nonWsStart = content.slice(searchStart).search(/\S/)
      if (nonWsStart === -1) break
      const start = searchStart + nonWsStart

      // 从 start 开始，尝试匹配所有 token
      let pos = start
      let tokenIdx = 0
      let matchEnd = start

      while (tokenIdx < tokens.length && pos < contentLen) {
        // 跳过空白
        while (pos < contentLen && /\s/.test(content[pos])) pos++
        if (pos >= contentLen) break

        // 尝试匹配 token
        const token = tokens[tokenIdx]
        if (content.startsWith(token, pos)) {
          matchEnd = pos + token.length
          pos = matchEnd
          tokenIdx++
        } else {
          break
        }
      }

      if (tokenIdx === tokens.length) {
        matches.push({ index: start, length: matchEnd - start })
        searchStart = matchEnd
      } else {
        searchStart = start + 1
      }
    }

    return matches
  }
}

/** 提取行的前导空白长度 */
function indentSize(line: string): number {
  return line.match(/^(\s*)/)?.[0].length ?? 0
}

/** 求最大公约数 */
function gcd(a: number, b: number): number {
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a
}

/**
 * 提取归一化的缩进模式：
 * 1. 减去最小缩进（基础偏移），得到相对缩进
 * 2. 相对缩进除以 GCD，得到归一化模式
 *
 * 例如 [0, 4, 4, 0] → 减0 → [0,4,4,0] → GCD=4 → [0,1,1,0]
 * 例如 [0, 2, 2, 0] → 减0 → [0,2,2,0] → GCD=2 → [0,1,1,0]
 * 例如 [8, 12, 8]   → 减8 → [0,4,0]   → GCD=4 → [0,1,0]
 * 例如 [4, 8, 4]    → 减4 → [0,4,0]   → GCD=4 → [0,1,0]
 */
function normalizedIndentPattern(lines: string[]): number[] {
  const sizes = lines.map((l) => (l.trim().length > 0 ? indentSize(l) : -1)) // -1 表示空行
  const nonNegSizes = sizes.filter((s) => s >= 0)
  if (nonNegSizes.length === 0) return sizes

  // 减去基础偏移（最小缩进）
  const base = Math.min(...nonNegSizes)
  const relative = sizes.map((s) => (s === -1 ? -1 : s - base))

  // 对非零相对缩进求 GCD 作为归一化单元
  const nonZeroRelative = relative.filter((s) => s > 0)
  if (nonZeroRelative.length === 0) return relative // 所有行缩进相同

  const unit = nonZeroRelative.reduce(gcd)
  return relative.map((s) => (s === -1 ? -1 : s / unit))
}

/**
 * 第 5 级：缩进弹性匹配
 * 比较归一化后的缩进模式和每行 trim 后的内容
 * 解决 LLM 搞错缩进层级的问题（如 2 空格 vs 4 空格）
 */
export const IndentationFlexibleReplacer: Replacer = {
  name: 'IndentationFlexible',
  findMatches(content: string, oldText: string): ReplacerMatch[] {
    const searchLines = oldText.split('\n')
    if (searchLines.length < 2) return [] // 单行无缩进问题

    const searchPattern = normalizedIndentPattern(searchLines)
    const searchTrimmed = searchLines.map((l) => l.trim())

    const contentLines = content.split('\n')
    const matches: ReplacerMatch[] = []

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      const blockLines = contentLines.slice(i, i + searchLines.length)

      // 先快速检查每行 trim 后内容是否一致
      let contentMatch = true
      for (let j = 0; j < searchLines.length; j++) {
        if (blockLines[j].trim() !== searchTrimmed[j]) {
          contentMatch = false
          break
        }
      }
      if (!contentMatch) continue

      // 内容一致，检查缩进模式是否归一化后相同
      const blockPattern = normalizedIndentPattern(blockLines)

      let patternMatch = true
      for (let j = 0; j < searchPattern.length; j++) {
        if (blockPattern[j] !== searchPattern[j]) {
          patternMatch = false
          break
        }
      }
      if (!patternMatch) continue

      // 跳过原文完全相同的情况（应被更高优先级的替换器处理）
      const block = blockLines.join('\n')
      if (block === oldText) continue

      let startIdx = 0
      for (let k = 0; k < i; k++) {
        startIdx += contentLines[k].length + 1
      }
      let matchLen = 0
      for (let k = 0; k < searchLines.length; k++) {
        matchLen += contentLines[i + k].length
        if (k < searchLines.length - 1) matchLen += 1
      }
      matches.push({ index: startIdx, length: matchLen })
    }
    return matches
  }
}

/**
 * 第 6 级：首尾行锚定 + Levenshtein 模糊匹配（最宽松）
 *
 * 算法：
 * 1. 用首行和末行作为"锚点"精确定位候选区域
 * 2. 对中间行用 Levenshtein 编辑距离计算相似度
 * 3. 单候选直接接受，多候选取相似度最高者（阈值 30%）
 *
 * 要求搜索文本至少 3 行（需要首行、末行锚点 + 至少 1 行中间内容）
 */
export const BlockAnchorReplacer: Replacer = {
  name: 'BlockAnchor',
  findMatches(content: string, oldText: string): ReplacerMatch[] {
    const searchLines = oldText.split('\n')
    if (searchLines.length < 3) return []

    const firstLine = searchLines[0].trimEnd()
    const lastLine = searchLines[searchLines.length - 1].trimEnd()
    const contentLines = content.split('\n')

    if (!firstLine || !lastLine) return []

    // 找所有首行锚点匹配
    const candidates: { lineStart: number; similarity: number }[] = []

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      if (contentLines[i].trimEnd() !== firstLine) continue

      const endLineIdx = i + searchLines.length - 1
      if (endLineIdx >= contentLines.length) continue
      if (contentLines[endLineIdx].trimEnd() !== lastLine) continue

      // 首尾锚点匹配，计算中间行相似度
      const middleSearchLines = searchLines.slice(1, -1)
      const middleContentLines = contentLines.slice(i + 1, endLineIdx)

      let similarity = 0
      const linesToCheck = Math.min(middleSearchLines.length, middleContentLines.length)
      if (linesToCheck === 0) {
        similarity = 1 // 只有首尾两行+一行中间，空中间视为完全匹配
      } else {
        for (let j = 0; j < linesToCheck; j++) {
          const a = middleSearchLines[j].trim()
          const b = middleContentLines[j].trim()
          const maxLen = Math.max(a.length, b.length)
          if (maxLen === 0) {
            similarity += 1 / linesToCheck
          } else {
            similarity += (1 - levenshtein(a, b) / maxLen) / linesToCheck
          }
        }
      }

      candidates.push({ lineStart: i, similarity })
    }

    if (candidates.length === 0) return []

    // 选择最佳候选
    let best: (typeof candidates)[0]
    if (candidates.length === 1) {
      best = candidates[0] // 单候选直接接受
    } else {
      // 多候选：取相似度最高者，阈值 30%
      candidates.sort((a, b) => b.similarity - a.similarity)
      if (candidates[0].similarity < 0.3) return []
      best = candidates[0]
    }

    // 计算原文中的精确位置
    let startIdx = 0
    for (let k = 0; k < best.lineStart; k++) {
      startIdx += contentLines[k].length + 1
    }
    let matchLen = 0
    for (let k = 0; k < searchLines.length; k++) {
      matchLen += contentLines[best.lineStart + k].length
      if (k < searchLines.length - 1) matchLen += 1
    }

    return [{ index: startIdx, length: matchLen }]
  }
}

// ─── 回退链执行 ────────────────────────────────────────

/** 替换器优先级列表（从严格到宽松） */
const REPLACER_CHAIN: Replacer[] = [
  ExactReplacer,
  UnicodeNormalizedReplacer,
  LineTrimmedReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  BlockAnchorReplacer
]

/**
 * 用回退链在 content 中查找 oldText 并替换为 newText
 *
 * 从最严格的精确匹配开始，依次尝试更宽松的策略。
 * 每级要求唯一匹配（找到多个则跳到下一级，因为更宽松的策略可能恰好唯一）。
 *
 * @returns 替换结果，包含新内容和命中的替换器名称
 * @throws 找不到匹配或无法确定唯一匹配时抛错
 */
export function replaceWithFallback(
  content: string,
  oldText: string,
  newText: string
): ReplaceResult {
  let lastMultipleCount = 0

  for (const replacer of REPLACER_CHAIN) {
    const matches = replacer.findMatches(content, oldText)

    if (matches.length === 1) {
      const match = matches[0]
      const newContent =
        content.substring(0, match.index) + newText + content.substring(match.index + match.length)
      return { content: newContent, replacerName: replacer.name }
    }

    if (matches.length > 1) {
      lastMultipleCount = matches.length
    }
  }

  // 所有替换器都失败
  if (lastMultipleCount > 0) {
    throw new Error(
      `Found ${lastMultipleCount} matches. The text must be unique; provide more surrounding context.`
    )
  }
  throw new Error(
    'No match found. The oldText must match the file content (including whitespace and newlines).'
  )
}
