/**
 * 压缩前消息预处理 — 借鉴 Claude Code 的 stripImages + microcompact 逻辑
 *
 * 1. 用户消息：图片 → [image] 占位符
 * 2. 助手消息：剥离 thinking 块、图片 → [image]
 * 3. 工具结果：图片 → [image]，文本截断到 MAX_TOOL_RESULT_CHARS
 *
 * 纯函数，操作 pi-agent-core 的 AgentMessage[] —— 桌面与扩展共用。
 */
import type {
  TextContent,
  ImageContent,
  ThinkingContent,
  ToolCall,
  UserMessage,
  AssistantMessage as PiAssistantMessage,
  ToolResultMessage
} from '@earendil-works/pi-ai'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

/** 单个工具结果的最大字符数 */
const MAX_TOOL_RESULT_CHARS = 1500
/** 截断标记 */
const TRUNCATED_MARKER = '\n... [content truncated for compaction]'

export function prepareMessagesForCompaction(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    // ── UserMessage ──
    if (msg.role === 'user') {
      const userMsg = msg as UserMessage
      if (typeof userMsg.content === 'string') return msg
      let changed = false
      const newContent = userMsg.content.map((block: TextContent | ImageContent) => {
        if (block.type === 'image') {
          changed = true
          return { type: 'text' as const, text: '[image]' }
        }
        return block
      })
      return changed ? { ...userMsg, content: newContent } : msg
    }

    // ── AssistantMessage ──
    if (msg.role === 'assistant') {
      const assistantMsg = msg as PiAssistantMessage
      let changed = false
      const filtered: (TextContent | ThinkingContent | ToolCall)[] = []
      for (const block of assistantMsg.content) {
        // 剥离 thinking 块（对总结无信息量，且很长）
        if (block.type === 'thinking') {
          changed = true
          continue
        }
        // 图片 → 占位符（通过 unknown 类型传入的 image 块）
        if ((block as unknown as { type: string }).type === 'image') {
          changed = true
          filtered.push({ type: 'text', text: '[image]' })
          continue
        }
        filtered.push(block)
      }
      return changed ? { ...assistantMsg, content: filtered } : msg
    }

    // ── ToolResultMessage ──
    if (msg.role === 'toolResult') {
      const toolMsg = msg as ToolResultMessage
      let changed = false
      const newContent = toolMsg.content.map((block: TextContent | ImageContent) => {
        // 图片 → 占位符
        if (block.type === 'image') {
          changed = true
          return { type: 'text' as const, text: '[image]' } as TextContent
        }
        // 截断过长的文本结果
        if (block.type === 'text' && block.text.length > MAX_TOOL_RESULT_CHARS) {
          changed = true
          return {
            type: 'text' as const,
            text: block.text.slice(0, MAX_TOOL_RESULT_CHARS) + TRUNCATED_MARKER
          } as TextContent
        }
        return block
      })
      return changed ? { ...toolMsg, content: newContent } : msg
    }

    return msg
  })
}
