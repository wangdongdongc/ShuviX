import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from '@mariozechner/pi-ai'
import type { Message, ImageMeta } from '../types'

/** 从图片对象中提取 raw base64：处理 data URL 格式和纯 base64 */
export function extractBase64(img: ImageMeta): string {
  if (img.data) {
    // 处理 data URL 格式（data:image/png;base64,xxxxx）→ 截取纯 base64
    if (img.data.startsWith('data:') && img.data.includes(',')) {
      return img.data.split(',')[1]
    }
    return img.data
  }
  if (typeof img.preview === 'string' && img.preview.includes(',')) {
    return img.preview.split(',')[1]
  }
  return ''
}

/**
 * 将数据库消息转换为 pi-agent-core 的 AgentMessage 格式
 * 处理 text / tool_use 等类型，跳过 system_notify 和 step 消息
 */
export function dbMessagesToAgentMessages(msgs: Message[]): AgentMessage[] {
  const result: AgentMessage[] = []
  let i = 0
  while (i < msgs.length) {
    const msg = msgs[i]

    // 跳过系统通知和中间步骤（step 纯展示，不参与 LLM 上下文）
    if (
      msg.role === 'system_notify' ||
      msg.role === 'system' ||
      msg.type === 'step_text' ||
      msg.type === 'step_thinking'
    ) {
      i++
      continue
    }

    // 用户消息（可能包含图片）
    if (msg.role === 'user') {
      let content: string | (TextContent | ImageContent)[] = msg.content
      const meta = msg.metadata
      if (meta?.images?.length) {
        content = [
          { type: 'text', text: msg.content },
          ...meta.images.map((img) => ({
            type: 'image' as const,
            data: extractBase64(img),
            mimeType: img.mimeType
          }))
        ]
      }
      const userMsg: UserMessage = { role: 'user', content, timestamp: msg.createdAt }
      result.push(userMsg)
      i++
      continue
    }

    // 助手文本消息
    if (msg.role === 'assistant' && msg.type === 'text') {
      const contentBlocks: (TextContent | ThinkingContent | ToolCall)[] = []
      const meta = msg.metadata
      if (meta) {
        if (meta.thinking) contentBlocks.push({ type: 'thinking', thinking: meta.thinking })
        if (meta.images?.length) {
          for (const img of meta.images) {
            contentBlocks.push({
              type: 'image',
              data: extractBase64(img),
              mimeType: img.mimeType,
              ...(img.thoughtSignature && { thoughtSignature: img.thoughtSignature })
            } as unknown as TextContent)
          }
        }
      }
      contentBlocks.push({ type: 'text', text: msg.content })
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: contentBlocks,
        api: 'openai-completions',
        provider: '',
        model: '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: msg.createdAt
      }
      result.push(assistantMsg)
      i++
      continue
    }

    // 新格式：tool_use（连续的 tool_use 合并为一条 AssistantMessage + 各自的 ToolResult）
    if (msg.role === 'assistant' && msg.type === 'tool_use') {
      const toolCalls: ToolCall[] = []
      const toolResults: ToolResultMessage[] = []
      const ts = msg.createdAt
      while (i < msgs.length && msgs[i].role === 'assistant' && msgs[i].type === 'tool_use') {
        const m = msgs[i]
        const meta = m.metadata
        toolCalls.push({
          type: 'toolCall',
          id: (meta?.toolCallId as string) || '',
          name: (meta?.toolName as string) || '',
          arguments: (meta?.args as Record<string, unknown>) || {}
        })
        // 有 content 说明已完成；否则为中断未完成
        if (m.content) {
          toolResults.push({
            role: 'toolResult',
            toolCallId: (meta?.toolCallId as string) || '',
            toolName: (meta?.toolName as string) || '',
            content: [{ type: 'text', text: m.content }],
            isError: (meta?.isError as boolean) || false,
            timestamp: m.createdAt
          })
        } else {
          toolResults.push({
            role: 'toolResult',
            toolCallId: (meta?.toolCallId as string) || '',
            toolName: (meta?.toolName as string) || '',
            content: [{ type: 'text', text: 'Tool execution was interrupted.' }],
            isError: true,
            timestamp: m.createdAt
          })
        }
        i++
      }
      const toolAssistantMsg: AssistantMessage = {
        role: 'assistant',
        content: toolCalls,
        api: 'openai-completions',
        provider: '',
        model: '',
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'toolUse',
        timestamp: ts
      }
      result.push(toolAssistantMsg, ...toolResults)
      continue
    }

    i++ // 未知类型跳过
  }

  return result
}
