/**
 * 目标模式的共享类型（types/goal.ts，docs/goal-mode-design.md）—— 判定结论的守卫与严格程度、缺省上限、进行中时长。
 *
 *   CP-1 `isGoalVerdict`：只认三种结论；多出来的键容忍（schema 已经挡过）；`goalVerdictSeverity`：not_met > impossible > met；
 *        `GOAL_VERDICT_SCHEMA` 必填 verdict / reason、不收额外键、枚举 = `GOAL_VERDICTS`
 *   CP-2 `DEFAULT_GOAL_LIMITS` = {5 美元, 50 轮, 3 次停滞}，没有时长上限（D3）；`goalActiveMs` 累计 + 当前时段，起点在未来按 0 算
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GOAL_LIMITS,
  GOAL_VERDICTS,
  GOAL_VERDICT_SCHEMA,
  goalActiveMs,
  goalVerdictSeverity,
  isGoalVerdict
} from './goal'

describe('CP-1 判定结论的守卫与严格程度', () => {
  it('三种合法结论 → true；next_step 可有可无；多出来的键容忍', () => {
    expect(isGoalVerdict({ verdict: 'met', reason: 'tests pass' })).toBe(true)
    expect(isGoalVerdict({ verdict: 'not_met', reason: 'x', next_step: 'run tests' })).toBe(true)
    expect(isGoalVerdict({ verdict: 'impossible', reason: '' })).toBe(true)
    expect(isGoalVerdict({ verdict: 'met', reason: 'ok', extra: 1 })).toBe(true)
  })

  it('形状不对 → false：认不出的结论、reason / next_step 类型不对、null、数组、原始值', () => {
    expect(isGoalVerdict({ verdict: 'done', reason: 'x' })).toBe(false)
    expect(isGoalVerdict({ verdict: 'met', reason: 1 })).toBe(false)
    expect(isGoalVerdict({ verdict: 'met' })).toBe(false)
    expect(isGoalVerdict({ verdict: 'not_met', reason: 'x', next_step: 3 })).toBe(false)
    expect(isGoalVerdict(null)).toBe(false)
    expect(isGoalVerdict([])).toBe(false)
    expect(isGoalVerdict(['met', 'x'])).toBe(false)
    expect(isGoalVerdict('met')).toBe(false)
    expect(isGoalVerdict(undefined)).toBe(false)
  })

  it('严格程度：not_met > impossible > met（只要有一个说没做完就接着做）', () => {
    expect(goalVerdictSeverity('not_met')).toBeGreaterThan(goalVerdictSeverity('impossible'))
    expect(goalVerdictSeverity('impossible')).toBeGreaterThan(goalVerdictSeverity('met'))
  })

  it('schema：必填 verdict + reason，不收额外键，枚举就是 GOAL_VERDICTS', () => {
    expect(GOAL_VERDICT_SCHEMA.required).toEqual(['verdict', 'reason'])
    expect(GOAL_VERDICT_SCHEMA.additionalProperties).toBe(false)
    const props = GOAL_VERDICT_SCHEMA.properties as Record<string, { enum?: unknown[] }>
    expect(props.verdict!.enum).toEqual([...GOAL_VERDICTS])
    expect(Object.keys(props).sort()).toEqual(['next_step', 'reason', 'verdict'])
  })
})

describe('CP-2 缺省上限与进行中时长', () => {
  it('缺省上限 = 50 轮 / 3 次停滞，没有时长上限（D3）；没有花费上限（2026-11-09：ShuviX 不算钱）', () => {
    expect(DEFAULT_GOAL_LIMITS).toStrictEqual({ maxTurns: 50, stallTurns: 3 })
    expect('wallClockMin' in DEFAULT_GOAL_LIMITS).toBe(false)
  })

  it('goalActiveMs：不在进行中 = 累计；在进行中 = 累计 + 当前时段；起点在未来按 +0', () => {
    const now = 10_000
    expect(goalActiveMs({ activeMs: 1000 }, now)).toBe(1000)
    expect(goalActiveMs({ activeMs: 1000, activeSince: now - 500 }, now)).toBe(1500)
    expect(goalActiveMs({ activeMs: 1000, activeSince: now + 5000 }, now)).toBe(1000)
  })
})
