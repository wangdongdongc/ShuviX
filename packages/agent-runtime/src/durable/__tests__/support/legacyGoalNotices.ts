/**
 * 旧目标模式（v0.2.58–v0.2.60：宿主判定、按轮续跑）写给模型的目标通知 —— 单测夹具，不做断言。
 *
 * 写这些通知的代码（agent-runtime `goal/goalNotices.ts`）已随目标的管理员会话改版删掉（docs/goal-mode-design.md §16），
 * 但那几个版本的会话里还有它们：标签照旧登记在 chat-protocol `GOAL_NOTICE_TAGS`，转写摘要与投影必须照旧把它们认成
 * 通知、不算人说的话。下面**照抄**当时的拼法（信封、转义、各行文字），产出的正文与旧渲染函数逐字相同。
 *
 * 转义是当时的安全边界，夹具照样保留：目标原文与判定理由里的 `</goal-continue>` 之类不转义，块就会提前闭合、
 * 正文不再是通知形状。
 */

/** 旧目标记录里通知用得到的几项 */
export interface LegacyGoal {
  id: string
  /** 用户的原话 */
  objective: string
  /** 宿主为目标续跑过的轮数 */
  turns: number
  /** 续跑轮数上限 */
  maxTurns: number
}

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (text: string): string => escapeText(text).replace(/"/g, '&quot;')

function block(kind: string, attrs: Record<string, string>, body: string): string {
  const attrText = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
    .join('')
  return `<${kind}${attrText}>\n${body}\n</${kind}>`
}

const objectiveBlock = (objective: string): string =>
  `<objective>\n${escapeText(objective)}\n</objective>`

const usageLine = (goal: LegacyGoal): string =>
  `Used: continuation ${goal.turns} of ${goal.maxTurns}.`

/** 续跑（判定 not_met）：`renderGoalContinue` */
export function legacyGoalContinue(
  goal: LegacyGoal,
  verdict: { reason: string; nextStep?: string }
): string {
  const lines = [
    "Goal (the user's words, unchanged):",
    objectiveBlock(goal.objective),
    `Not met yet. Checker: ${escapeText(verdict.reason)}`
  ]
  if (verdict.nextStep) lines.push(`Suggested next step: ${escapeText(verdict.nextStep)}`)
  lines.push(usageLine(goal))
  lines.push('Keep working toward the goal. Show the checks you run and their results.')
  return block('goal-continue', { id: goal.id, turn: String(goal.turns) }, lines.join('\n'))
}

/** 后台工作等了很久：`renderGoalCheckin` */
export function legacyGoalCheckin(goal: LegacyGoal, waitedMin: number): string {
  return block(
    'goal-checkin',
    { id: goal.id, waited: `${Math.round(waitedMin)}m` },
    [
      `Background work for the goal has been running for ${Math.round(waitedMin)} minutes.`,
      'List what is still running and read its output. If it is making progress, keep waiting (do not poll in a loop). If it is stuck, fix or stop it and carry on with the goal:',
      objectiveBlock(goal.objective)
    ].join('\n')
  )
}

/** 目标原文被用户改了：`renderGoalUpdated` */
export function legacyGoalUpdated(goal: LegacyGoal): string {
  return block(
    'goal-updated',
    { id: goal.id },
    [
      'The user changed the goal. From now on, work toward this instead:',
      objectiveBlock(goal.objective)
    ].join('\n')
  )
}

/** 目标的结局：`renderGoalStatus`（达成 / 做不到带理由；因续跑轮数到上限而暂停，可带一句补充） */
export function legacyGoalStatus(
  goal: LegacyGoal,
  status:
    | { event: 'met' | 'impossible'; reason: string }
    | { event: 'paused'; reason: 'turns'; detail?: string }
): string {
  if (status.event === 'paused') {
    const text =
      'The goal reached its limit on continuations, so it is paused.' +
      (status.detail ? ` ${escapeText(status.detail)}` : '')
    return block('goal-status', { id: goal.id, event: 'paused', reason: status.reason }, text)
  }
  return block(
    'goal-status',
    { id: goal.id, event: status.event },
    `The checker judged the goal ${status.event}: ${escapeText(status.reason)} Stop working on it.`
  )
}

/** v0.2.58–v0.2.59 写的花费越线收尾通知（`renderGoalBudget`，2026-11-09 删掉） */
export const LEGACY_GOAL_BUDGET =
  '<goal-budget id="g_1">\nThe goal\'s spending limit is reached (Used: $6.00 of $5.00 · continuation 2 of 50.)\n' +
  'Finish this turn soon: stop starting new work, and say what is done, what is verified, and what remains. ' +
  'The goal is paused until the user raises the limit.\n</goal-budget>'
