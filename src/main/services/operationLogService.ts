import { v4 as uuid } from 'uuid'
import { operationLogDao } from '../dao/operationLogDao'
import { getOperationContext } from '../frontend/core/OperationContext'
import type { OperationLog } from '../dao/types'
import type { OperationLogSummary, OperationLogListParams } from '../types'

/**
 * 操作日志 Service — 基于 OperationContext 自动记录用户操作
 */
class OperationLogService {
  /**
   * 记录一条操作日志（自动从 AsyncLocalStorage 提取来源信息）
   * 无 OperationContext 时静默跳过（系统内部调用不记录）
   */
  log(action: string, summary: string, detail?: string): void {
    const ctx = getOperationContext()
    if (!ctx) return

    const { type, ...rest } = ctx.source
    const hasDetail = Object.keys(rest).length > 0

    const log: OperationLog = {
      id: uuid(),
      action,
      sessionId: ctx.sessionId ?? null,
      sourceType: type,
      sourceDetail: hasDetail ? JSON.stringify(rest) : null,
      summary,
      detail: detail ?? null,
      requestId: ctx.requestId,
      createdAt: ctx.timestamp
    }

    operationLogDao.insert(log)
  }

  /** 查询操作日志列表 */
  list(params?: OperationLogListParams): OperationLogSummary[] {
    return operationLogDao.list(params)
  }

  /** 获取单条日志详情 */
  getById(id: string): OperationLog | undefined {
    return operationLogDao.getById(id)
  }

  /** 清空所有日志 */
  clear(): void {
    operationLogDao.clear()
  }
}

export const operationLogService = new OperationLogService()
