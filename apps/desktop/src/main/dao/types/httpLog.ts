/** HTTP 请求日志数据结构（对应 DB 表 http_logs） */
export interface HttpLog {
  id: string
  sessionId: string
  provider: string
  model: string
  payload: string
  response: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  createdAt: number
}
