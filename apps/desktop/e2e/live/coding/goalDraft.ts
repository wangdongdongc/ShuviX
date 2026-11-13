/**
 * Goal text for the coding probe's goal arms: the `goal-oracle` arm's text (the request plus the task's hidden
 * facts as an explicit "done when" list, the upper bound of what a goal can say) and the cut to the goal's
 * 4000-character limit. No model, no app: the probe's self-check runs both.
 *
 * The heading is Chinese because every task's request is (the goal text reads as the user's).
 */
import { GOAL_OBJECTIVE_MAX_CHARS } from '@shuvix/chat-protocol/types/goal'
import type { CodingTask } from './tasks'

/**
 * The goal-oracle arm's text: the request, then "done when" with one item per hidden fact and the request's
 * own end condition last.
 */
export function goalTextOracle(task: CodingTask): string {
  const items = [
    ...(task.user?.facts ?? []).map((f) => f.text),
    ...(task.endCondition ? [task.endCondition] : [])
  ]
  if (!items.length) return task.prompt.trim()
  return [
    task.prompt.trim(),
    '',
    '做完的标准（每一条都要做到）：',
    ...items.map((t, i) => `${i + 1}. ${t}`)
  ].join('\n')
}

/** The goal's text cut to the product's limit (trimmed length ≤ 4000); `truncatedChars` = what was cut */
export function fitObjective(text: string): { text: string; truncatedChars: number } {
  const t = text.trim()
  if (t.length <= GOAL_OBJECTIVE_MAX_CHARS) return { text: t, truncatedChars: 0 }
  const kept = t.slice(0, GOAL_OBJECTIVE_MAX_CHARS - 1).trimEnd()
  return { text: `${kept}…`, truncatedChars: t.length - kept.length }
}
