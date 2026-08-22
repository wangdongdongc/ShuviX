/**
 * 决策日志 ring buffer —— 每会话 256 条上限、新→旧排序、会话隔离与 logger 输出。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { recordDecision, getSessionDecisions, clearSessionDecisions } from '../decisionLog'
import type { SecurityDecisionRecord } from '../types'

const SESSIONS_USED: string[] = []

function makeRecord(sessionId: string, n: number): SecurityDecisionRecord {
  if (!SESSIONS_USED.includes(sessionId)) SESSIONS_USED.push(sessionId)
  return {
    ts: n,
    sessionId,
    toolCallId: `tc-${n}`,
    toolName: 'read',
    subject: { kind: 'agent', agentKind: 'root' },
    action: 'read',
    objectKind: 'path',
    objectSummary: `/f/${n}`,
    effect: 'allow',
    matched: [],
    winning: 'default:path',
    evaluateMs: 0
  }
}

afterEach(() => {
  while (SESSIONS_USED.length > 0) clearSessionDecisions(SESSIONS_USED.pop()!)
})

describe('decisionLog', () => {
  it('DL-1 ring buffer：写入 300 条 → 仅保留最新 256 条', () => {
    const sid = 'dl-ring'
    for (let i = 0; i < 300; i++) recordDecision(makeRecord(sid, i))
    const logs = getSessionDecisions(sid)
    expect(logs).toHaveLength(256)
    expect(logs[0].ts).toBe(299) // 最新
    expect(logs[255].ts).toBe(44) // 最旧（300-256）
  })

  it('DL-2 顺序新→旧；limit=N 取最近 N 条反转', () => {
    const sid = 'dl-order'
    for (let i = 0; i < 5; i++) recordDecision(makeRecord(sid, i))
    expect(getSessionDecisions(sid).map((r) => r.ts)).toEqual([4, 3, 2, 1, 0])
    expect(getSessionDecisions(sid, 2).map((r) => r.ts)).toEqual([4, 3])
  })

  it('DL-3 clear 后为空；未知 sessionId → []', () => {
    const sid = 'dl-clear'
    recordDecision(makeRecord(sid, 0))
    clearSessionDecisions(sid)
    expect(getSessionDecisions(sid)).toEqual([])
    expect(getSessionDecisions('dl-never-seen')).toEqual([])
  })

  it('DL-4 会话隔离：互不串写', () => {
    recordDecision(makeRecord('dl-a', 1))
    recordDecision(makeRecord('dl-b', 2))
    expect(getSessionDecisions('dl-a').map((r) => r.ts)).toEqual([1])
    expect(getSessionDecisions('dl-b').map((r) => r.ts)).toEqual([2])
  })

  it('DL-5 logger.info 收到 security_decision 前缀 + JSON；无 logger 不炸', () => {
    const info = vi.fn()
    const record = makeRecord('dl-logger', 7)
    recordDecision(record, { info, warn: vi.fn(), error: vi.fn() })
    expect(info).toHaveBeenCalledTimes(1)
    const msg = info.mock.calls[0][0] as string
    expect(msg.startsWith('security_decision ')).toBe(true)
    expect(JSON.parse(msg.slice('security_decision '.length))).toEqual(record)

    expect(() => recordDecision(makeRecord('dl-logger', 8))).not.toThrow()
  })

  it('DL-6 limit=0 现状=全量（特性化钉住 falsy limit 行为）', () => {
    const sid = 'dl-limit0'
    for (let i = 0; i < 5; i++) recordDecision(makeRecord(sid, i))
    expect(getSessionDecisions(sid, 0)).toHaveLength(5)
  })
})
