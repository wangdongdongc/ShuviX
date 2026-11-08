/**
 * 目标模式写给模型的文字（docs/goal-mode-design.md §5）：宿主的各种目标通知（`goal-*` 信封，登记在 chat-protocol `GOAL_NOTICE_TAGS`）。模型面向，英文。
 *
 * **转义是安全边界**：通知要被认成通知，整段正文必须只由完整的 `<goal-…>…</goal-…>` 块组成。目标原文是用户写的，
 * 判定理由是判定 agent 写的（它读过干活的 agent 的输出），两者都可能含 `</goal-continue>` 之类的字样 —— 不转义，
 * 块就会提前闭合、正文不再是通知形状，整段续跑消息（连同判定理由）就会被转写摘要当成人说的话。所以插进信封的每一段
 * 文字都过 `escapeGoalText`，属性值过 `escapeGoalAttr`。
 */
import type { GoalNoticeKind } from '@shuvix/chat-protocol/systemNoticeContract'
import type { GoalPauseReason, GoalRecord } from '@shuvix/chat-protocol/types/goal'

/** 文本内容转义：`&` `<` `>` */
export function escapeGoalText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 属性值转义：再加双引号 */
export function escapeGoalAttr(text: string): string {
  return escapeGoalText(text).replace(/"/g, '&quot;')
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

/** 「用了多少、还剩多少」一行 */
export function goalUsageLine(goal: GoalRecord, costUsd: number): string {
  const cost =
    goal.limits.costUsd !== undefined
      ? `${money(costUsd)} of ${money(goal.limits.costUsd)}`
      : `${money(costUsd)} (no spending limit)`
  return `Used: ${cost} · continuation ${goal.turns} of ${goal.limits.maxTurns}.`
}

function block(kind: GoalNoticeKind, attrs: Record<string, string>, body: string): string {
  const attrText = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeGoalAttr(value)}"`)
    .join('')
  return `<${kind}${attrText}>\n${body}\n</${kind}>`
}

function objectiveBlock(objective: string): string {
  return `<objective>\n${escapeGoalText(objective)}\n</objective>`
}

/** 续跑（判定 not_met）：每轮重述目标原文 —— 压缩多少次，最近一条续跑消息都带着完整目标（§5） */
export function renderGoalContinue(
  goal: GoalRecord,
  costUsd: number,
  verdict: { reason: string; nextStep?: string }
): string {
  const lines = [
    "Goal (the user's words, unchanged):",
    objectiveBlock(goal.objective),
    `Not met yet. Checker: ${escapeGoalText(verdict.reason)}`
  ]
  if (verdict.nextStep) lines.push(`Suggested next step: ${escapeGoalText(verdict.nextStep)}`)
  lines.push(goalUsageLine(goal, costUsd))
  lines.push('Keep working toward the goal. Show the checks you run and their results.')
  return block('goal-continue', { id: goal.id, turn: String(goal.turns) }, lines.join('\n'))
}

/** 恢复（用户点继续）且会话空闲：先让它接着干，跑完照常判定 */
export function renderGoalResumed(goal: GoalRecord, costUsd: number): string {
  return block(
    'goal-continue',
    { id: goal.id, turn: String(goal.turns), resumed: 'true' },
    [
      'The user resumed this goal. Goal (unchanged):',
      objectiveBlock(goal.objective),
      goal.lastVerdict ? `Last check: ${escapeGoalText(goal.lastVerdict.reason)}` : '',
      goalUsageLine(goal, costUsd),
      'Continue working toward it.'
    ]
      .filter((line) => line !== '')
      .join('\n')
  )
}

/** 后台工作等了很久（§4.1）：让 agent 看看在跑的任务，卡住的处理掉 */
export function renderGoalCheckin(goal: GoalRecord, waitedMin: number): string {
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

/** 运行中花费越线（§6.1）：这一轮收尾，说明做到哪了 */
export function renderGoalBudget(goal: GoalRecord, costUsd: number): string {
  return block(
    'goal-budget',
    { id: goal.id },
    [
      `The goal's spending limit is reached (${goalUsageLine(goal, costUsd)})`,
      'Finish this turn soon: stop starting new work, and say what is done, what is verified, and what remains. The goal is paused until the user raises the limit.'
    ].join('\n')
  )
}

/** 目标原文被用户改了 */
export function renderGoalUpdated(goal: GoalRecord): string {
  return block(
    'goal-updated',
    { id: goal.id },
    ['The user changed the goal. From now on, work toward this instead:', objectiveBlock(goal.objective)].join(
      '\n'
    )
  )
}

export type GoalStatusEvent =
  | { event: 'met' | 'impossible'; reason: string }
  | { event: 'paused'; reason: GoalPauseReason; detail?: string }
  | { event: 'cleared' | 'replaced' }

const PAUSE_TEXT: Record<GoalPauseReason, string> = {
  user: 'The user paused the goal.',
  stopped: 'The user stopped the turn, so the goal is paused.',
  restart: 'ShuviX restarted while the goal was in progress, so the goal is paused.',
  forked: 'This session was forked from another one, so the goal is paused here.',
  budget: "The goal's spending limit is reached, so the goal is paused.",
  turns: 'The goal reached its limit on continuations, so it is paused.',
  stalled: 'Several turns in a row made no progress, so the goal is paused.',
  'wall-clock': 'The goal reached its time limit, so it is paused.',
  'judge-unavailable': 'The goal checker gave no verdict, so the goal is paused.',
  'run-error': 'The turn ended with an error, so the goal is paused.'
}

/** 目标的结局：写进转写（不起轮），模型下一次说话时看到，界面画成通知行 */
export function renderGoalStatus(goal: GoalRecord, status: GoalStatusEvent): string {
  let text: string
  switch (status.event) {
    case 'met':
      text = `The checker judged the goal met: ${escapeGoalText(status.reason)} Stop working on it.`
      break
    case 'impossible':
      text = `The checker judged the goal impossible: ${escapeGoalText(status.reason)} Stop working on it.`
      break
    case 'paused':
      text = PAUSE_TEXT[status.reason] + (status.detail ? ` ${escapeGoalText(status.detail)}` : '')
      break
    case 'cleared':
      text = 'The user cleared the goal. Do not continue working toward it unless asked.'
      break
    case 'replaced':
      text = 'The user replaced this goal with a new one.'
      break
  }
  const attrs: Record<string, string> = { id: goal.id, event: status.event }
  if (status.event === 'paused') attrs.reason = status.reason
  return block('goal-status', attrs, text)
}
