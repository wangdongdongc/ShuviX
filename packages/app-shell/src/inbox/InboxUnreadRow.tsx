/**
 * 收件箱「新回复」那一节的一行（R1，docs/inbox-read-state-design.md §7）：行首蓝点（这一轮出错是红点）、
 * 标题加粗、最后那张回复的一句、行尾时间；悬停时时间换成「标为已读」✓。点行 = 打开会话（来到眼前即读过）；摘录只是
 * 索引，列表里看到它不算读过。
 *
 * 正开着、作为新回复打开的那条（`item.held`）已经读过，只是留在原处：行首换成宿主给的那枚会话图标（`heldIcon`，
 * 选中的样子），标题不加粗，没有 ✓。
 *
 * 摘录要读那条会话的消息：只读收件箱里列出来的前 20 条，按「会话 + 变成未读的时刻」记一次，不重复读。
 *
 * 那个请求里有任务列表的（2026-11-14）：同一份消息折出来的列表画在标题下面，替掉那一句摘录（InboxTaskList.tsx）。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { getChatApi, RedactedText, RedactionSessionProvider } from '@shuvix/chat-ui'
import { taskListOfMessages, type TaskListSnapshot } from '@shuvix/chat-protocol/taskList'
import { lastReplyText, unreadTimeLabel, type UnreadInboxItem } from './inboxItems'
import { InboxReplyTaskList } from './InboxTaskList'
import { GlyphCell, InboxLine, UnreadGlyph } from './InboxLine'

/** 摘录读多少条会话：收件箱里的新回复一般没几条，读太多会把打开收件箱拖慢 */
const EXCERPT_LIMIT = 20

const excerptKey = (item: UnreadInboxItem): string => `${item.session.id}\n${item.unread.since}`

/** 一行新回复从那条会话的消息里读出来的东西：最后那张回复的一句（没有字 = null）、那个请求的任务列表（没有 = undefined） */
export interface ReplyExcerpt {
  text: string | null
  taskList: TaskListSnapshot | undefined
}

const NO_EXCERPT: ReplyExcerpt = { text: null, taskList: undefined }

/** 「新回复」各行的摘录：key（会话 + 变成未读的时刻）→ 摘录；还没读到的不在表里 */
export function useReplyExcerpts(items: UnreadInboxItem[]): Record<string, ReplyExcerpt> {
  const [excerpts, setExcerpts] = useState<Record<string, ReplyExcerpt>>({})
  const requested = useRef(new Set<string>())
  useEffect(() => {
    for (const item of items.slice(0, EXCERPT_LIMIT)) {
      const key = excerptKey(item)
      if (requested.current.has(key)) continue
      requested.current.add(key)
      getChatApi()
        .message.list(item.session.id)
        .then((messages) =>
          setExcerpts((prev) => ({
            ...prev,
            [key]: { text: lastReplyText(messages), taskList: taskListOfMessages(messages) }
          }))
        )
        .catch(() => setExcerpts((prev) => ({ ...prev, [key]: NO_EXCERPT })))
    }
  }, [items])
  return excerpts
}

export interface InboxUnreadRowProps {
  item: UnreadInboxItem
  excerpts: Record<string, ReplyExcerpt>
  now: number
  /** 挂在父会话下面 */
  indent?: boolean
  /** 行尾的其它控件（父会话行上的子会话圆点） */
  trailing?: React.ReactNode
  /** 这条会话正开在中间 */
  selected?: boolean
  /** 留着的那一条（`item.held`）行首画什么 */
  heldIcon?: React.ReactNode
  onOpen: (sessionId: string) => void
  /** 宿主给不出「标为已读」（没有 `session.markRead`）时不传，✓ 不出现 */
  onMarkRead?: (sessionId: string) => void
}

export function InboxUnreadRow({
  item,
  excerpts,
  now,
  indent = false,
  trailing,
  selected = false,
  heldIcon,
  onOpen,
  onMarkRead
}: InboxUnreadRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const { session, unread } = item
  const held = !!item.held
  const excerpt = excerpts[excerptKey(item)]
  const taskList = excerpt?.taskList
  return (
    <RedactionSessionProvider sessionId={session.id}>
      <InboxLine
        attrs={{
          'data-inbox-unread': session.id,
          'data-inbox-failed': unread.failed ? '' : undefined,
          'data-inbox-held': held ? '' : undefined
        }}
        leading={
          held && heldIcon ? (
            <GlyphCell>{heldIcon}</GlyphCell>
          ) : (
            <UnreadGlyph
              failed={!!unread.failed}
              label={unread.failed ? t('inbox.failed') : t('inbox.unreadSection')}
            />
          )
        }
        title={<RedactedText text={session.title} />}
        titleClassName={held ? 'text-text-primary' : 'font-semibold text-text-primary'}
        preview={!taskList && excerpt?.text ? <RedactedText text={excerpt.text} /> : null}
        below={taskList ? <InboxReplyTaskList sessionId={session.id} snapshot={taskList} /> : null}
        meta={unreadTimeLabel(unread.since, now)}
        hoverMeta={
          onMarkRead && !held ? (
            <button
              type="button"
              data-inbox-mark-read={session.id}
              onClick={() => onMarkRead(session.id)}
              title={t('inbox.markRead')}
              aria-label={t('inbox.markRead')}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-bg-primary text-text-secondary transition-colors hover:text-text-primary"
            >
              <Check size={14} aria-hidden="true" />
            </button>
          ) : undefined
        }
        trailing={trailing}
        indent={indent}
        selected={selected}
        onOpen={() => onOpen(session.id)}
      />
    </RedactionSessionProvider>
  )
}
