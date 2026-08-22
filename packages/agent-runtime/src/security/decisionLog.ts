/**
 * 决策日志 —— 每次 enforce（评估 + 执行）产出一条结构化记录：
 *   - 经宿主 RuntimeLogger 输出（桌面 = electron-log；审计可 grep `security_decision`）；
 *   - 会话内存 ring buffer（每会话上限 256 条），供未来策略检视 UI 的「最近决策流」；
 *   - 刻意不建表（评审拍板）：SQLite 持久化留待检视 UI 阶段按需引入。
 *
 * evaluateReadOnly（被动 UI 判定）不记日志 —— 高频且无执行语义，会刷爆 buffer。
 */
import type { RuntimeLogger } from '../types'
import type { SecurityDecisionRecord } from './types'

const MAX_RECORDS_PER_SESSION = 256

const buffers = new Map<string, SecurityDecisionRecord[]>()

export function recordDecision(record: SecurityDecisionRecord, logger?: RuntimeLogger): void {
  let buffer = buffers.get(record.sessionId)
  if (!buffer) {
    buffer = []
    buffers.set(record.sessionId, buffer)
  }
  buffer.push(record)
  if (buffer.length > MAX_RECORDS_PER_SESSION) {
    buffer.splice(0, buffer.length - MAX_RECORDS_PER_SESSION)
  }
  logger?.info(`security_decision ${JSON.stringify(record)}`)
}

/** 最近决策（新→旧）；limit 缺省全量（≤256） */
export function getSessionDecisions(sessionId: string, limit?: number): SecurityDecisionRecord[] {
  const buffer = buffers.get(sessionId) ?? []
  const slice = limit ? buffer.slice(-limit) : buffer.slice()
  return slice.reverse()
}

/** 会话销毁时清理（桌面 agentSession 清理链 / 扩展 sessionManager 对应处调用） */
export function clearSessionDecisions(sessionId: string): void {
  buffers.delete(sessionId)
}
