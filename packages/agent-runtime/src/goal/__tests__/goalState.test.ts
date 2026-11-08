/**
 * 目标状态机（goal/goalState.ts，docs/goal-mode-design.md §2、§4.1、§6）—— 纯函数，不碰存储、不调模型。
 *
 *   GS-1  createGoal：进行中、计数归零、activeSince = setAt = now；上限是拷贝
 *   GS-2  pause / resume：只有进行中能暂停（累计时长、去掉 activeSince）、只有暂停的能恢复（停滞清零、轮数保留）；入参不变
 *   GS-3  editGoal：换原文 → 停滞清零；同一原文 → 停滞保留；只改上限 → 合并；终态原样
 *   GS-4  mergeLimits：null / undefined 对花费、时长 = 不限，对轮数、停滞保持原值；非法值忽略；轮数、停滞取整且 ≥ 1
 *   GS-5  guardHit：budget > turns > stalled > wall-clock；等于即撞；没有花费上限不撞预算；时长算上当前时段
 *   GS-6  afterRun（§4.1，2026-11-08 起不查护栏、不碰停滞）：中止 → stopped；出错 → run-error（都先于后台工作）；
 *         有后台工作 → wait（先于护栏）；否则 judge，noProgress = 没有工具调用或全部失败
 *   GS-7  applyVerdict：null → judge-unavailable；met / impossible → 结束（理由去空白、记 endedAt、累计时长、轮数不变）；
 *         not_met → 续跑（轮数 +1；空白的下一步不记）；目标不在进行中 → none；lastVerdict.at = 事实截止时刻
 *   GS-8  理由逐字重复（去空白后）→ 停滞 +1；上一次是 met 不算重复；空理由从不算重复
 *   GS-9  护栏在判定之后：最后一次续跑的成果照样判 —— 达成优先于上限；没达成才因上限暂停（A-1 的裁决）
 *   GS-10 停滞按 §6.3 计（B-3 修复）：每轮都有成功的工具调用但理由逐字重复 → 第 4 次判定时停（1,2,3）；
 *         没有工具调用 + 同一理由的两轮 → 停滞 2，不提前暂停
 *   GS-11 budgetCrossed：只对进行中、有花费上限、到了上限的为真
 *   GS-12 resumeBlockedBy：恢复后（停滞清零）仍撞着预算 / 轮数 / 时长 → 拒绝恢复；停滞不挡
 */
import { describe, expect, it } from 'vitest'
import type { GoalLimits, GoalLimitsPatch, GoalRecord } from '@shuvix/chat-protocol/types/goal'
import {
  afterRun,
  applyVerdict,
  budgetCrossed,
  createGoal,
  editGoal,
  guardHit,
  mergeLimits,
  pauseGoal,
  resumeBlockedBy,
  resumeGoal,
  type RunEndFacts
} from '../goalState'

const LIMITS: GoalLimits = { costUsd: 5, maxTurns: 50, stallTurns: 3 }

function active(over: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'g_1',
    objective: 'Make e2e green',
    status: 'active',
    setAt: 1000,
    limits: { ...LIMITS },
    baselineCostUsd: 0,
    turns: 0,
    stalls: 0,
    activeMs: 0,
    activeSince: 1000,
    ...over
  }
}

function runFacts(over: Partial<RunEndFacts> = {}): RunEndFacts {
  return {
    outcome: 'ok',
    backgroundWork: false,
    toolCalls: 1,
    toolSucceeded: 1,
    costUsd: 0,
    now: 2000,
    ...over
  }
}

function frozen<T>(value: T): T {
  return Object.freeze(structuredClone(value))
}

describe('GS-1 createGoal', () => {
  it('进行中、计数归零、setAt = activeSince = now；上限是拷贝；没有可选字段', () => {
    const limits: GoalLimits = { costUsd: 7, maxTurns: 5, stallTurns: 2 }
    const goal = createGoal({ id: 'g_1', objective: 'x', limits, baselineCostUsd: 2, now: 500 })
    expect(goal).toStrictEqual({
      id: 'g_1',
      objective: 'x',
      status: 'active',
      setAt: 500,
      limits: { costUsd: 7, maxTurns: 5, stallTurns: 2 },
      baselineCostUsd: 2,
      turns: 0,
      stalls: 0,
      activeMs: 0,
      activeSince: 500
    })
    limits.maxTurns = 99
    expect(goal.limits.maxTurns).toBe(5)
  })
})

