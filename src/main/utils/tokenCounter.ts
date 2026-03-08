/**
 * Token 计数工具 — 基于 tiktoken 的 token 估算
 */

import { encodingForModel } from 'js-tiktoken'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { isAssistantMessage, isToolResultMessage, isUserMessage } from './messageGuards'

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
export function countMessageTokens(msg: AgentMessage): number {
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
