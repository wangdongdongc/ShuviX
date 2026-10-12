export type { ClassifierLog } from '../dao/types'

/** 分类器调用的结果状态 */
export type ClassifierLogStatus =
  | 'ok'
  | 'incomplete'
  | 'failed'
  | 'timeout'
  | 'aborted'
  | 'misconfigured'

/** 分类器调用日志列表项（不含 request，含会话标题） */
export interface ClassifierLogSummary {
  id: string
  createdAt: number
  scene: string
  sessionId: string
  sessionTitle: string
  toolCallId: string
  subject: string
  provider: string
  model: string
  /** 答案 JSON（'' = 没有答案） */
  response: string
  status: string
  error: string
  ms: number
  inputTokens: number
  cost: number
}

/** IPC: 查询分类器日志的参数 */
export interface ClassifierLogListParams {
  scene?: string
  sessionId?: string
  status?: string
  limit?: number
}
