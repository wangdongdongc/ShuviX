export type { OperationLog } from '../dao/types'

/** 操作日志列表项（含会话标题） */
export interface OperationLogSummary {
  id: string
  action: string
  sessionId: string | null
  sessionTitle: string
  sourceType: string
  sourceDetail: string | null
  summary: string
  createdAt: number
}

/** IPC: 查询操作日志列表参数 */
export interface OperationLogListParams {
  sessionId?: string
  sourceType?: string
  action?: string
  limit?: number
}
