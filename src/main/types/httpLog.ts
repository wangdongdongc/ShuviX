/** HTTP 请求日志数据结构 */
export interface HttpLog {
  id: string
  sessionId: string
  provider: string
  model: string
  payload: string
  createdAt: number
}

/** HTTP 请求日志列表项（不含 payload，含会话标题） */
export interface HttpLogSummary {
  id: string
  sessionId: string
  sessionTitle: string
  provider: string
  model: string
  createdAt: number
}

/** IPC: 查询日志列表参数 */
export interface HttpLogListParams {
  sessionId?: string
  limit?: number
}
