/**
 * 目标模式的状态机（docs/goal-mode-design.md §2、§4.1、§6）—— 纯函数，不碰存储、不调模型。
 *
 * 宿主（桌面 goalService）在三个位置调它：
 *  - 根运行结束：`afterRun` 决定这次是暂停、跳过（还有后台工作）还是派发判定；
 *  - 判定回来：`applyVerdict` 决定续跑、结束还是暂停；
 *  - 用户操作：`createGoal` / `pauseGoal` / `resumeGoal` / `editGoal`。
 *
 * 护栏一律在这里判，不靠提示词、不让 agent 自己数（§0-3）。返回新记录，不改入参。
 */
import {
  goalActiveMs,
  type GoalLimits,
  type GoalLimitsPatch,
  type GoalPauseReason,
  type GoalRecord,
  type GoalVerdict
} from '@shuvix/chat-protocol/types/goal'

export interface CreateGoalInput {
  id: string
  objective: string
  limits: GoalLimits
  /** 设定时会话已花掉的（美元） */
  baselineCostUsd: number
  now: number
}

export function createGoal(input: CreateGoalInput): GoalRecord {
  return {
    id: input.id,
    objective: input.objective,
    status: 'active',
    setAt: input.now,
    limits: { ...input.limits },
    baselineCostUsd: input.baselineCostUsd,
    turns: 0,
    stalls: 0,
    activeMs: 0,
    activeSince: input.now
  }
}

/** 离开「进行中」：把这一段时长记进累计 */
function leaveActive(goal: GoalRecord, now: number): GoalRecord {
  if (goal.activeSince === undefined) return goal
  const { activeSince: _dropped, ...rest } = goal
  return { ...rest, activeMs: goalActiveMs(goal, now) }
}

export function pauseGoal(goal: GoalRecord, reason: GoalPauseReason, now: number): GoalRecord {
  if (goal.status !== 'active') return goal
  return { ...leaveActive(goal, now), status: 'paused', pauseReason: reason }
}

/** 用户恢复：只有暂停的能恢复；无进展计数清零（护栏在下一次判定前重新检查） */
export function resumeGoal(goal: GoalRecord, now: number): GoalRecord {
  if (goal.status !== 'paused') return goal
  const { pauseReason: _dropped, ...rest } = goal
  return { ...rest, status: 'active', stalls: 0, activeSince: now }
}

/** 编辑原文 / 上限：只对进行中、暂停中的目标；换原文时无进展计数清零 */
export function editGoal(
  goal: GoalRecord,
  change: { objective?: string; limits?: GoalLimitsPatch }
): GoalRecord {
  if (goal.status !== 'active' && goal.status !== 'paused') return goal
  const objectiveChanged = change.objective !== undefined && change.objective !== goal.objective
  return {
    ...goal,
    ...(objectiveChanged ? { objective: change.objective!, stalls: 0 } : {}),
    limits: mergeLimits(goal.limits, change.limits)
  }
}

/**
 * 合并上限：按键覆盖。`null`（或显式的 undefined）= 「不限」—— 只对花费、时长两项有意义（经 JSON 来的补丁只能用 null
 * 表达删除）；轮数、停滞两项不接受「不限」，给 null 就保持原值。非正数、非有限数忽略。
 */
export function mergeLimits(base: GoalLimits, patch: GoalLimitsPatch | undefined): GoalLimits {
  if (patch === undefined) return { ...base }
  const merged: GoalLimits = { ...base }
  for (const key of Object.keys(patch) as Array<keyof GoalLimits>) {
    const value = patch[key]
    if (value === undefined || value === null) {
      if (key === 'costUsd' || key === 'wallClockMin') delete merged[key]
      continue
    }
    if (!Number.isFinite(value) || value <= 0) continue
    if (key === 'maxTurns' || key === 'stallTurns') merged[key] = Math.max(1, Math.round(value))
    else merged[key] = value
  }
  return merged
}

/** 根运行结束时宿主拿到的事实 */
export interface RunEndFacts {
  /** 这一轮怎么结束的 */
  outcome: 'ok' | 'error' | 'aborted'
  /** 根会话名下还有没跑完的后台工作（后台 bash、在跑的子会话） */
  backgroundWork: boolean
  /** 本轮工具调用数 */
  toolCalls: number
  /** 本轮成功的工具调用数（不含失败、被拒、被中断的） */
  toolSucceeded: number
  /** 目标期间的花费（美元） */
  costUsd: number
  now: number
}

export type RunEndDecision =
  | { action: 'none' }
  /** 还有后台工作：这次不判定；它们的完成通知会起一轮，那一轮结束时再来 */
  | { action: 'wait' }
  | { action: 'pause'; goal: GoalRecord; reason: GoalPauseReason }
  /** 派发判定；`noProgress` 交给 `applyVerdict` 计无进展 */
  | { action: 'judge'; goal: GoalRecord; noProgress: boolean }

