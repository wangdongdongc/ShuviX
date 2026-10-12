import { BaseDao } from './database'
import type { ClassifierLog } from './types'
import type { ClassifierLogListParams, ClassifierLogSummary } from '../types'

/**
 * 分类器调用日志 DAO —— classifier_logs 表的纯数据访问
 */
export class ClassifierLogDao extends BaseDao {
  insert(log: ClassifierLog): void {
    this.stmt(
      `INSERT INTO classifier_logs (id, createdAt, scene, sessionId, toolCallId, subject, provider, model,
         request, response, status, error, ms, inputTokens, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      log.id,
      log.createdAt,
      log.scene,
      log.sessionId,
      log.toolCallId,
      log.subject,
      log.provider,
      log.model,
      log.request,
      log.response,
      log.status,
      log.error,
      log.ms,
      log.inputTokens,
      log.cost
    )
  }

  /** 列表（不含 request；答案很小，带上以便列表直接显示结果）；按时间倒序，可按场景 / 会话 / 状态筛选 */
  list(params: ClassifierLogListParams = {}): ClassifierLogSummary[] {
    const conditions: string[] = []
    const values: unknown[] = []
    if (params.scene) {
      conditions.push('c.scene = ?')
      values.push(params.scene)
    }
    if (params.sessionId) {
      conditions.push('c.sessionId = ?')
      values.push(params.sessionId)
    }
    if (params.status) {
      conditions.push('c.status = ?')
      values.push(params.status)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    values.push(params.limit ?? 200)
    return this.db
      .prepare(
        `SELECT c.id, c.createdAt, c.scene, c.sessionId, COALESCE(s.title, '') AS sessionTitle,
                c.toolCallId, c.subject, c.provider, c.model, c.response, c.status, c.error, c.ms,
                c.inputTokens, c.cost
         FROM classifier_logs c
         LEFT JOIN sessions s ON c.sessionId = s.id
         ${where}
         ORDER BY c.createdAt DESC, c.id DESC LIMIT ?`
      )
      .all(...values) as ClassifierLogSummary[]
  }

  getById(id: string): ClassifierLog | undefined {
    return this.stmt('SELECT * FROM classifier_logs WHERE id = ?').get(id) as
      | ClassifierLog
      | undefined
  }

  /** 出现过的场景（筛选下拉用） */
  scenes(): string[] {
    return (
      this.stmt('SELECT DISTINCT scene FROM classifier_logs ORDER BY scene').all() as {
        scene: string
      }[]
    ).map((row) => row.scene)
  }

  clear(): void {
    this.stmt('DELETE FROM classifier_logs').run()
  }

  /** 只留最新的 keep 条（同一毫秒的按 id —— uuidv7 随时间递增 —— 定先后） */
  prune(keep: number): void {
    this.stmt(
      `DELETE FROM classifier_logs WHERE id NOT IN
         (SELECT id FROM classifier_logs ORDER BY createdAt DESC, id DESC LIMIT ?)`
    ).run(keep)
  }
}

export const classifierLogDao = new ClassifierLogDao()
