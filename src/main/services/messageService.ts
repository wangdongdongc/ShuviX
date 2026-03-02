import { v7 as uuidv7 } from 'uuid'
import { messageDao, messageStepDao } from '../dao/messageDao'
import { sessionDao } from '../dao/sessionDao'
import { getOperationContext } from '../frontend/core/OperationContext'
import type { Message, MessageType } from '../types'

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
  listBySession(sessionId: string): Message[] {
    const primary = messageDao.findBySessionId(sessionId)
    const steps = messageStepDao.findBySessionId(sessionId)
    if (steps.length === 0) return primary
    if (primary.length === 0) return steps
    return mergeSorted(primary, steps)
  }

  /** 添加消息（按类型路由到对应的表，同时更新会话时间戳） */
  add(params: {
    sessionId: string
    role: 'user' | 'assistant' | 'tool' | 'system' | 'system_notify'
    type?: MessageType
    content: string
    metadata?: string | null
    model?: string
  }): Message {
    // 对 user 消息，自动注入来源信息到 metadata（非 electron 来源时）
    let metadata = params.metadata ?? null
    if (params.role === 'user') {
      const ctx = getOperationContext()
      if (ctx && ctx.source.type !== 'electron') {
        const existing = metadata ? JSON.parse(metadata) : {}
        const { type, ...rest } = ctx.source
        existing.source = { type, ...rest }
        metadata = JSON.stringify(existing)
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
  findLastBySession(sessionId: string): Message | undefined {
    const msgs = messageDao.findBySessionId(sessionId)
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined
    const lastStep = messageStepDao.findLastBySessionId(sessionId)
    if (!lastMsg) return lastStep
    if (!lastStep) return lastMsg
    return lastStep.createdAt > lastMsg.createdAt ? lastStep : lastMsg
  }
}

export const messageService = new MessageService()
