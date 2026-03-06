import { v7 as uuidv7 } from 'uuid'
import { messageDao, messageStepDao } from '../dao/messageDao'
import { sessionDao } from '../dao/sessionDao'
import { getOperationContext } from '../frontend/core/OperationContext'
import type { Message, MessageMetadata, MessageType } from '../types'
import type {
  ChatMessage,
  UserTextMessage,
  AssistantTextMessage,
  ToolCallMessage,
  ToolResultMessage,
  ToolResultDetails,
  StepTextMessage,
  StepThinkingMessage,
  DockerEventMessage,
  SshEventMessage,
  ErrorEventMessage,
  ImageMeta
} from '../types'
import { narrowMessage } from '../types'

/** 路由到 message_steps 的消息类型 */
const STEP_TYPES = new Set(['tool_call', 'tool_result', 'step_text', 'step_thinking'])

/** 归并两个按 createdAt 升序的数组，相同时间戳用 id 字典序作 tiebreaker */
function mergeSorted(a: Message[], b: Message[]): Message[] {
  const result: Message[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (
      a[i].createdAt < b[j].createdAt ||
      (a[i].createdAt === b[j].createdAt && a[i].id <= b[j].id)
    ) {
      result.push(a[i++])
    } else {
      result.push(b[j++])
    }
  }
  while (i < a.length) result.push(a[i++])
  while (j < b.length) result.push(b[j++])
  return result
}

/**
 * 消息服务 — 编排消息相关的业务逻辑
 * 主消息存 messages 表，工具调用/结果存 message_steps 表
 * 对外提供统一的合并视图
 */
export class MessageService {
  /** 获取会话的所有消息（合并 messages + message_steps，按时间排序） */
  listBySession(sessionId: string): ChatMessage[] {
    const primary = messageDao.findBySessionId(sessionId)
    const steps = messageStepDao.findBySessionId(sessionId)
    const merged =
      steps.length === 0 ? primary : primary.length === 0 ? steps : mergeSorted(primary, steps)
    return merged.map(narrowMessage)
  }

  /** 添加消息（按类型路由到对应的表，同时更新会话时间戳） */
  add(params: {
    sessionId: string
    role: 'user' | 'assistant' | 'tool' | 'system' | 'system_notify'
    type?: MessageType
    content: string
    metadata?: MessageMetadata | null
    model?: string
  }): Message {
    // 对 user 消息，自动注入来源信息到 metadata（非 electron 来源时）
    let metadata: MessageMetadata | null = params.metadata ?? null
    if (params.role === 'user') {
      const ctx = getOperationContext()
      if (ctx && ctx.source.type !== 'electron') {
        const existing: MessageMetadata = metadata ?? {}
        const { type, ...rest } = ctx.source
        existing.source = { type, ...rest }
        metadata = existing
      }
    }

    const message: Message = {
      id: uuidv7(),
      sessionId: params.sessionId,
      role: params.role,
      type: params.type || 'text',
      content: params.content,
      metadata,
      model: params.model || '',
      createdAt: Date.now()
    }

    // 按类型路由到对应的表
    if (STEP_TYPES.has(message.type)) {
      messageStepDao.insert(message)
    } else {
      messageDao.insert(message)
    }

    sessionDao.touch(message.sessionId)
    return message
  }

  /** 回退到指定消息：删除该消息之后的所有消息（跨两表） */
  rollbackToMessage(sessionId: string, messageId: string): void {
    const target = messageDao.findByIdAcrossTables(messageId)
    if (!target) return
    messageDao.deleteAfterTimestamp(sessionId, target.createdAt)
    messageStepDao.deleteAfterTimestamp(sessionId, target.createdAt)
  }

  /** 从指定消息开始删除（含该消息本身及之后的所有消息，跨两表） */
  deleteFromMessage(sessionId: string, messageId: string): void {
    const target = messageDao.findByIdAcrossTables(messageId)
    if (!target) return
    messageDao.deleteFromTimestamp(sessionId, target.createdAt)
    messageStepDao.deleteFromTimestamp(sessionId, target.createdAt)
  }

  /** 清空会话消息（两表） */
  clear(sessionId: string): void {
    messageDao.deleteBySessionId(sessionId)
    messageStepDao.deleteBySessionId(sessionId)
  }

