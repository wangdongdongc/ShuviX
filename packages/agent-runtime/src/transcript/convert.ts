/**
 * ChatMessage ↔ AgentMessage 双向投影 —— 「存储行」与「Agent 上下文」两个世界的共享桥。
 *
 * 正向 chatMessagesToAgentMessages（原桌面 dbMessagesToAgentMessages 上移共享）：
 *   会话历史恢复进 Agent 上下文（桌面 ensureAgentSession / 扩展 ensureRuntimeSession 共用，
 *   两端同一保真度：文本 + thinking + 图片 + 工具轨迹；system_notify / step 不进上下文）。
 *
 * 反向 agentMessagesToChatMessages（新增）：
 *   任意 Agent（根会话 / 派生临时 agent）的上下文投影为 ChatMessage 行，使 chat-protocol
 *   的全部 ChatMessage 能力（transcribeConversation 转写、导出、归纳…）对 agent 对象生效。
 *   有损项仅为上下文中本就不存在的信息（消息 id / model / 指令注入标记等元数据）。
 *
 * 均为纯函数，宿主无关。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from '@earendil-works/pi-ai'
import type {
  ChatMessage,
  ImageMeta,
  MessageMetadata
} from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'

/** 扁平行视角（规避 ChatMessage 判别联合在逐字段访问时的收窄噪音；字段与 DAO 行一致） */
interface FlatRow {
  id: string
  sessionId: string
  role: string
  type: string
  content: string
  metadata: MessageMetadata | null
  model: string
  createdAt: number
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
 * 将存储的会话消息转换为 pi-agent-core 的 AgentMessage 格式（上下文恢复）。
 * 处理 text / tool_use 等类型，跳过 system_notify 和 step 消息。
 */
export function chatMessagesToAgentMessages(msgs: ChatMessage[]): AgentMessage[] {
  const rows = msgs as unknown as FlatRow[]
  const result: AgentMessage[] = []
  let i = 0
  while (i < rows.length) {
    const msg = rows[i]

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

    // 用户消息（可能包含图片和/或内联 token）
    if (msg.role === 'user') {
      // 使用存储的 token payload 替换标记，确保 Agent 重启后上下文正确
      const resolvedText = resolveTokensForAgent(msg.content, msg.metadata?.inlineTokens)
      let content: string | (TextContent | ImageContent)[] = resolvedText
      const meta = msg.metadata
      if (meta?.images?.length) {
        content = [
          { type: 'text', text: resolvedText },
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
              ...((img as { thoughtSignature?: string }).thoughtSignature && {
                thoughtSignature: (img as { thoughtSignature?: string }).thoughtSignature
              })
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

    // tool_use：连续的 tool_use 合并为一条 AssistantMessage + 各自的 ToolResult
    if (msg.role === 'assistant' && msg.type === 'tool_use') {
      const toolCalls: ToolCall[] = []
      const toolResults: ToolResultMessage[] = []
      const ts = msg.createdAt
      while (i < rows.length && rows[i].role === 'assistant' && rows[i].type === 'tool_use') {
        const m = rows[i]
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
      result.push(toolAssistantMsg, ...toolResults)
      continue
    }

    i++ // 未知类型跳过
  }

  return result
}

/**
 * 将 Agent 上下文消息反向投影为 ChatMessage 行（合成 id：ctx-N；createdAt 取消息自带 timestamp）。
 * toolCall 与后续 toolResult 按 toolCallId 配对合并为 tool_use 行；孤儿 toolResult 兜底为独立行。
 */
export function agentMessagesToChatMessages(
  messages: AgentMessage[],
  opts?: { sessionId?: string }
): ChatMessage[] {
  const sessionId = opts?.sessionId ?? ''
  const out: FlatRow[] = []
  let seq = 0
  const nextId = (): string => `ctx-${++seq}`
  /** 已产出的 tool_use 行，等待 toolResult 回填内容（按 toolCallId） */
  const pendingTools = new Map<string, FlatRow>()

  for (const msg of messages) {
    if (msg.role === 'user') {
      const u = msg as UserMessage
      let text: string
      let images: ImageMeta[] | undefined
      if (typeof u.content === 'string') {
        text = u.content
      } else {
        const texts: string[] = []
        for (const block of u.content) {
          if (block.type === 'text') texts.push(block.text)
          else if (block.type === 'image') {
            ;(images ??= []).push({ mimeType: block.mimeType } as ImageMeta)
          }
        }
        text = texts.join('\n')
      }
      out.push({
        id: nextId(),
        sessionId,
        role: 'user',
        type: 'text',
        content: text,
        metadata: images ? { images } : null,
        model: '',
        createdAt: u.timestamp ?? 0
      })
      continue
    }

    if (msg.role === 'assistant') {
      const a = msg as AssistantMessage
      const blocks: (TextContent | ThinkingContent | ToolCall)[] =
        typeof a.content === 'string' ? [{ type: 'text', text: a.content }] : a.content
      const texts: string[] = []
      let thinking = ''
      let images: ImageMeta[] | undefined
      const toolRows: FlatRow[] = []
      for (const block of blocks) {
        if (block.type === 'text') {
          texts.push(block.text)
        } else if (block.type === 'thinking') {
          thinking += (thinking ? '\n' : '') + block.thinking
        } else if (block.type === 'toolCall') {
          const row: FlatRow = {
            id: nextId(),
            sessionId,
            role: 'assistant',
            type: 'tool_use',
            content: '',
            metadata: {
              toolCallId: block.id,
              toolName: block.name,
              args: (block.arguments as Record<string, unknown>) || {}
            },
            model: '',
            createdAt: a.timestamp ?? 0
          }
          toolRows.push(row)
          if (block.id) pendingTools.set(block.id, row)
        } else if ((block as { type: string }).type === 'image') {
          const img = block as unknown as { mimeType?: string }
          ;(images ??= []).push({ mimeType: img.mimeType ?? 'image/png' } as ImageMeta)
        }
      }
      if (texts.length > 0 || thinking || images) {
        const meta: MessageMetadata = {}
        if (thinking) meta.thinking = thinking
        if (images) meta.images = images
        out.push({
          id: nextId(),
          sessionId,
          role: 'assistant',
          type: 'text',
          content: texts.join('\n'),
          metadata: thinking || images ? meta : null,
          model: a.model || '',
          createdAt: a.timestamp ?? 0
        })
      }
      out.push(...toolRows)
      continue
    }

    if (msg.role === 'toolResult') {
      const t = msg as ToolResultMessage
      const text = t.content
        .map((block) => (block.type === 'image' ? '[image]' : block.text))
        .join('\n')
      const row = t.toolCallId ? pendingTools.get(t.toolCallId) : undefined
      if (row) {
        row.content = text
        if (t.isError) (row.metadata as MessageMetadata).isError = true
        pendingTools.delete(t.toolCallId)
      } else {
        // 孤儿结果（上下文被裁剪等）：兜底为独立 tool_use 行，不丢内容
        out.push({
          id: nextId(),
          sessionId,
          role: 'assistant',
          type: 'tool_use',
          content: text,
          metadata: {
            toolCallId: t.toolCallId || '',
            toolName: t.toolName || '',
            isError: t.isError
          },
          model: '',
          createdAt: t.timestamp ?? 0
        })
      }
      continue
    }

    // 未知角色跳过
  }

  return out as unknown as ChatMessage[]
}
