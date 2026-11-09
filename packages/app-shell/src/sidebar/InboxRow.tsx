/**
 * 侧栏最上面的「收件箱」一行（2026-11-09，第一版）：点开主区的收件箱页（InboxPage）。
 *
 * 行尾是此刻在运行的会话数；其中有会话在等你回答时，数字前多一个琥珀色的跳动点 —— 与会话行上的询问点
 * 同一个记号，折叠着的分组里那条会话在等你，这里也看得见。没有在运行的会话时行尾什么也不画。
 */

import { useTranslation } from 'react-i18next'
import { Inbox } from 'lucide-react'
import { useInboxSections, useInboxStore } from '../inbox/inboxStore'
import { useFocusDim } from './useFocusDim'

export function InboxRow(): React.JSX.Element {
  const { t } = useTranslation()
  const { dim } = useFocusDim()
  const open = useInboxStore((s) => s.open)
  const openInbox = useInboxStore((s) => s.openInbox)
  const { waiting, running } = useInboxSections()
  const total = waiting.length + running.length

  return (
    <button
      type="button"
      data-inbox-row=""
      data-inbox-count={total}
      data-inbox-waiting={waiting.length > 0 ? waiting.length : undefined}
      aria-current={open ? 'page' : undefined}
      onClick={openInbox}
      className={`sb-row w-full cursor-pointer text-left transition-opacity duration-200 ${
        open
          ? 'bg-bg-active/80 text-text-primary'
          : `text-text-primary hover:bg-bg-hover/60 ${dim ? 'opacity-30 hover:opacity-100' : ''}`
      }`}
    >
      <Inbox className="sb-icon text-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{t('inbox.title')}</span>
      {waiting.length > 0 && (
        <span
          className="relative flex h-1.5 w-1.5 shrink-0"
          title={t('inbox.summaryWaitingTitle', { count: waiting.length })}
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
        </span>
      )}
      {total > 0 && (
        <span className="shrink-0 text-[0.85em] tabular-nums text-text-tertiary">{total}</span>
      )}
    </button>
  )
}