describe('GS-2 pause / resume', () => {
  it('暂停进行中的：记原因、累计这一段、去掉 activeSince；入参不变', () => {
    const goal = frozen(active({ activeMs: 100, activeSince: 1000 }))
    const paused = pauseGoal(goal, 'user', 1500)
    const { activeSince: _dropped, ...rest } = active({ activeMs: 600 })
    expect(paused).toStrictEqual({ ...rest, status: 'paused', pauseReason: 'user' })
    expect('activeSince' in paused).toBe(false)
    expect(goal.status).toBe('active')
  })

  it('不在进行中的（暂停中 / 已达成）原样交回同一个对象', () => {
    const paused = pauseGoal(active(), 'user', 1500)
    expect(pauseGoal(paused, 'budget', 2000)).toBe(paused)
    const met = { ...active(), status: 'met' as const }
    expect(pauseGoal(met, 'user', 2000)).toBe(met)
  })

  it('恢复暂停的：进行中、去掉原因、停滞清零、轮数与累计保留、activeSince = now；入参不变', () => {
    const paused = frozen({ ...pauseGoal(active({ turns: 4, stalls: 2 }), 'stalled', 1500) })
    const resumed = resumeGoal(paused, 3000)
    expect(resumed.status).toBe('active')
    expect('pauseReason' in resumed).toBe(false)
    expect(resumed.stalls).toBe(0)
    expect(resumed.turns).toBe(4)
    expect(resumed.activeMs).toBe(500)
    expect(resumed.activeSince).toBe(3000)
    expect(paused.status).toBe('paused')
  })

  it('恢复不是暂停中的（进行中 / 已达成）原样', () => {
    const goal = active()
    expect(resumeGoal(goal, 3000)).toBe(goal)
    const met = { ...active(), status: 'met' as const }
    expect(resumeGoal(met, 3000)).toBe(met)
  })
})

describe('GS-3 editGoal', () => {
  it('换原文 → 停滞清零；同一原文 → 停滞保留', () => {
    const goal = active({ stalls: 2 })
    expect(editGoal(goal, { objective: 'Ship it' })).toMatchObject({
      objective: 'Ship it',
      stalls: 0
    })
    expect(editGoal(goal, { objective: goal.objective })).toMatchObject({ stalls: 2 })
  })

  it('只改上限 → 合并，原文与停滞不动；暂停中的也能改', () => {
    const goal = active({ stalls: 1 })
    const edited = editGoal(goal, { limits: { costUsd: 20 } })
    expect(edited.limits).toStrictEqual({ costUsd: 20, maxTurns: 50, stallTurns: 3 })
    expect(edited.stalls).toBe(1)
    const paused = pauseGoal(goal, 'budget', 2000)
    expect(editGoal(paused, { limits: { costUsd: 20 } }).limits.costUsd).toBe(20)
  })

  it('终态（met / impossible）原样交回', () => {
    for (const status of ['met', 'impossible'] as const) {
      const goal = { ...active(), status }
      expect(editGoal(goal, { objective: 'Ship it', limits: { costUsd: 20 } })).toBe(goal)
    }
  })
})

