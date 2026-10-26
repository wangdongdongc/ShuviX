import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CalendarDays } from 'lucide-react'
import type { UserTextMessage } from '../../stores/chatStore'
import { SystemNoticeRow } from './SystemNoticeRow'
import { STREAM_PRE_CLASS } from './detailViewport'
import { RedactedText } from './RedactedText'

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD` → 界面语言的完整日期（含星期）；不是日期就回 null */
function formatNoticeDate(date: string | undefined, language: string): string | null {
  const match = date === undefined ? null : ISO_DATE.exec(date)
  if (!match) return null
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (Number.isNaN(day.getTime())) return null
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'full' }).format(day)
  } catch {
    return date ?? null
  }
}

/**
 * 日期通知行 —— 跨天后第一次输入之前，系统告诉模型「今天是哪天、上一条消息隔了多久」的那条通知
 * （agent-runtime `maybeAnnounceDate`，条目种类 `date`）。
 *
 * 它与后台完成通知一样是一条系统写的 user 消息，所以同走 SystemNoticeRow、绝不画成用户气泡；
 * 但它不是「后台任务已完成」—— 标签写日期变更，摘要位放界面语言的日期（顺带当一道日期分隔），
 * 展开态仍是写给模型的原文。日期取投影带来的 `noticeDate`，取不到退回去掉标签的正文。
 */
export function DateNoticeRow({ msg }: { msg: UserTextMessage }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const detail = useMemo(
    () =>
      formatNoticeDate(msg.metadata?.noticeDate, i18n.language) ??
      msg.content.replace(/<\/?date-change>/g, '').trim(),
    [msg.metadata?.noticeDate, msg.content, i18n.language]
  )
  return (
    <SystemNoticeRow
      kind="date"
      icon={<CalendarDays size={12} className="flex-shrink-0 text-accent/70" />}
      label={t('dateNotice.title')}
      detail={detail}
    >
      <pre className={`${STREAM_PRE_CLASS} my-1`}>
        <RedactedText text={msg.content} />
      </pre>
    </SystemNoticeRow>
  )
}
