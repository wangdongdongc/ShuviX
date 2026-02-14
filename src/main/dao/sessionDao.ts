import { databaseManager } from './database'
import type { Session } from '../types'

/**
 * Session DAO — 会话表的纯数据访问操作
 */
export class SessionDao {
  private get db() {
    return databaseManager.getDb()
  }

  /** 获取所有会话，按更新时间倒序 */
  findAll(): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY updatedAt DESC')
      .all() as Session[]
  }

  /** 根据 ID 获取单个会话 */
  findById(id: string): Session | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as Session | undefined
  }

  /** 插入会话 */
  insert(session: Session): void {
    this.db
      .prepare(
        'INSERT INTO sessions (id, title, provider, model, systemPrompt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        session.id,
        session.title,
        session.provider,
        session.model,
        session.systemPrompt,
        session.createdAt,
        session.updatedAt
      )
  }

  /** 更新标题和时间戳 */
  updateTitle(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?')
      .run(title, Date.now(), id)
  }

  /** 更新会话模型配置（provider/model） */
  updateModelConfig(id: string, provider: string, model: string): void {
    this.db
      .prepare('UPDATE sessions SET provider = ?, model = ?, updatedAt = ? WHERE id = ?')
      .run(provider, model, Date.now(), id)
  }

  /** 更新时间戳 */
  touch(id: string): void {
    this.db
      .prepare('UPDATE sessions SET updatedAt = ? WHERE id = ?')
      .run(Date.now(), id)
  }

  /** 删除会话 */
  deleteById(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }
}

export const sessionDao = new SessionDao()