describe('GS-4 mergeLimits', () => {
  const base: GoalLimits = { costUsd: 5, maxTurns: 50, stallTurns: 3, wallClockMin: 60 }

  it('没有补丁 → 拷贝（不是同一个对象）', () => {
    const merged = mergeLimits(base, undefined)
    expect(merged).toStrictEqual(base)
    expect(merged).not.toBe(base)
  })

  it('花费、时长给 undefined 或 null → 不限（删掉）；轮数、停滞给 undefined / null → 保持', () => {
    expect(mergeLimits(base, { costUsd: undefined })).toStrictEqual({
      maxTurns: 50,
      stallTurns: 3,
      wallClockMin: 60
    })
    expect(mergeLimits(base, { costUsd: null })).toStrictEqual({
      maxTurns: 50,
      stallTurns: 3,
      wallClockMin: 60
    })
    expect(mergeLimits(base, { wallClockMin: undefined })).toStrictEqual({
      costUsd: 5,
      maxTurns: 50,
      stallTurns: 3
    })
    expect(mergeLimits(base, { wallClockMin: null })).toStrictEqual({
      costUsd: 5,
      maxTurns: 50,
      stallTurns: 3
    })
    expect(mergeLimits(base, { maxTurns: undefined })).toStrictEqual(base)
    expect(
      mergeLimits(base, { maxTurns: null, stallTurns: null } as GoalLimitsPatch)
    ).toStrictEqual(base)
  })

  it.each([-1, 0, Number.NaN, Number.POSITIVE_INFINITY, '10'])('非法值 %s 忽略', (value) => {
    const patch = {
      costUsd: value,
      maxTurns: value,
      stallTurns: value,
      wallClockMin: value
    } as unknown as GoalLimitsPatch
    expect(mergeLimits(base, patch)).toStrictEqual(base)
  })

  it('轮数、停滞取整且至少 1；花费、时长原样', () => {
    expect(mergeLimits(base, { maxTurns: 0.4 }).maxTurns).toBe(1)
    expect(mergeLimits(base, { stallTurns: 2.6 }).stallTurns).toBe(3)
    expect(mergeLimits(base, { costUsd: 0.5, wallClockMin: 1.5 })).toMatchObject({
      costUsd: 0.5,
      wallClockMin: 1.5
    })
  })
})

describe('GS-5 guardHit', () => {
  const now = 1000 + 30 * 60_000
  const all = active({
    turns: 50,
    stalls: 3,
    limits: { costUsd: 5, maxTurns: 50, stallTurns: 3, wallClockMin: 30 }
  })

  it('次序：budget > turns > stalled > wall-clock', () => {
    expect(guardHit(all, { costUsd: 5, now })).toBe('budget')
    expect(guardHit(all, { costUsd: 0, now })).toBe('turns')
    expect(guardHit({ ...all, turns: 0 }, { costUsd: 0, now })).toBe('stalled')
    expect(guardHit({ ...all, turns: 0, stalls: 0 }, { costUsd: 0, now })).toBe('wall-clock')
    expect(guardHit({ ...all, turns: 0, stalls: 0 }, { costUsd: 0, now: now - 1 })).toBeUndefined()
  })

  it('等于即撞；少一点不撞', () => {
    const goal = active()
    expect(guardHit(goal, { costUsd: 4.99, now: 2000 })).toBeUndefined()
    expect(guardHit(goal, { costUsd: 5, now: 2000 })).toBe('budget')
    expect(guardHit(active({ turns: 49 }), { costUsd: 0, now: 2000 })).toBeUndefined()
    expect(guardHit(active({ stalls: 2 }), { costUsd: 0, now: 2000 })).toBeUndefined()
  })

  it('没有花费上限：花多少都不撞预算', () => {
    const goal = active({ limits: { maxTurns: 50, stallTurns: 3 } })
    expect(guardHit(goal, { costUsd: 1e9, now: 2000 })).toBeUndefined()
  })

  it('时长算上累计 + 当前时段', () => {
    const goal = active({
      activeMs: 20 * 60_000,
      activeSince: 0,
      limits: { maxTurns: 50, stallTurns: 3, wallClockMin: 30 }
    })
    expect(guardHit(goal, { costUsd: 0, now: 10 * 60_000 - 1 })).toBeUndefined()
    expect(guardHit(goal, { costUsd: 0, now: 10 * 60_000 })).toBe('wall-clock')
    const notRunning = { ...goal, activeSince: undefined }
    expect(guardHit(notRunning, { costUsd: 0, now: 1e12 })).toBeUndefined()
  })
})

