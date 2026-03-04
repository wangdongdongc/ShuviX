/**
 * 上下文管理器 — 在每次 LLM 调用前自动压缩历史上下文，防止 token 爆炸
 *
 * 利用 pi-agent-core 的 transformContext 钩子。
 *
 * 两层渐进压缩策略：
 *   1. 延迟压缩旧 toolResult 内容（仅当 token 超过 60% 上下文窗口时触发，
 *      压缩后原地修改 agent.state.messages 以维持缓存前缀稳定性）
 *   2. 滑动窗口截断（兜底，仅超过 75% 时执行，返回新数组不修改原始消息列表）
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { Api, Model, TextContent } from '@mariozechner/pi-ai'
import { createLogger } from '../logger'
import { isToolResultMessage } from '../utils/messageGuards'
import { countAllTokens, countMessageTokens } from '../utils/tokenCounter'
import { KEEP_RECENT_TURNS } from '../../shared/constants'

const log = createLogger('Context')

// ─── 可调常量 ───────────────────────────────────────────────

/** 上下文窗口使用比例（留余量给 system prompt + 输出 + 安全边际） */
const CONTEXT_RATIO = 0.75

/** 第一层压缩触发比例 — 仅当 token 超过此比例才开始压缩旧 toolResult */
const COMPRESSION_TRIGGER_RATIO = 0.6

/** 滑动窗口兜底时保留的最近消息条数（包括 user/assistant/toolResult） */
const KEEP_RECENT_MESSAGES = 20

/** 压缩后保留的 toolResult 头部行数 */
const SUMMARY_HEAD_LINES = 3

/** 压缩后保留的 toolResult 尾部行数 */
const SUMMARY_TAIL_LINES = 2

/** 已压缩标记（用于幂等检测，避免二次压缩） */
const COMPRESSED_MARKER = '[... 已省略'

// ─── 第一层：按 turn 分组延迟压缩旧 toolResult ──────────────────

/** 将 toolResult 内容压缩为摘要（保留头尾几行） */
function summarizeToolResult(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= SUMMARY_HEAD_LINES + SUMMARY_TAIL_LINES + 1) {
    return text // 内容本身就很短，无需压缩
  }

  const head = lines.slice(0, SUMMARY_HEAD_LINES).join('\n')
  const tail = lines.slice(-SUMMARY_TAIL_LINES).join('\n')
  const omitted = lines.length - SUMMARY_HEAD_LINES - SUMMARY_TAIL_LINES
  return `${head}\n[... 已省略 ${omitted} 行，原始 ${text.length} 字符 ...]\n${tail}`
}

/**
 * 识别消息数组中的工具 turn
 * 每组连续的 toolResult 消息视为一个 turn（对应一次 LLM 调用 + 工具执行）
 * 返回每个 turn 包含的 toolResult 消息索引数组
 */
function identifyToolTurns(messages: AgentMessage[]): Array<number[]> {
  const turns: Array<number[]> = []
  let currentTurn: number[] = []

  for (let i = 0; i < messages.length; i++) {
    if (isToolResultMessage(messages[i])) {
      currentTurn.push(i)
    } else {
      if (currentTurn.length > 0) {
        turns.push(currentTurn)
        currentTurn = []
      }
    }
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn)
  }

  return turns
}

/**
 * 原地压缩旧 toolResult 消息（直接修改 agent.state.messages 中的对象）
 *
 * 与旧版 compressToolResults 的关键区别：
 * - 直接修改原始消息对象的 content[].text，而非创建副本
 * - 压缩后内容在后续 LLM 调用中保持稳定，维持前缀缓存一致性
 * - 幂等：已压缩的块（含 COMPRESSED_MARKER）不会被二次压缩
 */
