/**
 * 收件箱「新回复」那一节的一行（R1，docs/inbox-read-state-design.md §7）：左缘一个蓝点、标题加粗，行尾时间，
 * 最后那张回复的前两行摘录；悬停时行尾出「标为已读」✓。点行 = 打开会话（来到眼前即读过）；摘录只是索引，
 * 列表里看到它不算读过。
 *
 * 摘录要读那条会话的消息：只读收件箱里列出来的前 20 条，按「会话 + 变成未读的时刻」记一次，不重复读。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { getChatApi, RedactedText, RedactionSessionProvider } from '@shuvix/chat-ui'
import { lastReplyText, unreadTimeLabel, type UnreadInboxItem } from './inboxItems'
import { SessionKindIcon } from './InboxItemIcon'

/** 摘录读多少条会话：收件箱里的新回复一般没几条，读太多会把打开收件箱拖慢 */
const EXCERPT_LIMIT = 20

const excerptKey = (item: UnreadInboxItem): string => `${item.session.id}\n${item.unread.since}`

/** 「新回复」各行的摘录：key（会话 + 变成未读的时刻）→ 正文；还没读到的不在表里，读了没有字的是 null */
export function useReplyExcerpts(items: UnreadInboxItem[]): Record<string, string | null> {
  const [excerpts, setExcerpts] = useState<Record<string, string | null>>({})
  const requested = useRef(new Set<string>())
  useEffect(() => {
    for (const item of items.slice(0, EXCERPT_LIMIT)) {
      const key = excerptKey(item)
      if (requested.current.has(key)) continue
      requested.current.add(key)
      getChatApi()
        .message.list(item.session.id)
        .then((messages) => setExcerpts((prev) => ({ ...prev, [key]: lastReplyText(messages) })))
        .catch(() => setExcerpts((prev) => ({ ...prev, [key]: null })))
    }
  }, [items])
  return excerpts
}

export interface InboxUnreadRowProps {
  item: UnreadInboxItem
  location: string | null
  excerpts: Record<string, string | null>
  now: number
  onOpen: (sessionId: string) => void
  /** 宿主给不出「标为已读」（没有 `session.markRead`）时不传，✓ 不出现 */
  onMarkRead?: (sessionId: string) => void
}

export function InboxUnreadRow({
  item,
  location,
  excerpts,
  now,
  onOpen,
  onMarkRead
}: InboxUnreadRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const { session, unread } = item
  const excerpt = excerpts[excerptKey(item)]
  const meta = [location, unread.manual ? t('inbox.markedUnread') : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      data-inbox-unread={session.id}
      className="group relative flex items-start gap-1 rounded-lg transition-colors hover:bg-bg-hover/60"
    >
      <span
        aria-hidden="true"
        className="absolute left-1.5 top-[17px] h-[7px] w-[7px] rounded-full bg-accent"
      />
      <button
        type="button"
        onClick={() => onOpen(session.id)}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg py-2.5 pl-[18px] pr-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          <SessionKindIcon session={session} className="text-text-secondary" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-text-primary">
              <RedactionSessionProvider sessionId={session.id}>
                <RedactedText text={session.title} />
              </RedactionSessionProvider>
            </span>
            {unread.failed && (
              <span
                data-inbox-failed=""
                className="shrink-0 rounded px-1.5 text-[11px] font-medium bg-error/10 text-error"
              >
                {t('inbox.failed')}
              </span>
            )}
            <span className="flex-1" />
            <span className="shrink-0 text-[12px] tabular-nums text-text-secondary">
              {unreadTimeLabel(unread.since, now)}
            </span>
          </span>
          {meta && <span className="truncate text-[12px] text-text-secondary">{meta}</span>}
          {excerpt && (
            <span className="line-clamp-2 text-[13px] leading-relaxed text-text-secondary">
              <RedactionSessionProvider sessionId={session.id}>
                <RedactedText text={excerpt} />
              </RedactionSessionProvider>
            </span>
          )}
        </span>
      </button>
      {onMarkRead && (
        <button
          type="button"
          data-inbox-mark-read={session.id}
          onClick={() => onMarkRead(session.id)}
          title={t('inbox.markRead')}
          aria-label={t('inbox.markRead')}
          className="mr-2 flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md border border-border-primary bg-bg-primary text-text-secondary opacity-0 transition-opacity hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Check size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