  /** 获取会话最后一条消息（跨两表比较 createdAt） */
  findLastBySession(sessionId: string): ChatMessage | undefined {
    const msgs = messageDao.findBySessionId(sessionId)
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined
    const lastStep = messageStepDao.findLastBySessionId(sessionId)
    const last = !lastMsg ? lastStep : !lastStep ? lastMsg : lastStep.createdAt > lastMsg.createdAt ? lastStep : lastMsg
    return last ? narrowMessage(last) : undefined
  }

  // ─── 类型化工厂方法 ───────────────────────────────

  addUserText(p: {
    sessionId: string
    content: string
    images?: ImageMeta[]
  }): UserTextMessage {
    return this.add({
      sessionId: p.sessionId,
      role: 'user',
      content: p.content,
      metadata: p.images?.length ? { images: p.images } : undefined
    }) as unknown as UserTextMessage
  }

  addAssistantText(p: {
    sessionId: string
    content: string
    metadata?: MessageMetadata | null
    model: string
  }): AssistantTextMessage {
    return this.add({
      sessionId: p.sessionId,
      role: 'assistant',
      content: p.content,
      metadata: p.metadata,
      model: p.model
    }) as unknown as AssistantTextMessage
  }

  addToolCall(p: {
    sessionId: string
    toolCallId: string
    toolName: string
    args?: Record<string, unknown>
    turnIndex?: number
    model: string
  }): ToolCallMessage {
    return this.add({
      sessionId: p.sessionId,
      role: 'assistant',
      type: 'tool_call',
      content: '',
      metadata: {
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.args,
        turnIndex: p.turnIndex
      },
      model: p.model
    }) as unknown as ToolCallMessage
  }

  addToolResult(p: {
    sessionId: string
    toolCallId: string
    toolName: string
    content: string
    isError?: boolean
    details?: ToolResultDetails
  }): ToolResultMessage {
    return this.add({
      sessionId: p.sessionId,
      role: 'tool',
      type: 'tool_result',
      content: p.content,
      metadata: {
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        isError: p.isError || false,
        details: p.details
      }
    }) as unknown as ToolResultMessage
  }

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
      metadata: { turnIndex: p.turnIndex },
      model: p.model
    }) as unknown as StepThinkingMessage
  }

  addStepText(p: {
    sessionId: string
    content: string
    turnIndex?: number
    images?: ImageMeta[]
    model: string
  }): StepTextMessage {
    const metadata: MessageMetadata = { turnIndex: p.turnIndex }
    if (p.images?.length) metadata.images = p.images
    return this.add({
      sessionId: p.sessionId,
      role: 'assistant',
      type: 'step_text',
      content: p.content,
      metadata,
      model: p.model
    }) as unknown as StepTextMessage
  }

  addDockerEvent(p: {
    sessionId: string
    content: string
    containerId?: string
    image?: string
    reason?: string
  }): DockerEventMessage {
    const metadata: MessageMetadata = {}
    if (p.containerId !== undefined) metadata.containerId = p.containerId
    if (p.image !== undefined) metadata.image = p.image
    if (p.reason !== undefined) metadata.reason = p.reason
    return this.add({
      sessionId: p.sessionId,
      role: 'system_notify',
      type: 'docker_event',
      content: p.content,
      metadata: Object.keys(metadata).length > 0 ? metadata : null
    }) as unknown as DockerEventMessage
  }

  addSshEvent(p: {
    sessionId: string
    content: string
    host?: string
    port?: string
    username?: string
    reason?: string
  }): SshEventMessage {
    const metadata: MessageMetadata = {}
    if (p.host !== undefined) metadata.host = p.host
    if (p.port !== undefined) metadata.port = p.port
    if (p.username !== undefined) metadata.username = p.username
    if (p.reason !== undefined) metadata.reason = p.reason
    return this.add({
      sessionId: p.sessionId,
      role: 'system_notify',
      type: 'ssh_event',
      content: p.content,
      metadata: Object.keys(metadata).length > 0 ? metadata : null
    }) as unknown as SshEventMessage
  }

  addErrorEvent(p: { sessionId: string; content: string }): ErrorEventMessage {
    return this.add({
      sessionId: p.sessionId,
      role: 'system_notify',
      type: 'error_event',
      content: p.content
    }) as unknown as ErrorEventMessage
  }
}

export const messageService = new MessageService()
