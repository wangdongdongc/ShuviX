/**
 * 侧栏「资料库」一节的第一行「收件箱」（2026-11-10 起在这里，智能体上面）：点开主区的收件箱页（InboxPage）。
 *
 * 行尾的数字是要你处理或看一眼的：在等你回答的会话 + 有新回复没看的会话（docs/inbox-read-state-design.md D4；
 * 只是在跑的不算）。有会话在等你回答时数字前多一个琥珀色的跳动点 —— 与会话行上的询问点同一个记号，折叠着的
 * 分组里那条会话在等你，这里也看得见。都没有时行尾什么也不画。
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
  const { waiting, unread } = useInboxSections()
  const total = waiting.length + unread.length

  return (
    <button
      type="button"
      data-inbox-row=""
      data-inbox-count={total}
      data-inbox-waiting={waiting.length > 0 ? waiting.length : undefined}
      aria-current={open ? 'page' : undefined}
      onClick={openInbox}
      className={`sb-row mb-px w-full cursor-pointer text-left transition-opacity duration-200 ${
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