describe('GS-6 afterRun 的次序（§4.1）', () => {
  it('(a) 没有目标 / 目标不在进行中 → none', () => {
    expect(afterRun(undefined, runFacts())).toEqual({ action: 'none' })
    expect(afterRun(pauseGoal(active(), 'user', 1500), runFacts())).toEqual({ action: 'none' })
    expect(afterRun({ ...active(), status: 'met' }, runFacts())).toEqual({ action: 'none' })
  })

  it('(b) 中止：先于后台工作与超支 → 暂停 stopped', () => {
    const decision = afterRun(
      active(),
      runFacts({ outcome: 'aborted', backgroundWork: true, costUsd: 99 })
    )
    expect(decision).toMatchObject({
      action: 'pause',
      reason: 'stopped',
      goal: { status: 'paused', pauseReason: 'stopped' }
    })
  })

  it('(c) 出错：先于后台工作 → 暂停 run-error', () => {
    const decision = afterRun(active(), runFacts({ outcome: 'error', backgroundWork: true }))
    expect(decision).toMatchObject({ action: 'pause', reason: 'run-error' })
  })

  it('(d) 正常结束、有后台工作、超支 → wait（后台工作先于护栏；停滞不动）', () => {
    expect(
      afterRun(active({ stalls: 2 }), runFacts({ backgroundWork: true, costUsd: 99, toolCalls: 0 }))
    ).toEqual({
      action: 'wait'
    })
  })

  it('(e)(f) 没有工具调用 / 全部失败 → judge，noProgress true；停滞不在这里加', () => {
    const goal = active({ stalls: 1 })
    const none = afterRun(goal, runFacts({ toolCalls: 0, toolSucceeded: 0 }))
    expect(none).toEqual({ action: 'judge', goal, noProgress: true })
    const failed = afterRun(goal, runFacts({ toolCalls: 3, toolSucceeded: 0 }))
    expect(failed).toEqual({ action: 'judge', goal, noProgress: true })
  })

  it('(g) 有一次成功 → judge，noProgress false；停滞照旧（清零在 applyVerdict）', () => {
    const goal = active({ stalls: 2 })
    expect(afterRun(goal, runFacts({ toolCalls: 3, toolSucceeded: 1 }))).toEqual({
      action: 'judge',
      goal,
      noProgress: false
    })
  })

  it('(h) 护栏已撞（轮数满、超支、停滞满）：afterRun 不查护栏，照样 judge —— 最后一轮的活也要判', () => {
    const goal = active({ turns: 50, stalls: 3 })
    const decision = afterRun(goal, runFacts({ costUsd: 99 }))
    expect(decision).toEqual({ action: 'judge', goal, noProgress: false })
  })

  it('(i) 干净的一轮 → judge，交回的是同一份记录', () => {
    const goal = active()
    const decision = afterRun(goal, runFacts())
    expect(decision.action).toBe('judge')
    expect((decision as { goal: GoalRecord }).goal).toBe(goal)
  })
})

describe('GS-7 applyVerdict', () => {
  const facts = { costUsd: 1, now: 5000, noProgress: false }

  it('没有结论 → 暂停 judge-unavailable', () => {
    expect(applyVerdict(active(), null, facts)).toMatchObject({
      action: 'pause',
      reason: 'judge-unavailable',
      goal: { status: 'paused', pauseReason: 'judge-unavailable' }
    })
  })

  it('met：结束、理由去空白、endedAt、累计时长、去掉 activeSince、轮数不变', () => {
    const decision = applyVerdict(
      active({ turns: 3, activeMs: 100, activeSince: 1000 }),
      { verdict: 'met', reason: '  all green \n' },
      { ...facts, at: 4000 }
    )
    expect(decision.action).toBe('finish')
    const goal = (decision as { goal: GoalRecord }).goal
    expect(goal).toMatchObject({ status: 'met', endedAt: 5000, turns: 3, activeMs: 4100 })
    expect(goal.lastVerdict).toStrictEqual({ verdict: 'met', reason: 'all green', at: 4000 })
    expect('activeSince' in goal).toBe(false)
  })

  it('impossible：同样结束', () => {
    const decision = applyVerdict(active(), { verdict: 'impossible', reason: 'no access' }, facts)
    expect(decision).toMatchObject({
      action: 'finish',
      goal: { status: 'impossible', endedAt: 5000 }
    })
  })

  it('not_met：续跑、轮数 +1、空白的下一步不记、at 缺省 = now', () => {
    const decision = applyVerdict(
      active({ turns: 2 }),
      { verdict: 'not_met', reason: 'tests fail', next_step: '  ' },
      facts
    )
    expect(decision.action).toBe('continue')
    const goal = (decision as { goal: GoalRecord }).goal
    expect(goal.turns).toBe(3)
    expect(goal.lastVerdict).toStrictEqual({ verdict: 'not_met', reason: 'tests fail', at: 5000 })
    const withNext = applyVerdict(
      active(),
      { verdict: 'not_met', reason: 'x', next_step: ' run it ' },
      facts
    )
    expect((withNext as { goal: GoalRecord }).goal.lastVerdict?.nextStep).toBe('run it')
  })

  it('目标不在进行中 / 没有目标 → none', () => {
    const paused = pauseGoal(active(), 'user', 1500)
    expect(applyVerdict(paused, { verdict: 'not_met', reason: 'x' }, facts)).toEqual({
      action: 'none'
    })
    expect(applyVerdict(undefined, { verdict: 'met', reason: 'x' }, facts)).toEqual({
      action: 'none'
    })
  })
})

