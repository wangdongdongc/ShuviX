/**
 * 目标栏上的数字与状态句（docs/goal-mode-design.md §9.1）—— 纯函数，`t` 由调用方给。
 *
 * 一行说清：状态 · 第几轮 / 上限 · 花了多少 / 上限 · 进行了多久。轮数只算宿主为目标续跑的轮（用户自己发的不算），
 * 花费是目标期间的增量（含目标期间新建的子会话），时长是处于进行中的累计 —— 都由宿主算好放在 GoalView 里。
 */
import { goalActiveMs, type GoalLimitsPatch, type GoalView } from '@shuvix/chat-protocol/types/goal'

/** 取文案（useTranslation 的 t） */
export type GoalTranslate = (key: string, opts?: Record<string, unknown>) => string

/** 花了多少：两位小数 */
export function formatGoalCost(usd: number): string {
  return `$${Math.max(0, usd).toFixed(2)}`
}

/** 上限：整数不带小数（$10），否则两位（$2.50） */
export function formatGoalLimit(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`
}

/** 进行了多久：`1h 20m` / `5m` / `<1m`（按语言） */
export function formatGoalDuration(ms: number, t: GoalTranslate): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return t('goal.durationUnderMinute')
  if (minutes < 60) return t('goal.durationMinutes', { m: minutes })
  return t('goal.durationHours', { h: Math.floor(minutes / 60), m: minutes % 60 })
}

/** 状态那半句：进行中（判定中 / 等你回答）、暂停（原因）、达成、做不到 */
export function goalStatusText(
  goal: Pick<GoalView, 'status' | 'pauseReason' | 'judging'>,
  opts: { waitingAnswer: boolean },
  t: GoalTranslate
): string {
  switch (goal.status) {
    case 'active':
      if (goal.judging) return t('goal.state.checking')
      return opts.waitingAnswer ? t('goal.state.waiting') : t('goal.state.active')
    case 'paused':
      return t('goal.state.paused', { reason: t(`goal.reason.${goal.pauseReason ?? 'user'}`) })
    case 'met':
      return t('goal.state.met')
    case 'impossible':
      return t('goal.state.impossible')
  }
}

/** 数字那半句：第几轮 / 上限 · 花费 / 上限 · 时长（没进行过就不写时长） */
export function goalMetrics(goal: GoalView, now: number, t: GoalTranslate): string[] {
  const parts = [t('goal.turnOf', { turn: goal.turns, max: goal.limits.maxTurns })]
  parts.push(
    goal.limits.costUsd !== undefined
      ? `${formatGoalCost(goal.costUsd)} / ${formatGoalLimit(goal.limits.costUsd)}`
      : formatGoalCost(goal.costUsd)
  )
  const active = goalActiveMs(goal, now)
  if (active > 0 || goal.status === 'active') parts.push(formatGoalDuration(active, t))
  return parts
}

/** 整行：状态 · 数字 */
export function goalSummaryLine(
  goal: GoalView,
  opts: { waitingAnswer: boolean; now: number },
  t: GoalTranslate
): string {
  return [goalStatusText(goal, opts, t), ...goalMetrics(goal, opts.now, t)].join(' · ')
}

/**
 * 目标编辑器里的上限：解出要交给宿主的补丁；不合法 → 错误文案的键。
 *  - 花费：空 = 不限（`costUsd: null` —— 经 JSON 传不了 undefined），否则 > 0 的美元数；
 *  - 续跑轮数：≥ 1 的整数；
 *  - 时长（分钟）：只在目标本来就有时长上限时出现在表单里（`time` 缺省 = 不改这一项）；空 = 不限，否则 > 0。
 */
export function parseGoalLimitFields(fields: {
  cost: string
  turns: string
  time?: string | null
}): { limits: GoalLimitsPatch } | { errorKey: string } {
  const costText = fields.cost.trim()
  const cost = costText === '' ? null : Number(costText)
  if (cost !== null && (!Number.isFinite(cost) || cost <= 0)) {
    return { errorKey: 'goal.errorCostInvalid' }
  }
  const turns = Number(fields.turns.trim())
  if (!Number.isInteger(turns) || turns < 1) return { errorKey: 'goal.errorTurnsInvalid' }
  const limits: GoalLimitsPatch = { costUsd: cost, maxTurns: turns }
  if (fields.time !== undefined && fields.time !== null) {
    const timeText = fields.time.trim()
    const time = timeText === '' ? null : Number(timeText)
    if (time !== null && (!Number.isFinite(time) || time <= 0)) {
      return { errorKey: 'goal.errorTimeInvalid' }
    }
    limits.wallClockMin = time
  }
  return { limits }
}
