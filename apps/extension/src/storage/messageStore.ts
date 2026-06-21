/**
 * 浏览器消息存储 —— IndexedDB 持久化 + 内存缓存 + write-behind。
 *
 * 关键约束（见 @shuvix/agent-runtime RuntimePersistence）：add* 必须**同步返回**带 id 的
 * 完整 ChatMessage（事件处理器随即 JSON.stringify 广播）。因此：同步生成 id + 构造对象 +
 * 写入内存缓存 + 异步落盘（不 await）。Side Panel 关闭即销毁，故每条消息即时落盘。
 */
import { v4 as uuid } from 'uuid'
import type {
  ChatMessage,
  AssistantTextMessage,
  ToolUseMessage,
  StepTextMessage,
  StepThinkingMessage,
  ErrorEventMessage,
  MessageMetadata,
  ToolUseMeta,
  ImageMeta,
  ToolResultDetails
} from '@shuvix/chat-protocol/types/chatMessage'
import { idb } from './idb'

let lastTs = 0
/** 严格递增时间戳，保证同毫秒内多条消息顺序稳定 */
function nextTs(): number {
  const t = Math.max(Date.now(), lastTs + 1)
  lastTs = t
  return t
}

const cache = new Map<string, ChatMessage[]>()
const loaded = new Set<string>()

function cacheOf(sessionId: string): ChatMessage[] {
  let arr = cache.get(sessionId)
  if (!arr) {
    arr = []
    cache.set(sessionId, arr)
  }
  return arr
}

/** 写入内存 + 异步落盘（write-behind，错误仅日志） */
function insert(msg: ChatMessage): ChatMessage {
  cacheOf(msg.sessionId).push(msg)
  void idb.put('messages', msg).catch((e) => console.error('[shuvix] persist message failed', e))
  return msg
}

export const messageStore = {
  /** 确保某会话历史已从 IDB 载入内存 */
  async ensureLoaded(sessionId: string): Promise<void> {
    if (loaded.has(sessionId)) return
    const rows = await idb.getAllByIndex<ChatMessage>('messages', 'by-session', sessionId)
    rows.sort((a, b) => a.createdAt - b.createdAt)
    cache.set(sessionId, rows)
    loaded.add(sessionId)
  },

  /** 同步读取缓存（须先 ensureLoaded） */
  listSync(sessionId: string): ChatMessage[] {
    return [...cacheOf(sessionId)]
  },

  async list(sessionId: string): Promise<ChatMessage[]> {
    await this.ensureLoaded(sessionId)
    return this.listSync(sessionId)
  },

  // ─── 通用构造 ───
  add(p: {
    sessionId: string
    role: 'user' | 'assistant' | 'tool' | 'system' | 'system_notify'
    type?: 'text' | 'tool_use' | 'step_text' | 'step_thinking' | 'steer' | 'error_event'
    content: string
    metadata?: MessageMetadata | null
    model?: string
  }): ChatMessage {
    const msg = {
      id: uuid(),
      sessionId: p.sessionId,
      role: p.role,
      type: p.type ?? 'text',
      content: p.content,
      metadata: p.metadata ?? null,
      model: p.model ?? '',
      createdAt: nextTs()
    } as ChatMessage
    return insert(msg)
  },

  addAssistantText(p: {
    sessionId: string
    content: string
    metadata?: MessageMetadata | null
    model: string
  }): AssistantTextMessage {
    return this.add({ ...p, role: 'assistant', type: 'text' }) as AssistantTextMessage
  },

  addToolUse(p: {
    sessionId: string
    toolCallId: string
    toolName: string
    args?: Record<string, unknown>
    turnIndex?: number
    model: string
  }): ToolUseMessage {
    const meta: ToolUseMeta = {
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      args: p.args,
      turnIndex: p.turnIndex
    }
    return this.add({
      sessionId: p.sessionId,
      role: 'assistant',
      type: 'tool_use',
      content: '',
      metadata: meta as MessageMetadata,
      model: p.model
    }) as ToolUseMessage
  },

  completeToolUse(p: {
    messageId: string
    content: string
    isError?: boolean
    details?: ToolResultDetails
  }): void {
    for (const arr of cache.values()) {
      const msg = arr.find((m) => m.id === p.messageId)
      if (msg && msg.type === 'tool_use') {
        msg.content = p.content
        const meta = (msg.metadata ?? { toolCallId: '', toolName: '' }) as ToolUseMeta
        meta.isError = p.isError
        meta.details = p.details
        msg.metadata = meta
        void idb.put('messages', msg).catch((e) => console.error('[shuvix] persist failed', e))
        return
      }
    }
  },

  addStepThinking(p: {
    sessionId: string
    content: string
    turnIndex?: number
    model: string
  }): StepThinkingMessage {
    return this.add({
      sessionId: p.sessionId,
      role: 'assistant',
      type: 'step_thinking',
      content: p.content,
      metadata: { turnIndex: p.turnIndex } as MessageMetadata,
      model: p.model
    }) as StepThinkingMessage
  },

  addStepText(p: {
    sessionId: string
    content: string
    turnIndex?: number
    images?: ImageMeta[]
    model: string
  }): StepTextMessage {
    return this.add({
      sessionId: p.sessionId,
      role: 'assistant',
      type: 'step_text',
      content: p.content,
      metadata: { turnIndex: p.turnIndex, images: p.images } as MessageMetadata,
      model: p.model
    }) as StepTextMessage
  },

  addErrorEvent(p: { sessionId: string; content: string }): ErrorEventMessage {
    return this.add({
      sessionId: p.sessionId,
      role: 'system_notify',
      type: 'error_event',
      content: p.content
    }) as ErrorEventMessage
  },

  async clear(sessionId: string): Promise<void> {
    cache.set(sessionId, [])
    await idb.deleteByIndex('messages', 'by-session', sessionId)
  },

  /** 从指定消息（含）起删除其后所有消息 */
  async deleteFrom(sessionId: string, messageId: string): Promise<void> {
    await this.ensureLoaded(sessionId)
    const arr = cacheOf(sessionId)
    const idx = arr.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const removed = arr.splice(idx)
    await Promise.all(removed.map((m) => idb.delete('messages', m.id)))
  },

  async deleteOne(sessionId: string, messageId: string): Promise<void> {
    await this.ensureLoaded(sessionId)
    const arr = cacheOf(sessionId)
    const idx = arr.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    arr.splice(idx, 1)
    await idb.delete('messages', messageId)
  }
}
