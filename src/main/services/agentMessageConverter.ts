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
import type { Message } from '../types'

interface ImageMeta {
  data?: string
  preview?: string
  mimeType: string
  thoughtSignature?: string
}

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
 * 处理 text / tool_call / tool_result 等类型，跳过 system_notify
 */
export function dbMessagesToAgentMessages(msgs: Message[]): AgentMessage[] {
  const result: AgentMessage[] = []
  let i = 0
  while (i < msgs.length) {
    const msg = msgs[i]

    // 跳过系统通知
    if (msg.role === 'system_notify' || msg.role === 'system') {
      i++
      continue
    }

    // 用户消息（可能包含图片）
    if (msg.role === 'user') {
      let content: string | (TextContent | ImageContent)[] = msg.content
      if (msg.metadata) {
        try {
          const meta: { images?: ImageMeta[] } = JSON.parse(msg.metadata)
          if (meta.images?.length) {
            content = [
              { type: 'text', text: msg.content },
              ...meta.images.map((img: ImageMeta) => ({
                type: 'image' as const,
                data: extractBase64(img),
                mimeType: img.mimeType
              }))
            ]
          }
        } catch {
          /* 忽略 */
        }
      }
      const userMsg: UserMessage = { role: 'user', content, timestamp: msg.createdAt }
      result.push(userMsg)
      i++
      continue
    }

    // 助手文本消息
    if (msg.role === 'assistant' && msg.type === 'text') {
      const contentBlocks: (TextContent | ThinkingContent | ToolCall)[] = []
      if (msg.metadata) {
        try {
          const meta: { thinking?: string; images?: ImageMeta[] } = JSON.parse(msg.metadata)
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
        } catch {
          /* 忽略 */
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

    // 助手工具调用（连续的 tool_call 合并为一条 AssistantMessage）
    if (msg.role === 'assistant' && msg.type === 'tool_call') {
      const toolCalls: ToolCall[] = []
      const ts = msg.createdAt
      while (i < msgs.length && msgs[i].role === 'assistant' && msgs[i].type === 'tool_call') {
        const meta: Record<string, unknown> = msgs[i].metadata ? JSON.parse(msgs[i].metadata!) : {}
        toolCalls.push({
          type: 'toolCall',
          id: (meta.toolCallId as string) || '',
          name: (meta.toolName as string) || '',
          arguments: (meta.args as Record<string, unknown>) || {}
        })
        i++
      }
      const toolAssistantMsg: AssistantMessage = {
        role: 'assistant',
        content: toolCalls,
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
        stopReason: 'toolUse',
        timestamp: ts
      }
      result.push(toolAssistantMsg)
      continue
    }

    // 工具结果消息
    if (msg.role === 'tool' && msg.type === 'tool_result') {
      const meta: Record<string, unknown> = msg.metadata ? JSON.parse(msg.metadata) : {}
      const toolResultMsg: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: (meta.toolCallId as string) || '',
        toolName: (meta.toolName as string) || '',
        content: [{ type: 'text', text: msg.content }],
        isError: (meta.isError as boolean) || false,
        timestamp: msg.createdAt
      }
      result.push(toolResultMsg)
      i++
      continue
    }

    i++ // 未知类型跳过
  }

  // 后处理：修补中断导致的消息结构异常
  // 场景1：abort 时 persistStreamBuffer 在 tool_call 和 tool_result 之间插入了 assistant text
  // 场景2：tool_execution_end 未触发，tool_call 没有对应的 tool_result（孤儿 tool_call）
  return repairToolCallPairing(result)
}

/**
 * 修补 tool_call / tool_result 配对：
 * - 跳过夹在 tool_call 和 tool_result 之间的 assistant text（abort 遗留）
 * - 为缺失 tool_result 的 tool_call 补充合成的 error tool_result
 */
function repairToolCallPairing(messages: AgentMessage[]): AgentMessage[] {
  const repaired: AgentMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    // 非 toolCall assistant 消息直接保留
    const isAssistant = 'role' in msg && msg.role === 'assistant'
    const toolCalls: ToolCall[] =
      isAssistant && 'content' in msg && Array.isArray(msg.content)
        ? (msg.content as (TextContent | ThinkingContent | ToolCall)[]).filter(
            (c): c is ToolCall => c.type === 'toolCall'
          )
        : []
    if (toolCalls.length === 0) {
      repaired.push(msg)
      continue
    }

    // 找到一条包含 toolCall 的 assistant 消息 → 收集对应的 toolResult
    repaired.push(msg)
    const pendingIds = new Set<string>(toolCalls.map((tc: ToolCall) => tc.id))
    let j = i + 1
    // 向前扫描：收集匹配的 toolResult，跳过夹在中间的 assistant text（abort 遗留）
    while (j < messages.length && pendingIds.size > 0) {
      const next = messages[j]
      const nextRole = 'role' in next ? next.role : undefined
      if (
        nextRole === 'toolResult' &&
        'toolCallId' in next &&
        pendingIds.has((next as ToolResultMessage).toolCallId)
      ) {
        repaired.push(next)
        pendingIds.delete((next as ToolResultMessage).toolCallId)
        j++
      } else if (nextRole === 'toolResult') {
        repaired.push(next)
        j++
      } else if (nextRole === 'assistant') {
        // 跳过 abort 时 persistStreamBuffer 遗留的 assistant text（不加入 repaired）
        j++
      } else {
        // 遇到 user 消息等，停止扫描
        break
      }
    }
    // 为缺失的 toolResult 补充合成记录（标记为 error）
    for (const id of pendingIds) {
      const tc = toolCalls.find((c: ToolCall) => c.id === id)
      const syntheticResult: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: id,
        toolName: tc?.name || '',
        content: [{ type: 'text', text: 'Tool execution was interrupted.' }],
        isError: true,
        timestamp: Date.now()
      }
      repaired.push(syntheticResult)
    }
    i = j - 1 // 跳过已处理的消息
  }
  return repaired
}
