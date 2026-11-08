/**
 * chatStore 里的目标（目标模式，docs/goal-mode-design.md §9）：目标栏读 `sessionGoals`，侧栏读 `sessionGoalStatuses`。
 *
 *   GS-1 setSessionGoal：存整份视图；侧栏状态跟着（进行中 / 暂停中标，达成 / 做不到不标）；null 两处都删
 *   GS-2 setGoalStatuses：整份换，只留进行中 / 暂停中；内容没变时引用不变（侧栏不白渲染）
 *   GS-3 同一份视图再写一次 → 两张表的引用都不变
 *   GS-4 打开 / 关上编辑器：每次打开换 nonce；删会话时它的目标与侧栏状态一并清掉
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { GoalView } from '@shuvix/chat-protocol/types/goal'
import { useChatStore } from '../chatStore'

const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

function goal(sessionId: string, status: GoalView['status']): GoalView {
  return {
    id: `g_${sessionId}`,
    sessionId,
    objective: 'ship it',
    status,
    setAt: 0,
    limits: { maxTurns: 50, stallTurns: 3 },
    baselineCostUsd: 0,
    turns: 0,
    stalls: 0,
    activeMs: 0,
    costUsd: 0,
    judging: false,
    checkerMissing: false
  }
}

beforeEach(() => {
  useChatStore.setState({ sessionGoals: {}, sessionGoalStatuses: {}, goalEditor: null })
})

describe('chatStore 目标', () => {
  it('GS-1 setSessionGoal 存视图、带侧栏状态；null 两处都删', () => {
    store().setSessionGoal('a', goal('a', 'active'))
    store().setSessionGoal('b', goal('b', 'paused'))
    store().setSessionGoal('c', goal('c', 'met'))
    expect(Object.keys(store().sessionGoals).sort()).toEqual(['a', 'b', 'c'])
    expect(store().sessionGoalStatuses).toEqual({ a: 'active', b: 'paused' })

    store().setSessionGoal('a', goal('a', 'impossible'))
    expect(store().sessionGoalStatuses).toEqual({ b: 'paused' })

    store().setSessionGoal('b', null)
    expect(store().sessionGoals).not.toHaveProperty('b')
    expect(store().sessionGoalStatuses).toEqual({})
  })

  it('GS-2 setGoalStatuses 整份换、只留进行中 / 暂停中；没变不换引用', () => {
    store().setGoalStatuses({ a: 'active', b: 'paused', c: 'met', d: 'impossible' })
    const first = store().sessionGoalStatuses
    expect(first).toEqual({ a: 'active', b: 'paused' })

    store().setGoalStatuses({ b: 'paused', a: 'active' })
    expect(store().sessionGoalStatuses).toBe(first)

    store().setGoalStatuses({ a: 'paused' })
    expect(store().sessionGoalStatuses).toEqual({ a: 'paused' })
  })

  it('GS-3 同一份视图再写一次 → 引用不变', () => {
    const view = goal('a', 'active')
    store().setSessionGoal('a', view)
    const goals = store().sessionGoals
    const statuses = store().sessionGoalStatuses
    store().setSessionGoal('a', view)
    expect(store().sessionGoals).toBe(goals)
    expect(store().sessionGoalStatuses).toBe(statuses)
    // 没有目标的会话写 null：什么都不动
    store().setSessionGoal('zzz', null)
    expect(store().sessionGoals).toBe(goals)
  })

  it('GS-4 编辑器开关；删会话清掉它的目标', () => {
    store().openGoalEditor('a', 'new')
    const first = store().goalEditor!
    expect(first).toMatchObject({ sessionId: 'a', mode: 'new' })
    store().openGoalEditor('a', 'edit')
    expect(store().goalEditor!.nonce).not.toBe(first.nonce)
    store().closeGoalEditor()
    expect(store().goalEditor).toBeNull()

    store().setSessionGoal('a', goal('a', 'active'))
    store().removeSession('a')
    expect(store().sessionGoals).toEqual({})
    expect(store().sessionGoalStatuses).toEqual({})
  })
})
