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
  AssistantMessage as ChatAssistantMessage,
  AssistantBlock,
  AssistantToolBlock,
  ChatMessage,
  ImageMeta
} from '@shuvix/chat-protocol/types/chatMessage'

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
 * 将 Agent 上下文消息反向投影为 ChatMessage（合成 id：ctx-N；createdAt 取消息自带 timestamp）。
 * 与 harness/projection 同构：一条 AgentMessage = 一条 ChatMessage，thinking/text/toolCall
 * 成为它的 blocks；toolResult 按 toolCallId 回填到工具块上，孤儿结果兜底为独立消息。
 */
export function agentMessagesToChatMessages(
  messages: AgentMessage[],
  opts?: { sessionId?: string }
): ChatMessage[] {
  const sessionId = opts?.sessionId ?? ''
  const out: ChatMessage[] = []
  let seq = 0
  const nextId = (): string => `ctx-${++seq}`
  /** 已产出的工具块，等待 toolResult 回填结果（按 toolCallId） */
  const pendingTools = new Map<string, AssistantToolBlock>()

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
      const content: (TextContent | ThinkingContent | ToolCall)[] =
        typeof a.content === 'string' ? [{ type: 'text', text: a.content }] : a.content
      const blocks: AssistantBlock[] = []
      const texts: string[] = []
      let images: ImageMeta[] | undefined
      for (const block of content) {
        if (block.type === 'text') {
          blocks.push({ type: 'text', text: block.text })
          texts.push(block.text)
        } else if (block.type === 'thinking') {
          blocks.push({ type: 'thinking', text: block.thinking })
        } else if (block.type === 'toolCall') {
          const tool: AssistantToolBlock = {
            type: 'tool',
            toolCallId: block.id,
            toolName: block.name,
            args: (block.arguments as Record<string, unknown>) || {}
          }
          blocks.push(tool)
          if (block.id) pendingTools.set(block.id, tool)
        } else if ((block as { type: string }).type === 'image') {
          const img = block as unknown as { mimeType?: string }
          ;(images ??= []).push({ mimeType: img.mimeType ?? 'image/png' } as ImageMeta)
        }
      }
      if (blocks.length === 0 && !images) continue
      out.push({
        id: nextId(),
        sessionId,
        role: 'assistant',
        type: 'message',
        blocks,
        content: texts.join('\n'),
        metadata: images ? { images } : null,
        model: a.model || '',
        createdAt: a.timestamp ?? 0
      })
      continue
    }

    if (msg.role === 'toolResult') {
      const t = msg as ToolResultMessage
      const text = t.content
        .map((block) => (block.type === 'image' ? '[image]' : block.text))
        .join('\n')
      const tool = t.toolCallId ? pendingTools.get(t.toolCallId) : undefined
      if (tool) {
        tool.result = text
        if (t.isError) tool.isError = true
        pendingTools.delete(t.toolCallId)
      } else {
        // 孤儿结果（上下文被裁剪等）：兜底为一条只含该工具块的助手消息，不丢内容
        const orphan: ChatAssistantMessage = {
          id: nextId(),
          sessionId,
          role: 'assistant',
          type: 'message',
          blocks: [
            {
              type: 'tool',
              toolCallId: t.toolCallId || '',
              toolName: t.toolName || '',
              result: text,
              isError: t.isError
            }
          ],
          content: '',
          metadata: null,
          model: '',
          createdAt: t.timestamp ?? 0
        }
        out.push(orphan)
      }
      continue
    }

    // 未知角色跳过
  }

  return out
}
