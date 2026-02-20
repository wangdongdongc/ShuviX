import { databaseManager } from './database'
import type { Message } from '../types'

/**
 * Message DAO — 消息表的纯数据访问操作
 */
export class MessageDao {
  private get db() {
    return databaseManager.getDb()
  }

  /** 获取某个会话的所有消息，按时间升序 */
  findBySessionId(sessionId: string): Message[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE sessionId = ? ORDER BY createdAt ASC')
      .all(sessionId) as Message[]
  }

  /** 插入消息 */
  insert(message: Message): void {
    this.db
      .prepare(
        'INSERT INTO messages (id, sessionId, role, type, content, metadata, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(message.id, message.sessionId, message.role, message.type, message.content, message.metadata, message.createdAt)
  }

  /** 根据 ID 获取单条消息 */
  findById(id: string): Message | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | undefined
  }

  /** 删除某个会话的所有消息 */
  deleteBySessionId(sessionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE sessionId = ?').run(sessionId)
  }

  /** 删除指定消息之后的所有消息（不含该消息本身） */
  deleteAfterMessage(sessionId: string, messageId: string): number {
    const target = this.findById(messageId)
    if (!target) return 0
    return this.db
      .prepare('DELETE FROM messages WHERE sessionId = ? AND createdAt > ?')
      .run(sessionId, target.createdAt).changes
  }

  /** 删除指定消息及其之后的所有消息（含该消息本身） */
  deleteFromMessage(sessionId: string, messageId: string): number {
    const target = this.findById(messageId)
    if (!target) return 0
    return this.db
      .prepare('DELETE FROM messages WHERE sessionId = ? AND createdAt >= ?')
      .run(sessionId, target.createdAt).changes
  }
}

export const messageDao = new MessageDao()
