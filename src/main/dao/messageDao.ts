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

  /** 删除某个会话的所有消息 */
  deleteBySessionId(sessionId: string): void {
    this.db.prepare('DELETE FROM messages WHERE sessionId = ?').run(sessionId)
  }
}

export const messageDao = new MessageDao()
