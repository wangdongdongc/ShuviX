import { v7 as uuidv7 } from 'uuid'
import { messageDao } from '../dao/messageDao'
import { sessionDao } from '../dao/sessionDao'
import type { Message } from '../types'

/**
 * 消息服务 — 编排消息相关的业务逻辑
 * 例如添加消息后自动更新会话时间戳
 */
export class MessageService {
  /** 获取会话的所有消息 */
  listBySession(sessionId: string): Message[] {
    return messageDao.findBySessionId(sessionId)
  }

  /** 添加消息（同时更新会话时间戳） */
  add(params: {
    sessionId: string
    role: 'user' | 'assistant' | 'tool' | 'system' | 'system_notify'
    type?: 'text' | 'tool_call' | 'tool_result' | 'docker_event' | 'error_event'
    content: string
    metadata?: string | null
    model?: string
  }): Message {
    const message: Message = {
      id: uuidv7(),
      sessionId: params.sessionId,
      role: params.role,
      type: params.type || 'text',
      content: params.content,
      metadata: params.metadata ?? null,
      model: params.model || '',
      createdAt: Date.now()
    }
    messageDao.insert(message)
    sessionDao.touch(message.sessionId)
    return message
  }

  /** 回退到指定消息：删除该消息之后的所有消息 */
  rollbackToMessage(sessionId: string, messageId: string): void {
    messageDao.deleteAfterMessage(sessionId, messageId)
  }

  /** 从指定消息开始删除（含该消息本身及之后的所有消息） */
  deleteFromMessage(sessionId: string, messageId: string): void {
    messageDao.deleteFromMessage(sessionId, messageId)
  }

  /** 清空会话消息 */
  clear(sessionId: string): void {
    messageDao.deleteBySessionId(sessionId)
  }
}

export const messageService = new MessageService()
