import { BaseDao } from './database'
import type { OperationLog } from './types'
import type { OperationLogSummary } from '../types'

/**
 * 操作日志 DAO — operation_logs 表的纯数据访问操作
 */
export class OperationLogDao extends BaseDao {
  /** 写入一条操作日志 */
  insert(log: OperationLog): void {
    this.db
      .prepare(
        'INSERT INTO operation_logs (id, action, sessionId, sourceType, sourceDetail, summary, detail, requestId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        log.id,
        log.action,
        log.sessionId,
        log.sourceType,
        log.sourceDetail,
        log.summary,
        log.detail,
        log.requestId,
        log.createdAt
      )
  }

  /** 获取日志列表（按时间倒序，支持筛选） */
  list(
    params: { sessionId?: string; sourceType?: string; action?: string; limit?: number } = {}
  ): OperationLogSummary[] {
    const limit = params.limit ?? 200
    const conditions: string[] = []
    const values: unknown[] = []

    if (params.sessionId) {
      conditions.push('o.sessionId = ?')
      values.push(params.sessionId)
    }
    if (params.sourceType) {
      conditions.push('o.sourceType = ?')
      values.push(params.sourceType)
    }
    if (params.action) {
      conditions.push('o.action = ?')
      values.push(params.action)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    values.push(limit)

    return this.db
      .prepare(
        `SELECT o.id, o.action, o.sessionId, COALESCE(s.title, '') AS sessionTitle,
                o.sourceType, o.sourceDetail, o.summary, o.createdAt
         FROM operation_logs o
         LEFT JOIN sessions s ON o.sessionId = s.id
         ${where}
         ORDER BY o.createdAt DESC LIMIT ?`
      )
      .all(...values) as OperationLogSummary[]
  }

  /** 根据 ID 获取完整日志（含 detail） */
  getById(id: string): OperationLog | undefined {
    return this.db
      .prepare('SELECT * FROM operation_logs WHERE id = ?')
      .get(id) as OperationLog | undefined
  }

  /** 清空所有日志 */
  clear(): void {
    this.db.prepare('DELETE FROM operation_logs').run()
  }
}

export const operationLogDao = new OperationLogDao()
