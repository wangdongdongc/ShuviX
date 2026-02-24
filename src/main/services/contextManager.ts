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
import type { Model } from '@mariozechner/pi-ai'
import { createLogger } from '../logger'

const log = createLogger('Context')

// ─── 可调常量 ───────────────────────────────────────────────

/** 保留最近 N 个 toolResult 消息的完整内容不压缩 */
const KEEP_RECENT_TOOL_RESULTS = 6


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

/** 计算单条 AgentMessage 的 token 数 */
function countMessageTokens(msg: AgentMessage): number {
  if (!msg || typeof msg !== 'object' || !('role' in msg)) return 0

  const m = msg as any
  // 固定开销：role + 结构化元数据
  let tokens = 4

  if (m.role === 'user') {
    if (typeof m.content === 'string') {
      tokens += countTextTokens(m.content)
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text') tokens += countTextTokens(block.text)
        // 图片按固定 token 估算（与 OpenAI vision 定价一致）
        if (block.type === 'image') tokens += 85
      }
    }
  } else if (m.role === 'assistant') {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text') tokens += countTextTokens(block.text)
        if (block.type === 'thinking') tokens += countTextTokens(block.thinking)
        if (block.type === 'toolCall') {
          tokens += countTextTokens(block.name)
          tokens += countTextTokens(JSON.stringify(block.arguments))
        }
      }
    }
  } else if (m.role === 'toolResult') {
    tokens += countTextTokens(m.toolName || '')
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
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

// ─── 第一层：压缩旧 toolResult ──────────────────────────────

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
 * 压缩旧的 toolResult 消息
 * 按消息在数组中的倒数位置判断：保留最近 N 个 toolResult 不压缩，其余全部压缩
 */
function compressToolResults(messages: AgentMessage[]): AgentMessage[] {
  // 收集所有 toolResult 消息的索引
  const toolResultIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if ((messages[i] as any).role === 'toolResult') {
      toolResultIndices.push(i)
    }
  }

  if (toolResultIndices.length <= KEEP_RECENT_TOOL_RESULTS) return messages

  // 需要压缩的 toolResult 索引集合（排除最近 N 个）
  const compressSet = new Set(toolResultIndices.slice(0, -KEEP_RECENT_TOOL_RESULTS))

  let compressedCount = 0
  const result: AgentMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as any
    if (compressSet.has(i)) {
      // 深拷贝并压缩 content
      const compressed = { ...msg, content: [] as any[] }
      if (Array.isArray(msg.content)) {
        compressed.content = msg.content.map((block: any) => {
          if (block.type === 'text' && block.text && block.text.length > 500) {
            compressedCount++
            return { type: 'text', text: summarizeToolResult(block.text) }
          }
          return block
        })
      }
      result.push(compressed as AgentMessage)
    } else {
      result.push(msg)
    }
  }

  if (compressedCount > 0) {
    log.info(`第一层：压缩了 ${compressedCount} 个旧 toolResult`)
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
  model: Model<any>
): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const maxTokens = Math.floor((model.contextWindow || 128000) * CONTEXT_RATIO)
    const originalTokens = countAllTokens(messages)

    log.info(`transformContext: ${messages.length} 条消息, ${originalTokens} tokens (阈值 ${maxTokens})`)

    // 第一层：始终压缩旧 toolResult（近乎无损，高收益）
    let compressed = compressToolResults(messages)

    const afterBasicTokens = countAllTokens(compressed)
    if (afterBasicTokens < originalTokens) {
      log.info(`基础压缩：${originalTokens} → ${afterBasicTokens} tokens（节省 ${originalTokens - afterBasicTokens}）`)
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
