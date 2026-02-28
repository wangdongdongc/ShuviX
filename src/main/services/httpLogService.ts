import { v7 as uuidv7 } from 'uuid'
import { httpLogDao } from '../dao/httpLogDao'
import type { HttpLog, HttpLogSummary } from '../types'

/**
 * HTTP 日志服务 — 编排日志写入与查询
 */
export class HttpLogService {
  /** 将 payload 转成可展示文本 */
  private stringifyPayload(payload: unknown): string {
    try {
      return JSON.stringify(payload, null, 2)
    } catch {
      return String(payload)
    }
  }

  /** 记录一次请求体，返回日志 ID（用于后续更新 token 用量） */
  logRequest(params: {
    sessionId: string
    provider: string
    model: string
    payload: unknown
  }): string {
    const log: HttpLog = {
      id: uuidv7(),
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model,
      payload: this.stringifyPayload(params.payload),
      response: '',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      createdAt: Date.now()
    }
    httpLogDao.insert(log)
    return log.id
  }

  /** 更新指定日志的 token 用量和响应内容 */
  updateUsage(
    id: string,
    inputTokens: number,
    outputTokens: number,
    totalTokens: number,
    response?: string
  ): void {
    httpLogDao.updateUsage(id, inputTokens, outputTokens, totalTokens, response)
  }

  /** 获取日志列表（支持 sessionId/provider/model 筛选） */
  list(params?: {
    sessionId?: string
    provider?: string
    model?: string
    limit?: number
  }): HttpLogSummary[] {
    return httpLogDao.list(params)
  }

  /** 获取日志详情 */
  getById(id: string): HttpLog | undefined {
    return httpLogDao.getById(id)
  }

  /** 清空日志 */
  clear(): void {
    httpLogDao.clear()
  }
}

export const httpLogService = new HttpLogService()
