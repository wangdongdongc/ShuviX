import { v4 as uuidv4 } from 'uuid'
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
    role: 'user' | 'assistant'
    content: string
  }): Message {
    const message: Message = {
      id: uuidv4(),
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      createdAt: Date.now()
    }
    messageDao.insert(message)
    sessionDao.touch(message.sessionId)
    return message
  }

  /** 清空会话消息 */
  clear(sessionId: string): void {
    messageDao.deleteBySessionId(sessionId)
  }
}

export const messageService = new MessageService()
