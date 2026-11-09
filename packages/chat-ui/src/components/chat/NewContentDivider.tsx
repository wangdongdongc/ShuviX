/**
 * 「新内容」分隔线（docs/inbox-read-state-design.md §7）：打开一条有新回复的会话时，画在你上次没看过的那部分之前
 * （Slack / Discord 的 New 线）。落点不变（仍是底部），这条线只是告诉你从哪里读起。
 */
import { useTranslation } from 'react-i18next'

/** 今天的写时分；更早的写月-日 时分 */
function timeLabel(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

export function NewContentDivider({ at }: { at: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      role="separator"
      aria-label={t('chat.newContent')}
      data-new-content-divider=""
      className="max-w-[784px] mx-auto flex items-center gap-2.5 px-4 pb-1 pt-3"
    >
      <span className="h-px flex-1 bg-accent/45" />
      <span className="text-[11px] font-semibold text-accent tabular-nums">
        {t('chat.newContent')} · {timeLabel(at)}
      </span>
      <span className="h-px flex-1 bg-accent/45" />
    </div>
  )
}
