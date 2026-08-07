/**
 * AgentMessage → ChatMessage 投影 —— 把「Agent 上下文」渲染成可读的消息行。
 *
 * 迁移到 AgentHarness 后这里只剩一个方向：会话根 agent 的消息由 entry 树直接产出
 * （见 harness/projection.ts），本模块服务的是**仍以裸 `Agent` 运行的子代理** ——
 * 它们没有 Session，只有内存上下文，需要这条路径才能被 chat-protocol 的
 * transcribeConversation 转写/导出。
 *
 * 有损项仅为上下文中本就不存在的信息（消息 id / model / 指令注入标记等元数据）。
 * 纯函数，宿主无关。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AssistantMessage,
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

// 正向投影（chatMessagesToAgentMessages）已删除：迁移到 AgentHarness 后，上下文不再
// 由「DB 行重建」而来 —— Session entry 树里存的就是 AgentMessage，buildSessionContext
// 直接取出，零转换零损耗。这里只保留反向投影（供仍是裸 Agent 的子代理转写用）。

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
