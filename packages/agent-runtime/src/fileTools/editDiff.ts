/**
 * Edit Diff 工具函数
 * 从 pi-coding-agent 移植，用于 edit 工具的文本匹配和差异生成
 */

import * as Diff from 'diff'

/** 检测文件行尾类型 */
export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfIdx = content.indexOf('\r\n')
  const lfIdx = content.indexOf('\n')
  if (lfIdx === -1) return '\n'
  if (crlfIdx === -1) return '\n'
  return crlfIdx < lfIdx ? '\r\n' : '\n'
}

/** 将所有行尾规范化为 LF */
export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** 恢复行尾为指定类型 */
export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

/**
 * 模糊匹配规范化
 * 去除行尾空白、规范化智能引号和 Unicode 破折号
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      // 去除行尾空白
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      // 智能单引号 → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // 智能双引号 → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // 各种破折号 → -
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      // 特殊空格 → 普通空格
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
  )
}

/** 模糊匹配结果 */
export interface FuzzyMatchResult {
  found: boolean
  index: number
  matchLength: number
  usedFuzzyMatch: boolean
  contentForReplacement: string
}

/**
 * 在内容中查找文本，先精确匹配，再模糊匹配
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  // 先尝试精确匹配
  const exactIndex = content.indexOf(oldText)
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content
    }
  }

  // 尝试模糊匹配
  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText)

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content
    }
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent
  }
}

/** 去除 UTF-8 BOM */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content }
}

/** Diff 结果 */
export interface EditDiffResult {
  diff: string
  firstChangedLine: number | undefined
}

/** 传输上限：diff 既要进审批请求（IPC）又要落 JSONL，整份大文件写入不能原样带走 */
const DIFF_MAX_LINES = 1200
const DIFF_MAX_CHARS = 256 * 1024

/**
 * 给 diff 封顶 —— **只在算出后调用一次**，截断结果同时用于审批预览和 tool result，
 * 两侧因此仍是同一个字符串（不能预览截断、落库不截断，那就分歧了）。
 *
 * 截断标记不匹配 DiffViewer 的行号/省略号文法，会走它的兜底分支按整行原样渲染。
 */
export function capDiffString(diff: string): string {
  const lines = diff.split('\n')
  let kept = lines.length > DIFF_MAX_LINES ? lines.slice(0, DIFF_MAX_LINES) : lines
  let out = kept.join('\n')
  let cutMidLine = false
  if (out.length > DIFF_MAX_CHARS) {
    out = out.slice(0, DIFF_MAX_CHARS)
    // 砍在半行上会让最后一行错位，优先退到最后一个完整行
    const lastBreak = out.lastIndexOf('\n')
    if (lastBreak > 0) {
      out = out.slice(0, lastBreak)
    } else {
      // 首行自己就超限（压缩过的 JS、单行 JSON）——没有行边界可退，只能从行中间砍。
      // 这时行数没少，不能靠 omitted 来提示，否则会返回一个被腰斩且毫无标记的串。
      cutMidLine = true
    }
    kept = out.split('\n')
  }
  const omitted = lines.length - kept.length
  // 腰斩优先报告：首行超限时行数也可能同时少了，但只说 "N more lines" 会让人以为
  // 留下的行都是完整的 —— 那正是最后一行被砍了一半的情形。
  if (cutMidLine) {
    const more = omitted > 0 ? `, ${omitted} more lines` : ''
    return `${out}\n[diff truncated — line too long${more}]`
  }
  if (omitted > 0) return `${out}\n[diff truncated — ${omitted} more lines]`
  return out
}

/**
 * 生成带行号和上下文的统一差异字符串
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4
): EditDiffResult {
  const parts = Diff.diffLines(oldContent, newContent)
  const output: string[] = []

  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const maxLineNum = Math.max(oldLines.length, newLines.length)
  const lineNumWidth = String(maxLineNum).length

  let oldLineNum = 1
  let newLineNum = 1
  let lastWasChange = false
  let firstChangedLine: number | undefined

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const raw = part.value.split('\n')
    if (raw[raw.length - 1] === '') {
      raw.pop()
    }

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum
      }

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, ' ')
          output.push(`+${lineNum} ${line}`)
          newLineNum++
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(`-${lineNum} ${line}`)
          oldLineNum++
        }
      }
      lastWasChange = true
    } else {
      const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed)

      if (lastWasChange || nextPartIsChange) {
        let linesToShow = raw
        let skipStart = 0
        let skipEnd = 0

        if (!lastWasChange) {
          skipStart = Math.max(0, raw.length - contextLines)
          linesToShow = raw.slice(skipStart)
        }

        if (!nextPartIsChange && linesToShow.length > contextLines) {
          skipEnd = linesToShow.length - contextLines
          linesToShow = linesToShow.slice(0, contextLines)
        }

        if (skipStart > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
          oldLineNum += skipStart
          newLineNum += skipStart
        }

        for (const line of linesToShow) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, ' ')
          output.push(` ${lineNum} ${line}`)
          oldLineNum++
          newLineNum++
        }

        if (skipEnd > 0) {
          output.push(` ${''.padStart(lineNumWidth, ' ')} ...`)
          oldLineNum += skipEnd
          newLineNum += skipEnd
        }
      } else {
        oldLineNum += raw.length
        newLineNum += raw.length
      }

      lastWasChange = false
    }
  }

  return { diff: output.join('\n'), firstChangedLine }
}
