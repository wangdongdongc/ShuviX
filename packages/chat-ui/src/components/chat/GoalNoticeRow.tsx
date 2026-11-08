import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, CirclePause, CircleX, Target } from 'lucide-react'
import type { UserTextMessage } from '../../stores/chatStore'
import { SystemNoticeRow } from './SystemNoticeRow'
import { STREAM_PRE_CLASS } from './detailViewport'
import { RedactedText } from './RedactedText'
import { goalNoticeText, parseGoalNotice, type GoalNoticeInfo } from './goalNotice'

/** 行首图标：结局各有各的（达成 ✓ / 做不到 ✕ / 暂停 ⏸），其余是目标的 ◎ */
function iconOf(info: GoalNoticeInfo | null): React.JSX.Element {
  if (info?.kind === 'goal-status') {
    if (info.event === 'met')
      return <CircleCheck size={12} className="flex-shrink-0 text-success" />
    if (info.event === 'impossible') {
      return <CircleX size={12} className="flex-shrink-0 text-error" />
    }
    if (info.event === 'paused') {
      return <CirclePause size={12} className="flex-shrink-0 text-warning" />
    }
  }
  return <Target size={12} className="flex-shrink-0 text-accent/70" />
}

/**
 * 目标通知行（目标模式，docs/goal-mode-design.md §9.2）—— 宿主写给模型的 `<goal-…>` 信封：续跑（带判定理由）、
 * 长时间等后台工作时的检查、预算收尾、目标改了、目标的结局（达成 / 做不到 / 暂停 / 清除 / 被替换）。
 *
 * 和后台完成通知一样是系统写的 user 消息（投影按 `noticeKind` 认出来），同走 SystemNoticeRow、绝不画成用户气泡：
 * 续跑消息不是用户说的话。折叠时一行人读的摘要，展开是写给模型的原文。
 */
export function GoalNoticeRow({ msg }: { msg: UserTextMessage }): React.JSX.Element {
  const { t } = useTranslation()
  const info = useMemo(() => parseGoalNotice(msg.content), [msg.content])
  const { label, detail } = goalNoticeText(info, t)
  return (
    <div
      data-goal-notice={info?.kind ?? msg.metadata?.noticeKind ?? ''}
      data-goal-event={info?.event}
    >
      <SystemNoticeRow kind="goal" icon={iconOf(info)} label={label} detail={detail}>
        <pre className={`${STREAM_PRE_CLASS} my-1`}>
          <RedactedText text={msg.content} />
        </pre>
      </SystemNoticeRow>
    </div>
  )
}