describe('GS-8 理由逐字重复', () => {
  const facts = { costUsd: 0, now: 5000, noProgress: false }
  const last = (verdict: 'met' | 'not_met', reason: string): GoalRecord['lastVerdict'] => ({
    verdict,
    reason,
    at: 1
  })

  it('上一次 not_met "X"，这一次 " X " → 停滞 +1', () => {
    const decision = applyVerdict(
      active({ stalls: 0, lastVerdict: last('not_met', 'X') }),
      { verdict: 'not_met', reason: ' X ' },
      facts
    )
    expect((decision as { goal: GoalRecord }).goal.stalls).toBe(1)
  })

  it('上一次 met "X"（被用户恢复过）→ 不算重复，停滞清零', () => {
    const decision = applyVerdict(
      active({ stalls: 1, lastVerdict: last('met', 'X') }),
      { verdict: 'not_met', reason: 'X' },
      facts
    )
    expect((decision as { goal: GoalRecord }).goal.stalls).toBe(0)
  })

  it('两次都是空理由 → 不算重复', () => {
    const decision = applyVerdict(
      active({ stalls: 1, lastVerdict: last('not_met', '') }),
      { verdict: 'not_met', reason: '  ' },
      facts
    )
    expect((decision as { goal: GoalRecord }).goal.stalls).toBe(0)
  })

  it('换了理由、有进展 → 清零', () => {
    const decision = applyVerdict(
      active({ stalls: 2, lastVerdict: last('not_met', 'X') }),
      { verdict: 'not_met', reason: 'Y' },
      facts
    )
    expect((decision as { goal: GoalRecord }).goal.stalls).toBe(0)
  })
})

describe('GS-9 护栏在判定之后（最后一次续跑的成果也要判）', () => {
  it('轮数差一到上限：not_met → 续跑到 turns = maxTurns；下一轮跑完照样判；not_met → 暂停 turns', () => {
    const goal = active({ turns: 49 })
    const first = applyVerdict(
      goal,
      { verdict: 'not_met', reason: 'a' },
      { costUsd: 0, now: 2000, noProgress: false }
    )
    expect(first.action).toBe('continue')
    const continued = (first as { goal: GoalRecord }).goal
    expect(continued.turns).toBe(50)

    expect(afterRun(continued, runFacts()).action).toBe('judge')
    const last = applyVerdict(
      continued,
      { verdict: 'not_met', reason: 'b' },
      { costUsd: 0, now: 3000, noProgress: false }
    )
    expect(last).toMatchObject({
      action: 'pause',
      reason: 'turns',
      goal: { status: 'paused', turns: 50 }
    })
    // 那一次判定的结论照样记下（界面显示最后一次检查）
    expect((last as { goal: GoalRecord }).goal.lastVerdict).toMatchObject({
      verdict: 'not_met',
      reason: 'b'
    })
  })

  it('达成优先于上限：轮数满、超支、停滞满时判 met → 结束（不是暂停）', () => {
    const goal = active({ turns: 50, stalls: 3 })
    const decision = applyVerdict(
      goal,
      { verdict: 'met', reason: 'done' },
      { costUsd: 99, now: 3000, noProgress: true }
    )
    expect(decision).toMatchObject({ action: 'finish', goal: { status: 'met' } })
  })

  it('超支时判 not_met → 暂停 budget（不是 turns）', () => {
    const decision = applyVerdict(
      active({ turns: 50 }),
      { verdict: 'not_met', reason: 'x' },
      { costUsd: 5, now: 3000, noProgress: false }
    )
    expect(decision).toMatchObject({ action: 'pause', reason: 'budget' })
  })
})

