/**
 * 上下文管理器 — 在每次 LLM 调用前自动压缩历史上下文，防止 token 爆炸
 *
 * 利用 pi-agent-core 的 transformContext 钩子，仅修改发送给 LLM 的副本，
 * 不影响 agent.state.messages 原始数据和 DB 持久化数据。
 *
 * 三层渐进压缩策略：
 *   1. 压缩旧 toolResult 内容（高收益）
 *   2. 移除旧 thinking 内容
 *   3. 滑动窗口截断（兜底）
 */

import { encodingForModel } from 'js-tiktoken'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
  ToolResultMessage,
  UserMessage
} from '@mariozechner/pi-ai'
import { createLogger } from '../logger'
import { KEEP_RECENT_TURNS } from '../../shared/constants'

const log = createLogger('Context')

// ─── 可调常量 ───────────────────────────────────────────────

/** 上下文窗口使用比例（留余量给 system prompt + 输出 + 安全边际） */
const CONTEXT_RATIO = 0.75

/** 滑动窗口兜底时保留的最近消息条数（包括 user/assistant/toolResult） */
const KEEP_RECENT_MESSAGES = 20

/** 压缩后保留的 toolResult 头部行数 */
const SUMMARY_HEAD_LINES = 3

/** 压缩后保留的 toolResult 尾部行数 */
const SUMMARY_TAIL_LINES = 2

// ─── Token 计数 ─────────────────────────────────────────────

/** 懒加载的 tiktoken 编码器实例（cl100k_base，兼容 GPT-4 / Claude / Gemini） */
let encoder: ReturnType<typeof encodingForModel> | null = null

function getEncoder(): ReturnType<typeof encodingForModel> {
  if (!encoder) {
    encoder = encodingForModel('gpt-4o')
  }
  return encoder
}

/** 计算单段文本的 token 数 */
export function countTextTokens(text: string): number {
  if (!text) return 0
  try {
    return getEncoder().encode(text).length
  } catch {
    // 编码失败时降级为字符估算
    return Math.ceil(text.length / 3)
  }
}

function isUserMessage(msg: AgentMessage): msg is UserMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'user'
}

function isAssistantMessage(msg: AgentMessage): msg is AssistantMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'assistant'
}

function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'toolResult'
}

/** 计算单条 AgentMessage 的 token 数 */
function countMessageTokens(msg: AgentMessage): number {
  if (!msg || typeof msg !== 'object' || !('role' in msg)) return 0

  // 固定开销：role + 结构化元数据
  let tokens = 4

  if (isUserMessage(msg)) {
    if (typeof msg.content === 'string') {
      tokens += countTextTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') tokens += countTextTokens(block.text)
        // 图片按固定 token 估算（与 OpenAI vision 定价一致）
        if (block.type === 'image') tokens += 85
      }
    }
  } else if (isAssistantMessage(msg)) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') tokens += countTextTokens(block.text)
        if (block.type === 'thinking') tokens += countTextTokens(block.thinking)
        if (block.type === 'toolCall') {
          tokens += countTextTokens(block.name)
          tokens += countTextTokens(JSON.stringify(block.arguments))
        }
      }
    }
  } else if (isToolResultMessage(msg)) {
    tokens += countTextTokens(msg.toolName || '')
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') tokens += countTextTokens(block.text)
      }
    }
  }

  return tokens
}

/** 计算消息数组的总 token 数 */
export function countAllTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += countMessageTokens(msg)
  }
  return total
}

// ─── 第一层：按 turn 分组压缩旧 toolResult ──────────────────

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
 * 按 turn 分组压缩旧的 toolResult 消息
 * 保留最近 KEEP_RECENT_TURNS 个 turn 的 toolResult 完整，其余全部压缩
 */
function compressToolResults(messages: AgentMessage[]): AgentMessage[] {
  const turns = identifyToolTurns(messages)

  if (turns.length <= KEEP_RECENT_TURNS) return messages

  // 需要压缩的 turn（排除最近 N 个 turn）
  const turnsToCompress = turns.slice(0, -KEEP_RECENT_TURNS)
  const compressSet = new Set<number>()
  for (const turn of turnsToCompress) {
    for (const idx of turn) {
      compressSet.add(idx)
    }
  }

  let compressedCount = 0
  const result: AgentMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (compressSet.has(i) && isToolResultMessage(msg)) {
      const compressedContent = msg.content.map(
        (block: TextContent | import('@mariozechner/pi-ai').ImageContent) => {
          if (block.type === 'text' && block.text && block.text.length > 500) {
            compressedCount++
            return { type: 'text' as const, text: summarizeToolResult(block.text) }
          }
          return block
        }
      )
      const compressed: ToolResultMessage = { ...msg, content: compressedContent }
      result.push(compressed)
    } else {
      result.push(msg)
    }
  }

  if (compressedCount > 0) {
    log.info(
      `第一层：压缩了 ${turnsToCompress.length} 个旧 turn 中的 ${compressedCount} 个 toolResult（保留最近 ${KEEP_RECENT_TURNS} 个 turn）`
    )
  }
  return result
}

// ─── 第二层：滑动窗口截断 ─────────────────────────────────────

/**
 * 滑动窗口截断（兜底）
 * 保留第一条 user 消息（任务上下文）+ 最近 N 条消息，丢弃中间部分
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

  log.info(`第三层：丢弃 ${dropIndices.size} 条消息，剩余约 ${currentTokens} tokens`)
  return messages.filter((_, i) => !dropIndices.has(i))
}

// ─── 对外接口 ───────────────────────────────────────────────

/**
 * 创建 transformContext 函数，传入 Agent 构造器
 * 每次 LLM 调用前自动执行三层压缩：
 *   - 第一层、第二层始终执行（近乎无损，大幅减少每次调用的 token 数）
 *   - 第三层仅在超过上下文窗口阈值时执行（有损，丢弃旧消息）
 */
export function createTransformContext(
  model: Model<Api>
): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const maxTokens = Math.floor((model.contextWindow || 128000) * CONTEXT_RATIO)
    const originalTokens = countAllTokens(messages)

    log.info(
      `transformContext: ${messages.length} 条消息, ${originalTokens} tokens (阈值 ${maxTokens})`
    )

    // 第一层：始终压缩旧 toolResult（近乎无损，高收益）
    let compressed = compressToolResults(messages)

    const afterBasicTokens = countAllTokens(compressed)
    if (afterBasicTokens < originalTokens) {
      log.info(
        `基础压缩：${originalTokens} → ${afterBasicTokens} tokens（节省 ${originalTokens - afterBasicTokens}）`
      )
    }

    // 第二层：仅在超过阈值时执行滑动窗口截断（有损）
    if (afterBasicTokens > maxTokens) {
      compressed = slidingWindowTruncate(compressed, maxTokens)
      const finalTokens = countAllTokens(compressed)
      log.info(`滑动窗口截断：${afterBasicTokens} → ${finalTokens} tokens`)
    }

    return compressed
  }
}
