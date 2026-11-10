/**
 * 收件箱的「逐张处理」（B3，2026-11-09 用户从三版里选定）：在等你回答的询问一次摆一张，就地答完、自动换到下一张。
 *
 * - 卡片里是对话中那张卡的**同一个表单**（chat-ui `InputRequestForm`：命令、真实路径、diff、要填的值、「允许并记住」
 *   各行、「其它」那一行一样不少）—— 在收件箱里批准看到的东西不能比在会话里少。数字键 1–9 选行也照旧（同会话里的规矩：
 *   焦点在输入框里时不算）。卡片头多两样会话里本来就看得见的东西：哪条会话、等了多久，以及那条询问之前 AI 说的话。
 * - 应答走 `respondToInput`，与在会话里答完全一样；询问已在别处答掉时主进程回 `success: false`，卡片照样收起。
 *   刚答过的卡先藏起来，等主进程的新一份询问表到了自然不再有它。
 * - J / K 换下一张 / 上一张；「接下来」列出其余几张，点一张就换到它；运行中的会话折在下面。
 * - 不存任何状态：没有已读，也没有「跳过」记录 —— 换走的卡还在，换回来照样答。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  MessageCircleQuestion,
  ShieldAlert
} from 'lucide-react'
import {
  getChatApi,
  getSessionChannelApi,
  InputRequestForm,
  RedactedText,
  RedactionSessionProvider,
  useChatStore,
  type Session
} from '@shuvix/chat-ui'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import {
  askContextOf,
  requestSummaryOf,
  triageItemsOf,
  triageKeyOf,
  waitedMinutes,
  type InboxItem,
  type TriageItem,
  type UnreadInboxItem
} from './inboxItems'
import { SessionKindIcon } from './InboxItemIcon'

export interface InboxTriageProps {
  waiting: InboxItem[]
  /** 有新回复没看的会话（R1 的行，排在询问卡之后） */
  unread: UnreadInboxItem[]
  running: InboxItem[]
  /** 各会话挂着的询问（usePendingInputs） */
  pending: Record<string, InputRequest[]>
  /** 这条会话在哪（与列表同一句） */
  locationOf: (session: Session) => string | null
  /** 运行中那一节的行（与列表同一种） */
  renderRunningRow: (item: InboxItem) => React.JSX.Element
  /** 「新回复」那一节的行（与列表同一种） */
  renderUnreadRow: (item: UnreadInboxItem) => React.JSX.Element
  /** 「跟踪中」那一节（宿主给了跟踪项时），摆在新回复之后、运行中之前 */
  trackingSection?: React.ReactNode
  /** 一张卡答出去了（收件箱页据此弹一句「已发送」） */
  onSent: (sessionTitle: string) => void
}

/** 焦点在可编辑元素里时 J / K 是打字 */
function isEditableTarget(e: KeyboardEvent): boolean {
  const target = e.composedPath()[0] ?? e.target
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  )
}

const kbd = 'rounded border border-border-primary px-1 text-[11px] text-text-secondary'

