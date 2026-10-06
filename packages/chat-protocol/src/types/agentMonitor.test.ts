/**
 * `AgentMonitorEntry` 的形状（P3-13-19，PIN-01 / PIN-03 / PIN-08）—— 类型层面的钉子，由 typecheck 执行
 * （`@ts-expect-error` 没有报错可吃时 tsc 会报「未使用的指令」）；vitest 这边只跑一条运行时断言。
 *
 *  - 去掉了：事件计数器 `counters`、`rootSessionExists`、`queue.nextTurn`、`cache.calls`、`activeToolCount`，
 *    相位 `'branch_summary'`，以及导出的 `AgentMonitorCounters`；
 *  - 加上了：`cost: {total}`、`sessionCost`、`dispatch?: 'tool' | 'hook'`、相位 `'interrupted'`。
 */
import { describe, expect, it } from 'vitest'
import type { AgentMonitorEntry, AgentMonitorPhase } from './agentMonitor'

const base: AgentMonitorEntry = {
  agentId: 'a',
  kind: 'spawned',
  rootSessionId: 's',
  parentAgentId: 's',
  depth: 1,
  profileName: 'p',
  displayName: 'P',
  dispatch: 'hook',
  phase: 'interrupted',
  startedAt: 0,
  lastActivityAt: 0,
  queue: { steer: 0, followUp: 0 },
  model: { provider: 'faux', id: 'faux-1', contextWindow: 0 },
  thinkingLevel: 'off',
  toolCount: 0,
  contextTokens: 0,
  cache: { input: 0, cacheRead: 0, cacheWrite: 0, reported: false },
  cost: { total: 0 },
  sessionCost: 0
}

// @ts-expect-error counters are gone (Q-P3-08)
const withCounters: AgentMonitorEntry = { ...base, counters: { turns: 1 } }
// @ts-expect-error rootSessionExists is gone: a runtime cannot outlive its session
const withExists: AgentMonitorEntry = { ...base, rootSessionExists: true }
// @ts-expect-error queue.nextTurn is gone (P3-11)
const withNextTurn: AgentMonitorEntry = { ...base, queue: { steer: 0, followUp: 0, nextTurn: 0 } }
const withCalls: AgentMonitorEntry = {
  ...base,
  // @ts-expect-error cache.calls is gone (PIN-03)
  cache: { calls: 1, input: 0, cacheRead: 0, cacheWrite: 0, reported: false }
}
// @ts-expect-error activeToolCount is gone (PIN-08)
const withActive: AgentMonitorEntry = { ...base, activeToolCount: 0 }
// @ts-expect-error branch_summary is not a phase
const branchSummary: AgentMonitorPhase = 'branch_summary'
// @ts-expect-error AgentMonitorCounters is no longer exported
type Counters = import('./agentMonitor').AgentMonitorCounters

const interrupted: AgentMonitorPhase = 'interrupted'
const toolDispatch: AgentMonitorEntry['dispatch'] = 'tool'
const cost: { total: number } = base.cost
const sessionCost: number = base.sessionCost

describe('P3-13-19 AgentMonitorEntry shape', () => {
  it('P3-13-19 the new fields type-check and the removed ones do not (see the @ts-expect-error lines)', () => {
    const removed: unknown[] = [
      withCounters,
      withExists,
      withNextTurn,
      withCalls,
      withActive,
      branchSummary
    ]
    expect(removed).toHaveLength(6)
    expect(null as Counters | null).toBeNull()
    expect([interrupted, toolDispatch, cost.total, sessionCost]).toEqual([
      'interrupted',
      'tool',
      0,
      0
    ])
  })
})
