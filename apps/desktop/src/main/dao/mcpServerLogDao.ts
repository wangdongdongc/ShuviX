import { BaseDao } from './database'
import type { McpServerLog } from './types'
import type { McpHostLogSummary } from '../types'

/**
 * MCP Server 日志 DAO — 对外服务的工具调用日志
 */
export class McpServerLogDao extends BaseDao {
  /** 写入一条日志 */
  insert(log: McpServerLog): void {
    this.stmt(
      `INSERT INTO mcp_server_logs (id, sessionId, clientName, clientVersion, toolName, arguments, result, isError, durationMs, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      log.id,
      log.sessionId,
      log.clientName,
      log.clientVersion,
      log.toolName,
      log.arguments,
      log.result,
      log.isError,
      log.durationMs,
      log.createdAt
    )
  }

  /** 列表查询（不含 arguments/result 大字段，按时间倒序） */
  list(
    params: { clientName?: string; toolName?: string; limit?: number } = {}
  ): McpHostLogSummary[] {
    const limit = params.limit ?? 200
    const conditions: string[] = []
    const values: unknown[] = []

    if (params.clientName) {
      conditions.push('clientName = ?')
      values.push(params.clientName)
    }
    if (params.toolName) {
      conditions.push('toolName = ?')
      values.push(params.toolName)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    values.push(limit)

    return this.db
      .prepare(
        `SELECT id, sessionId, clientName, clientVersion, toolName, isError, durationMs, createdAt
         FROM mcp_server_logs
         ${where}
         ORDER BY createdAt DESC LIMIT ?`
      )
      .all(...values) as McpHostLogSummary[]
  }

  /** 获取完整日志详情 */
  getById(id: string): McpServerLog | undefined {
    return this.stmt(
      `SELECT id, sessionId, clientName, clientVersion, toolName, arguments, result, isError, durationMs, createdAt
       FROM mcp_server_logs WHERE id = ?`
    ).get(id) as McpServerLog | undefined
  }

  /** 清空所有日志 */
  clear(): void {
    this.stmt('DELETE FROM mcp_server_logs').run()
  }
}

export const mcpServerLogDao = new McpServerLogDao()