export function InboxTriage({
  waiting,
  unread,
  running,
  pending,
  locationOf,
  renderRunningRow,
  renderUnreadRow,
  trackingSection,
  onSent
}: InboxTriageProps): React.JSX.Element {
  const { t } = useTranslation()
  const openSession = useChatStore((s) => s.setActiveSessionId)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [showRunning, setShowRunning] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [context, setContext] = useState<{ key: string; text: string | null } | null>(null)

  const items = useMemo(() => triageItemsOf(waiting, pending, hidden), [waiting, pending, hidden])
  const found = selectedKey === null ? -1 : items.findIndex((i) => triageKeyOf(i) === selectedKey)
  // 选中的那张没了（在别处答掉、会话停了）：回到第一张
  const index = found >= 0 ? found : 0
  const current: TriageItem | undefined = items[index]
  const currentKey = current ? triageKeyOf(current) : null
  const rest = items.filter((_, i) => i !== index)

  // 「等了多久」每半分钟走一格
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // 这张卡之前 AI 说的话：只取当前这张所在会话的消息
  const currentSessionId = current?.session.id
  const currentRequestId = current?.request.id
  useEffect(() => {
    if (!currentKey || !currentSessionId || !currentRequestId) return
    let cancelled = false
    getChatApi()
      .message.list(currentSessionId)
      .then((messages) => {
        if (!cancelled)
          setContext({ key: currentKey, text: askContextOf(messages, currentRequestId) })
      })
      .catch(() => {
        if (!cancelled) setContext({ key: currentKey, text: null })
      })
    return () => {
      cancelled = true
    }
  }, [currentKey, currentSessionId, currentRequestId])
  const contextText = context && context.key === currentKey ? context.text : null

  const step = useCallback(
    (delta: number) => {
      if (items.length < 2) return
      const next = items[(index + delta + items.length) % items.length]
      setSelectedKey(triageKeyOf(next))
    },
    [items, index]
  )

  // J / K：下一张 / 上一张
  useEffect(() => {
    if (items.length < 2) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditableTarget(e)) return
      const key = e.key.toLowerCase()
      if (key !== 'j' && key !== 'k') return
      e.preventDefault()
      step(key === 'j' ? 1 : -1)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [items.length, step])

  const respond = async (item: TriageItem, response: InputResponse): Promise<void> => {
    const result = await getSessionChannelApi().agent.respondToInput({
      sessionId: item.session.id,
      requestId: item.request.id,
      response
    })
    // 答出去了，或者它已经在别处落定：都收起这张，换到它后面那张（没有就前面那张）
    const at = items.findIndex((i) => triageKeyOf(i) === triageKeyOf(item))
    const next = items[at + 1] ?? items[at - 1]
    setHidden((prev) => new Set(prev).add(triageKeyOf(item)))
    setSelectedKey(next ? triageKeyOf(next) : null)
    if (result.success) onSent(item.session.title)
  }

  const waitedText = (createdAt: number): string => {
    const minutes = waitedMinutes(createdAt, now)
    if (minutes < 1) return t('inbox.waitedJustNow')
    if (minutes < 60) return t('inbox.waitedMinutes', { count: minutes })
    return t('inbox.waitedHours', { count: Math.floor(minutes / 60) })
  }

  const navButton = (delta: number, label: string, key: string): React.JSX.Element => (
    <button
      type="button"
      onClick={() => step(delta)}
      disabled={items.length < 2}
      title={`${label} (${key})`}
      aria-label={label}
      className="flex h-[26px] w-[26px] items-center justify-center rounded-md border border-border-secondary text-text-secondary transition-colors hover:bg-bg-hover/60 hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {delta < 0 ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
    </button>
  )

  return (
    <div data-inbox-triage="">
      {!current ? (
        <div
          data-inbox-triage-empty=""
          className="mt-7 flex items-center gap-2 px-0.5 text-[13px] text-text-secondary"
        >
          <CircleCheck size={15} aria-hidden="true" className="text-success" />
          {t('inbox.noWaiting')}
        </div>
      ) : (
        <>
          <div className="mb-2.5 mt-7 flex items-center gap-2 px-0.5">
            <span className="text-[13px] font-semibold text-text-primary">
              {t('inbox.waitingSection')}
            </span>
            <span className="text-[12px] tabular-nums text-text-secondary" data-inbox-progress="">
              {t('inbox.progress', { index: index + 1, total: items.length })}
            </span>
            <span className="flex-1" />
            {navButton(-1, t('inbox.prev'), 'K')}
            {navButton(1, t('inbox.next'), 'J')}
          </div>

          <article
            data-inbox-card={current.request.kind}
            data-inbox-card-session={current.session.id}
            className={`overflow-hidden rounded-2xl border bg-bg-primary ring-[3px] ${
              current.request.kind === 'ask'
                ? 'border-warning/45 ring-warning/10'
                : 'border-accent/45 ring-accent/10'
            }`}
          >
            <header className="flex items-center gap-3 border-b border-border-secondary/40 px-3.5 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary">
                <SessionKindIcon session={current.session} className="text-text-secondary" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[14px] font-medium text-text-primary">
                  <RedactionSessionProvider sessionId={current.session.id}>
                    <RedactedText text={current.session.title} />
                  </RedactionSessionProvider>
                </span>
                <span className="truncate text-[12px] text-text-secondary">
                  {[locationOf(current.session), waitedText(current.request.createdAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <button
                type="button"
                data-inbox-open-session=""
                onClick={() => openSession(current.session.id)}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-accent transition-colors hover:bg-accent/10"
              >
                {t('inbox.openSession')}
                <ArrowUpRight size={12} aria-hidden="true" />
              </button>
            </header>
            {contextText && (
              <p
                data-inbox-context=""
                className="line-clamp-3 whitespace-pre-line px-3.5 pt-3 text-[13px] leading-relaxed text-text-secondary"
              >
                <RedactionSessionProvider sessionId={current.session.id}>
                  <RedactedText text={contextText} />
                </RedactionSessionProvider>
              </p>
            )}
            <InputRequestForm
              key={currentKey}
              sessionId={current.session.id}
              request={current.request}
              onResponse={(response) => respond(current, response)}
            />
          </article>

          {rest.length > 0 && (
            <>
              <div className="mb-1 mt-6 px-0.5 text-[12px] font-semibold text-text-secondary">
                {t('inbox.upNext')}
              </div>
              {rest.map((item) => (
                <button
                  key={triageKeyOf(item)}
                  type="button"
                  data-inbox-next={item.request.id}
                  onClick={() => setSelectedKey(triageKeyOf(item))}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-bg-hover/60"
                >
                  {item.request.kind === 'ask' ? (
                    <ShieldAlert size={16} aria-hidden="true" className="shrink-0 text-warning" />
                  ) : (
                    <MessageCircleQuestion
                      size={16}
                      aria-hidden="true"
                      className="shrink-0 text-accent"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                    <RedactionSessionProvider sessionId={item.session.id}>
                      <RedactedText text={item.session.title} />
                      <span className="text-text-secondary">
                        {' · '}
                        <RedactedText text={requestSummaryOf(item.request)} />
                      </span>
                    </RedactionSessionProvider>
                  </span>
                  <span className="shrink-0 text-[12px] text-text-secondary">
                    {waitedText(item.request.createdAt)}
                  </span>
                </button>
              ))}
            </>
          )}
        </>
      )}

      {unread.length > 0 && (
        <section data-inbox-section="unread" aria-label={t('inbox.unreadSection')}>
          <div className="mb-1 mt-6 px-0.5 text-[12px] font-semibold text-text-secondary">
            {t('inbox.unreadSection')}
          </div>
          <div className="flex flex-col">{unread.map(renderUnreadRow)}</div>
        </section>
      )}

      {trackingSection}

      {running.length > 0 && (
        <>
          <button
            type="button"
            data-inbox-running-toggle=""
            aria-expanded={showRunning}
            onClick={() => setShowRunning((v) => !v)}
            className="mt-4 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-text-secondary transition-colors hover:bg-bg-hover/60"
          >
            <ChevronRight
              size={14}
              aria-hidden="true"
              className={`transition-transform ${showRunning ? 'rotate-90' : ''}`}
            />
            {t('inbox.runningCount', { count: running.length })}
          </button>
          {showRunning && <div className="flex flex-col">{running.map(renderRunningRow)}</div>}
        </>
      )}

      {current && (
        <div className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-1 px-0.5 text-[12px] text-text-secondary">
          <span>
            <kbd className={kbd}>1</kbd>–<kbd className={kbd}>9</kbd> {t('inbox.keyPick')}
          </span>
          {items.length > 1 && (
            <span>
              <kbd className={kbd}>J</kbd> <kbd className={kbd}>K</kbd> {t('inbox.keyNav')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