/** 护栏（§6）：撞上哪一条；都没撞上回 undefined */
export function guardHit(
  goal: GoalRecord,
  facts: { costUsd: number; now: number }
): GoalPauseReason | undefined {
  const { limits } = goal
  if (limits.costUsd !== undefined && facts.costUsd >= limits.costUsd) return 'budget'
  if (goal.turns >= limits.maxTurns) return 'turns'
  if (goal.stalls >= limits.stallTurns) return 'stalled'
  if (limits.wallClockMin !== undefined && goalActiveMs(goal, facts.now) >= limits.wallClockMin * 60_000) {
    return 'wall-clock'
  }
  return undefined
}

/**
 * 根运行结束（§4.1）。次序：怎么结束的 → 还有没有后台工作 → 判定。被询问卡住的轮还没结束，到不了这里。
 *
 * 护栏**不在这里**查，而在判定之后、续跑之前（`applyVerdict`）：最后一轮的活也要判一次 —— 达成优先于上限
 * （2026-11-08 轻裁决，测试设计时发现的「最后一次续跑的成果永远没人判」）。
 */
export function afterRun(goal: GoalRecord | undefined, facts: RunEndFacts): RunEndDecision {
  if (goal === undefined || goal.status !== 'active') return { action: 'none' }
  if (facts.outcome === 'aborted') {
    return { action: 'pause', goal: pauseGoal(goal, 'stopped', facts.now), reason: 'stopped' }
  }
  if (facts.outcome === 'error') {
    return { action: 'pause', goal: pauseGoal(goal, 'run-error', facts.now), reason: 'run-error' }
  }
  if (facts.backgroundWork) return { action: 'wait' }
  return {
    action: 'judge',
    goal,
    noProgress: facts.toolCalls === 0 || facts.toolSucceeded === 0
  }
}

export type VerdictDecision =
  | { action: 'none' }
  | { action: 'continue'; goal: GoalRecord }
  | { action: 'finish'; goal: GoalRecord }
  | { action: 'pause'; goal: GoalRecord; reason: GoalPauseReason }

/**
 * 判定回来（§4.2、§5、§6）。没有结论 → 暂停（判不出来就停，不让目标在没有裁判的情况下一直跑）。达成 / 做不到 → 结束。
 * 没达成：无进展计数（§6.3：这一轮没有工具调用、或全部失败、或理由与上一次逐字相同 → +1，否则清零），再过一遍护栏，
 * 都没撞上才续跑。`at` = 这次判定所依据的事实截止的时刻（下一次判定从这里往后看）。
 */
export function applyVerdict(
  goal: GoalRecord | undefined,
  verdict: GoalVerdict | null,
  facts: { costUsd: number; now: number; noProgress: boolean; at?: number }
): VerdictDecision {
  if (goal === undefined || goal.status !== 'active') return { action: 'none' }
  if (verdict === null) {
    return {
      action: 'pause',
      goal: pauseGoal(goal, 'judge-unavailable', facts.now),
      reason: 'judge-unavailable'
    }
  }
  const reason = verdict.reason.trim()
  const nextStep = verdict.next_step?.trim() || undefined
  const lastVerdict = {
    verdict: verdict.verdict,
    reason,
    ...(nextStep !== undefined ? { nextStep } : {}),
    at: facts.at ?? facts.now
  }
  if (verdict.verdict === 'met' || verdict.verdict === 'impossible') {
    return {
      action: 'finish',
      goal: { ...leaveActive(goal, facts.now), status: verdict.verdict, lastVerdict, endedAt: facts.now }
    }
  }
  const repeated =
    goal.lastVerdict?.verdict === 'not_met' && goal.lastVerdict.reason === reason && reason !== ''
  const judged: GoalRecord = {
    ...goal,
    lastVerdict,
    stalls: facts.noProgress || repeated ? goal.stalls + 1 : 0
  }
  const hit = guardHit(judged, facts)
  if (hit !== undefined) {
    return { action: 'pause', goal: pauseGoal(judged, hit, facts.now), reason: hit }
  }
  return { action: 'continue', goal: { ...judged, turns: judged.turns + 1 } }
}

/**
 * 用户恢复之前：恢复后（无进展清零）仍撞上的护栏 —— 撞上就不恢复，界面请用户先调高上限（否则恢复就是白跑一整轮再暂停）。
 */
export function resumeBlockedBy(
  goal: GoalRecord,
  facts: { costUsd: number; now: number }
): GoalPauseReason | undefined {
  const hit = guardHit({ ...goal, stalls: 0 }, facts)
  return hit === 'stalled' ? undefined : hit
}

/** 运行中花费越过上限（§6.1）：越线就暂停（这一轮由宿主 steer 一条收尾通知，自然结束） */
export function budgetCrossed(goal: GoalRecord | undefined, costUsd: number): boolean {
  return (
    goal !== undefined &&
    goal.status === 'active' &&
    goal.limits.costUsd !== undefined &&
    costUsd >= goal.limits.costUsd
  )
}
