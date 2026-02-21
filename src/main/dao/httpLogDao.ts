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
        'INSERT INTO http_logs (id, sessionId, provider, model, payload, inputTokens, outputTokens, totalTokens, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(log.id, log.sessionId, log.provider, log.model, log.payload, log.inputTokens, log.outputTokens, log.totalTokens, log.createdAt)
  }

  /** 获取日志列表（不含 payload，按时间倒序，支持 sessionId/provider/model 筛选） */
  list(params: { sessionId?: string; provider?: string; model?: string; limit?: number } = {}): HttpLogSummary[] {
    const limit = params.limit ?? 200
    const conditions: string[] = []
    const values: unknown[] = []

    if (params.sessionId) {
      conditions.push('h.sessionId = ?')
      values.push(params.sessionId)
    }
    if (params.provider) {
      conditions.push('h.provider = ?')
      values.push(params.provider)
    }
    if (params.model) {
      conditions.push('h.model = ?')
      values.push(params.model)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    values.push(limit)

    return this.db
      .prepare(
        `SELECT h.id, h.sessionId, COALESCE(s.title, '') AS sessionTitle,
                h.provider, COALESCE(p.name, h.provider) AS providerName, h.model,
                h.inputTokens, h.outputTokens, h.totalTokens, h.createdAt
         FROM http_logs h
         LEFT JOIN sessions s ON h.sessionId = s.id
         LEFT JOIN providers p ON h.provider = p.id
         ${where}
         ORDER BY h.createdAt DESC LIMIT ?`
      )
      .all(...values) as HttpLogSummary[]
  }

  /** 根据 ID 获取完整日志（含 payload） */
  getById(id: string): HttpLog | undefined {
    return this.db
      .prepare('SELECT id, sessionId, provider, model, payload, inputTokens, outputTokens, totalTokens, createdAt FROM http_logs WHERE id = ?')
      .get(id) as HttpLog | undefined
  }

  /** 更新指定日志的 token 用量 */
  updateUsage(id: string, inputTokens: number, outputTokens: number, totalTokens: number): void {
    this.db
      .prepare('UPDATE http_logs SET inputTokens = ?, outputTokens = ?, totalTokens = ? WHERE id = ?')
      .run(inputTokens, outputTokens, totalTokens, id)
  }

  /** 删除指定会话的所有日志 */
  deleteBySessionId(sessionId: string): void {
    this.db.prepare('DELETE FROM http_logs WHERE sessionId = ?').run(sessionId)
  }

  /** 清空所有日志 */
  clear(): void {
    this.db.prepare('DELETE FROM http_logs').run()
  }
}

export const httpLogDao = new HttpLogDao()