function compressToolResultsInPlace(messages: AgentMessage[]): void {
  const turns = identifyToolTurns(messages)

  if (turns.length <= KEEP_RECENT_TURNS) return

  const turnsToCompress = turns.slice(0, -KEEP_RECENT_TURNS)
  const compressSet = new Set<number>()
  for (const turn of turnsToCompress) {
    for (const idx of turn) {
      compressSet.add(idx)
    }
  }

  let compressedCount = 0
  for (const idx of compressSet) {
    const msg = messages[idx]
    if (!isToolResultMessage(msg)) continue

    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j] as TextContent
      if (block.type === 'text' && block.text && block.text.length > 500) {
        // 幂等守卫：跳过已压缩的块
        if (block.text.includes(COMPRESSED_MARKER)) continue
        compressedCount++
        // 原地修改 text 属性
        block.text = summarizeToolResult(block.text)
      }
    }
  }

  if (compressedCount > 0) {
    log.info(
      `第一层（原地）：压缩了 ${turnsToCompress.length} 个旧 turn 中的 ${compressedCount} 个 toolResult（保留最近 ${KEEP_RECENT_TURNS} 个 turn）`
    )
  }
}

// ─── 第二层：滑动窗口截断 ─────────────────────────────────────

/**
 * 滑动窗口截断（兜底）
 * 保留第一条 user 消息（任务上下文）+ 最近 N 条消息，丢弃中间部分
 * 返回新数组，不修改原始消息列表（避免破坏 agent 的工具关联）
 */
function slidingWindowTruncate(messages: AgentMessage[], maxTokens: number): AgentMessage[] {
  if (messages.length <= KEEP_RECENT_MESSAGES + 1) return messages

  let currentTokens = countAllTokens(messages)
  if (currentTokens <= maxTokens) return messages

  // 始终保留：第一条 user 消息 + 最近 KEEP_RECENT_MESSAGES 条
  // 从第二条消息开始逐条丢弃，直到 token 降到阈值以下
  const safeEnd = messages.length - KEEP_RECENT_MESSAGES
  const dropIndices = new Set<number>()

  for (let i = 1; i < safeEnd; i++) {
    if (currentTokens <= maxTokens) break
    currentTokens -= countMessageTokens(messages[i])
    dropIndices.add(i)
  }

  if (dropIndices.size === 0) return messages

  log.info(`第二层：丢弃 ${dropIndices.size} 条消息，剩余约 ${currentTokens} tokens`)
  return messages.filter((_, i) => !dropIndices.has(i))
}

// ─── 对外接口 ───────────────────────────────────────────────

/**
 * 创建 transformContext 函数，传入 Agent 构造器
 * 每次 LLM 调用前自动执行两层压缩：
 *   - 第一层：仅在 token 超过 60% 上下文窗口时触发，原地压缩旧 toolResult
 *     （短对话不压缩 → 前缀缓存完美命中）
 *   - 第二层：仅在超过 75% 上下文窗口阈值时执行滑动窗口截断（有损，丢弃旧消息）
 */
export function createTransformContext(
  model: Model<Api>
): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const contextWindow = model.contextWindow || 128000
    const maxTokens = Math.floor(contextWindow * CONTEXT_RATIO)
    const compressionTrigger = Math.floor(contextWindow * COMPRESSION_TRIGGER_RATIO)
    const originalTokens = countAllTokens(messages)

    log.info(
      `transformContext: ${messages.length} 条消息, ${originalTokens} tokens (压缩阈值 ${compressionTrigger}, 窗口阈值 ${maxTokens})`
    )

    // 第一层：延迟压缩 — 仅在 token 超过触发阈值时才压缩旧 toolResult
    // 短对话完全不压缩，前缀缓存可以正常工作
    if (originalTokens > compressionTrigger) {
      compressToolResultsInPlace(messages)
      const afterTokens = countAllTokens(messages)
      if (afterTokens < originalTokens) {
        log.info(
          `延迟压缩：${originalTokens} → ${afterTokens} tokens（节省 ${originalTokens - afterTokens}）`
        )
      }

      // 第二层：仅在压缩后仍超过窗口阈值时执行滑动窗口截断（有损）
      if (afterTokens > maxTokens) {
        const truncated = slidingWindowTruncate(messages, maxTokens)
        const finalTokens = countAllTokens(truncated)
        log.info(`滑动窗口截断：${afterTokens} → ${finalTokens} tokens`)
        return truncated
      }
    }

    return messages
  }
}
