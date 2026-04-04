/**
 * 统一工具输出处理 — 截断 + 磁盘持久化
 * 所有工具生成完整文本后统一调用，由此函数决定：
 *   1. 未超限 → 原样返回
 *   2. 超限 → 尝试持久化到磁盘，返回 preview + 文件路径
 *   3. 持久化失败 → 降级为内存截断
 */

import { join } from 'path'
import { writeFileSync } from 'fs'
import { getToolResultsDir } from '../../utils/paths'
import {
  truncateMiddle,
  truncateHead,
  truncateTail,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES
} from '../../../shared/node/truncate'
import { createLogger } from '../../logger'

const log = createLogger('processToolOutput')

/** 截断策略：决定保留内容的哪个部分 */
export type TruncateStrategy = 'middle' | 'head' | 'tail'

export interface ProcessToolOutputOptions {
  sessionId: string
  toolCallId: string
  fullText: string
  /** 截断策略：middle=保留首尾, head=保留末尾, tail=保留开头 */
  strategy: TruncateStrategy
  maxLines?: number
  maxBytes?: number
}

export interface ProcessToolOutputResult {
  text: string
  truncated: boolean
  persisted: boolean
  originalLines: number
  originalBytes: number
}

/** 持久化成功时的 preview 行数/字节上限 */
const PREVIEW_MAX_LINES = 200
const PREVIEW_MAX_BYTES = 10 * 1024

export function processToolOutput(opts: ProcessToolOutputOptions): ProcessToolOutputResult {
  const {
    sessionId,
    toolCallId,
    fullText,
    strategy,
    maxLines = DEFAULT_MAX_LINES,
    maxBytes = DEFAULT_MAX_BYTES
  } = opts

  const originalLines = fullText.split('\n').length
  const originalBytes = Buffer.byteLength(fullText, 'utf-8')

  // 未超限 → 直接通过
  if (originalLines <= maxLines && originalBytes <= maxBytes) {
    return { text: fullText, truncated: false, persisted: false, originalLines, originalBytes }
  }

  const header = `[Output truncated: ${originalLines} lines / ${formatSize(originalBytes)}]`

  // 超限 → 尝试持久化完整内容到磁盘
  try {
    const dir = getToolResultsDir(sessionId)
    const filePath = join(dir, `${toolCallId}.txt`)
    writeFileSync(filePath, fullText, 'utf-8')

    // 持久化成功 → 用同一 strategy 生成缩小版 preview
    const preview = applyTruncation(
      fullText,
      strategy,
      Math.min(PREVIEW_MAX_LINES, maxLines),
      Math.min(PREVIEW_MAX_BYTES, maxBytes)
    )
    const text =
      `${header}\n[Full output saved to: ${filePath}]\n[IMPORTANT: Use the Read tool (not bash) to view the full output]\n\n` +
      preview.text +
      (preview.truncated ? '\n...' : '')

    return { text, truncated: true, persisted: true, originalLines, originalBytes }
  } catch (err) {
    // 持久化失败 → 降级为纯截断
    log.warn('Failed to persist tool output', err)
    const fallback = applyTruncation(fullText, strategy, maxLines, maxBytes)
    const text = `${header}\n\n${fallback.text}`
    return { text, truncated: true, persisted: false, originalLines, originalBytes }
  }
}

function applyTruncation(
  text: string,
  strategy: TruncateStrategy,
  maxLines: number,
  maxBytes: number
): { text: string; truncated: boolean; originalLines: number; originalBytes: number } {
  switch (strategy) {
    case 'middle':
      return truncateMiddle(text, maxLines, maxBytes)
    case 'head':
      return truncateHead(text, maxLines, maxBytes)
    case 'tail':
      return truncateTail(text, maxLines, maxBytes)
  }
}
