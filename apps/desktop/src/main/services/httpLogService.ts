import { v7 as uuidv7 } from 'uuid'
import { httpLogDao } from '../dao/httpLogDao'
import { settingsService } from './settingsService'
import type { HttpLog, HttpLogSummary } from '../types'

/** 记录开关的设置 key —— 缺省（未写过）即关闭 */
export const HTTP_LOG_ENABLED_KEY = 'httpLog.enabled'

/**
 * HTTP 日志服务 — 编排日志写入与查询
 *
 * 记录默认关闭：payload 是「系统提示词 + 全部历史消息 + 工具定义」的完整快照，
 * agent 循环每一步都会重发，逐步落盘会让库体积呈 O(N²) 膨胀（含 base64 图片时尤甚）。
 * 用户在「LLM 日志」页手动开启后才记录。
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

  /** 记录开关（实时读取设置，开/关立即生效，无需重启会话） */
  isEnabled(): boolean {
    return settingsService.get(HTTP_LOG_ENABLED_KEY) === 'true'
  }

  /**
   * 记录一次请求体，返回日志 ID（用于后续更新 token 用量）。
   * 关闭时返回空串 —— 调用方据此跳过用量回填，序列化开销也一并省掉。
   */
  logRequest(params: {
    sessionId: string
    provider: string
    model: string
    payload: unknown
  }): string {
    if (!this.isEnabled()) return ''

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
