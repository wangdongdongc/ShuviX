import { databaseManager } from './database'
import type { HttpLog, HttpLogSummary } from '../types'

/**
 * HTTP 日志 DAO — 请求日志表的纯数据访问操作
 */
export class HttpLogDao {
  private get db() {
    return databaseManager.getDb()
  }

  /** 写入一条 HTTP 请求日志 */
  insert(log: HttpLog): void {
    this.db
      .prepare(
        'INSERT INTO http_logs (id, sessionId, provider, model, payload, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(log.id, log.sessionId, log.provider, log.model, log.payload, log.createdAt)
  }

  /** 获取日志列表（不含 payload，按时间倒序） */
  list(limit = 200): HttpLogSummary[] {
    return this.db
      .prepare(
        'SELECT id, sessionId, provider, model, createdAt FROM http_logs ORDER BY createdAt DESC LIMIT ?'
      )
      .all(limit) as HttpLogSummary[]
  }

  /** 根据 ID 获取完整日志（含 payload） */
  getById(id: string): HttpLog | undefined {
    return this.db
      .prepare('SELECT id, sessionId, provider, model, payload, createdAt FROM http_logs WHERE id = ?')
      .get(id) as HttpLog | undefined
  }

  /** 清空所有日志 */
  clear(): void {
    this.db.prepare('DELETE FROM http_logs').run()
  }
}

export const httpLogDao = new HttpLogDao()