describe('GS-10 停滞按 §6.3 计', () => {
  /** 一个周期：afterRun → applyVerdict（同一时刻） */
  function cycle(
    goal: GoalRecord,
    run: Partial<RunEndFacts>,
    reason: string
  ): ReturnType<typeof applyVerdict> {
    const decision = afterRun(goal, runFacts(run))
    if (decision.action !== 'judge') throw new Error(`expected judge, got ${decision.action}`)
    return applyVerdict(
      decision.goal,
      { verdict: 'not_met', reason },
      { costUsd: 0, now: 3000, noProgress: decision.noProgress }
    )
  }

  it('(a) 每轮都有成功的工具调用、理由逐字重复：停滞 0 → 1 → 2 → 第 4 次判定暂停 stalled', () => {
    let goal = active()
    const stalls: number[] = []
    for (let n = 0; n < 3; n++) {
      const decision = cycle(goal, { toolCalls: 2, toolSucceeded: 2 }, 'same reason')
      expect(decision.action).toBe('continue')
      goal = (decision as { goal: GoalRecord }).goal
      stalls.push(goal.stalls)
    }
    expect(stalls).toEqual([0, 1, 2])
    const fourth = cycle(goal, { toolCalls: 2, toolSucceeded: 2 }, 'same reason')
    expect(fourth).toMatchObject({ action: 'pause', reason: 'stalled', goal: { stalls: 3 } })
  })

  it('(b) 两轮都没有工具调用、同一理由：停滞 = 2，不提前暂停（同一周期不重复计）', () => {
    let goal = active()
    const first = cycle(goal, { toolCalls: 0, toolSucceeded: 0 }, 'R')
    expect(first.action).toBe('continue')
    goal = (first as { goal: GoalRecord }).goal
    expect(goal.stalls).toBe(1)
    const second = cycle(goal, { toolCalls: 0, toolSucceeded: 0 }, 'R')
    expect(second.action).toBe('continue')
    expect((second as { goal: GoalRecord }).goal.stalls).toBe(2)
  })
})

describe('GS-11 budgetCrossed', () => {
  it('进行中 + 有上限 + 到了 → true；暂停中 / 没上限 / 没目标 → false', () => {
    expect(budgetCrossed(active(), 5)).toBe(true)
    expect(budgetCrossed(active(), 4.99)).toBe(false)
    expect(budgetCrossed(pauseGoal(active(), 'user', 1500), 99)).toBe(false)
    expect(budgetCrossed(active({ limits: { maxTurns: 50, stallTurns: 3 } }), 99)).toBe(false)
    expect(budgetCrossed(undefined, 99)).toBe(false)
  })
})

describe('GS-12 resumeBlockedBy', () => {
  it('预算 / 轮数 / 时长仍撞着 → 拒绝恢复（交回原因）；停滞不挡；都没撞 → undefined', () => {
    const paused = (over: Partial<GoalRecord>): GoalRecord =>
      pauseGoal(active(over), 'budget', 1500)
    expect(resumeBlockedBy(paused({}), { costUsd: 5, now: 2000 })).toBe('budget')
    expect(resumeBlockedBy(paused({ turns: 50 }), { costUsd: 0, now: 2000 })).toBe('turns')
    expect(resumeBlockedBy(paused({ stalls: 3 }), { costUsd: 0, now: 2000 })).toBeUndefined()
    const timed = pauseGoal(
      active({
        activeMs: 0,
        activeSince: 0,
        limits: { maxTurns: 50, stallTurns: 3, wallClockMin: 1 }
      }),
      'wall-clock',
      60_000
    )
    expect(resumeBlockedBy(timed, { costUsd: 0, now: 1e9 })).toBe('wall-clock')
    expect(resumeBlockedBy(paused({}), { costUsd: 1, now: 2000 })).toBeUndefined()
  })
})
