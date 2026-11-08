/**
 * 目标的状态记号（目标栏行首）：进行中 ◎（外圈 + 实心圆点，强调色）、暂停中空心 ◎（两道圈，次级色）、
 * 达成 ✓（成功色）、做不到 ✕（错误色）。侧栏用的是同样子的一份（app-shell SessionItem 里，chat-ui 的 DOM 用例
 * 整份 mock 掉 app-shell 用不到这里），改样子两处一起改。
 */
import { CircleCheck, CircleX } from 'lucide-react'
import type { GoalStatus } from '@shuvix/chat-protocol/types/goal'

export function GoalMark({
  status,
  size = 14
}: {
  status: GoalStatus | 'new'
  size?: number
}): React.JSX.Element {
  if (status === 'met') {
    return <CircleCheck size={size} className="flex-shrink-0 text-success" data-goal-mark="met" />
  }
  if (status === 'impossible') {
    return <CircleX size={size} className="flex-shrink-0 text-error" data-goal-mark="impossible" />
  }
  const active = status === 'active'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden
      data-goal-mark={status}
      className={`flex-shrink-0 ${active ? 'text-accent' : 'text-text-tertiary'}`}
    >
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {active ? (
        <circle cx="8" cy="8" r="2.75" fill="currentColor" />
      ) : (
        <circle cx="8" cy="8" r="2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
    </svg>
  )
}
