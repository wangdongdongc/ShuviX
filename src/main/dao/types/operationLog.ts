/** 操作日志数据结构（对应 DB 表 operation_logs） */
export interface OperationLog {
  id: string
  action: string
  sessionId: string | null
  sourceType: string
  sourceDetail: string | null
  summary: string
  detail: string | null
  requestId: string
  createdAt: number
}
