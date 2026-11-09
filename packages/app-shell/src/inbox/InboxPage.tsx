/**
 * 收件箱页（主区，取代欢迎页那一格）—— 第一版只汇总**此刻在运行的会话**（inboxItems.ts），不存任何状态。
 *
 * 版式取 Things 3 的收件箱（2026-11-09 用户从四版样式里选的 B 版，简化）：大标题 + 一句概况，两节
 * 「等你回答」「运行中」，每行一条会话：类型图标、标题、一行灰字（在哪、在做什么）。点一行 = 打开那条会话
 * （收件箱随之关上，见 inboxStore.ts）。没有已读、勾选、已处理 —— 会话停下来，行就自己没了。
 *
 * 两种看法（右上角切换，按浏览器记住，缺省逐张处理）：「逐张处理」（InboxTriage，B3）把在等你回答的询问一次摆一张、
 * 就地答完；「列表」就是上面这一页。宿主给不出询问本身（没有 `agent.pendingInputs`，Chrome 侧栏）时只有列表。
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, Inbox, MessageCircleQuestion } from 'lucide-react'
import { boundBotOf, workProjectOf } from '@shuvix/chat-protocol/botSession'
import {
  getChatApi,
  RedactedText,
  RedactionSessionProvider,
  useChatStore,
  type Session
} from '@shuvix/chat-ui'
import { useProjects } from '../sidebar/useProjects'
import { useInboxSections } from './inboxStore'
import type { InboxItem, UnreadInboxItem } from './inboxItems'
import { InboxUnreadRow, useReplyExcerpts } from './InboxUnreadRow'
import { InboxTriage } from './InboxTriage'
import { SessionKindIcon } from './InboxItemIcon'
import { usePendingInputs } from './usePendingInputs'

type Kind = 'waiting' | 'running'
type Mode = 'triage' | 'list'

/** 看法按浏览器记住（只是这台设备上的偏好；存储不可用时就用缺省） */
const MODE_KEY = 'shuvix.inbox.mode'
function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'triage'
  } catch {
    return 'triage'
  }
}
function writeMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* 记不住就记不住 */
  }
}

export function InboxPage(): React.JSX.Element {
  const { t } = useTranslation()
  const { waiting, unread, running } = useInboxSections()
  const sessions = useChatStore((s) => s.sessions)
  const select = useChatStore((s) => s.setActiveSessionId)
  const { projects, archivedProjects } = useProjects()
  // 宿主给得出询问本身才有逐张处理
  const canTriage = typeof getChatApi().agent.pendingInputs === 'function'
  const [mode, setMode] = useState<Mode>(readMode)
  const triage = canTriage && mode === 'triage'
  const pending = usePendingInputs(triage)
  const [toast, setToast] = useState<{ n: number; title: string } | null>(null)
  const excerpts = useReplyExcerpts(unread)
  // 「新回复」的时间标签分今天 / 更早：打开收件箱那一刻的「今天」就够用
  const [now] = useState(() => Date.now())
  const sessionApi = getChatApi().session
  const markRead = sessionApi.markRead
    ? (sessionId: string): void => void sessionApi.markRead?.(sessionId)
    : undefined

  // 「已发送」那一句停 2.6 秒
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const chooseMode = (next: Mode): void => {
    setMode(next)
    writeMode(next)
  }

  const projectNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of [...archivedProjects, ...projects]) map.set(p.id, p.name)
    return map
  }, [projects, archivedProjects])
  const titles = useMemo(() => new Map(sessions.map((s) => [s.id, s.title])), [sessions])

  /** 这条会话在哪：子会话 → 父会话；bot 会话 → bot 与它的工作位置；笔记本 → 文件名；项目 → 项目名；其余 → 聊天 */
  const locationOf = (s: Session): string | null => {
    if (s.parentId) {
      const parent = titles.get(s.parentId)
      return parent ? t('inbox.subSessionOf', { title: parent }) : null
    }
    const bot = boundBotOf(s.settings)
    if (bot) {
      const pid = workProjectOf(s.settings)
      const where = !pid
        ? t('sidebar.botTempLocation')
        : (projectNames.get(pid) ?? t('sidebar.botProjectGone')) || t('sidebar.unnamedProject')
      return `${bot} · ${where}`
    }
    const notebook = s.settings.notebookPath
    if (notebook) return notebook.split(/[\\/]/).pop() || notebook
    if (s.projectId) {
      const name = projectNames.get(s.projectId)
      // 不在项目列表里的是隐藏的载体项目（智能体、策略……的笔记本），不标
      return name === undefined ? null : name || t('sidebar.unnamedProject')
    }
    return t('sidebar.tempChats')
  }

  /** 在做什么：等你回答几条；或者正在回复、几个后台任务 */
  const statusOf = (item: InboxItem): string => {
    if (item.asks > 0) return t('inbox.asks', { count: item.asks })
    const parts: string[] = []
    if (item.replying) parts.push(t('inbox.replying'))
    if (item.backgroundTasks > 0) {
      parts.push(t('inbox.backgroundTasks', { count: item.backgroundTasks }))
    }
    return parts.join(' · ')
  }

  const total = waiting.length + unread.length + running.length
  const summary = [
    waiting.length > 0 ? t('inbox.summaryWaitingPart', { count: waiting.length }) : null,
    unread.length > 0 ? t('inbox.summaryUnreadPart', { count: unread.length }) : null,
    running.length > 0 ? t('inbox.summaryRunningPart', { count: running.length }) : null
  ]
    .filter(Boolean)
    .join(' · ')

  const renderUnreadRow = (item: UnreadInboxItem): React.JSX.Element => (
    <InboxUnreadRow
      key={item.session.id}
      item={item}
      location={locationOf(item.session)}
      excerpts={excerpts}
      now={now}
      onOpen={select}
      onMarkRead={markRead}
    />
  )

  const unreadSection =
    unread.length === 0 ? null : (
      <section data-inbox-section="unread" aria-label={t('inbox.unreadSection')}>
        <h2 className="mb-1 mt-7 border-b border-border-secondary pb-1.5 text-[13px] font-semibold text-text-primary">
          {t('inbox.unreadSection')}
        </h2>
        <div className="flex flex-col">{unread.map(renderUnreadRow)}</div>
      </section>
    )

  const renderRow = (item: InboxItem, kind: Kind): React.JSX.Element => {
    const { session } = item
    const meta = [locationOf(session), statusOf(item)].filter(Boolean).join(' · ')
    return (
      <button
        key={session.id}
        type="button"
        data-inbox-item={session.id}
        data-inbox-kind={kind}
        onClick={() => select(session.id)}
        className="group flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-bg-hover/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          <InboxItemIcon session={session} kind={kind} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="truncate text-[14px] text-text-primary">
            <RedactionSessionProvider sessionId={session.id}>
              <RedactedText text={session.title} />
            </RedactionSessionProvider>
          </span>
          {meta && <span className="truncate text-[12px] text-text-secondary">{meta}</span>}
        </span>
        {kind === 'waiting' ? (
          <span className="shrink-0 self-center rounded-md border border-border-primary px-2.5 py-[3px] text-[12px] text-text-primary transition-colors group-hover:border-accent/60 group-hover:text-accent">
            {t('inbox.answer')}
          </span>
        ) : (
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="shrink-0 self-center text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
          />
        )}
      </button>
    )
  }

  const section = (kind: Kind, items: InboxItem[]): React.JSX.Element | null =>
    items.length === 0 ? null : (
      <section data-inbox-section={kind} aria-label={t(`inbox.${kind}Section`)}>
        <h2 className="mb-1 mt-7 border-b border-border-secondary pb-1.5 text-[13px] font-semibold text-text-primary">
          {t(`inbox.${kind}Section`)}
        </h2>
        <div className="flex flex-col">{items.map((item) => renderRow(item, kind))}</div>
      </section>
    )

  const modeButton = (value: Mode, label: string): React.JSX.Element => (
    <button
      type="button"
      data-inbox-mode={value}
      aria-pressed={mode === value}
      onClick={() => chooseMode(value)}
      className={`rounded-[5px] px-2.5 py-[3px] transition-colors ${
        mode === value
          ? 'bg-bg-primary text-text-primary shadow-sm'
          : 'text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div data-inbox-page="" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-12 pb-16 pt-6">
          <div className="flex items-center gap-2.5">
            <Inbox size={24} strokeWidth={2} aria-hidden="true" className="shrink-0 text-accent" />
            <h1 className="text-[22px] font-bold tracking-tight text-text-primary">
              {t('inbox.title')}
            </h1>
            <span className="flex-1" />
            {unread.length > 0 && sessionApi.markAllRead && (
              <button
                type="button"
                data-inbox-mark-all-read=""
                onClick={() => void sessionApi.markAllRead?.()}
                className="rounded-md px-2 py-1 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
              >
                {t('inbox.markAllRead')}
              </button>
            )}
            {canTriage && total > 0 && (
              <span className="inline-flex rounded-[7px] bg-bg-tertiary p-0.5 text-[12px]">
                {modeButton('triage', t('inbox.modeTriage'))}
                {modeButton('list', t('inbox.modeList'))}
              </span>
            )}
          </div>
          {total === 0 ? (
            <div data-inbox-empty="" className="mt-28 flex flex-col items-center gap-2 text-center">
              <Inbox
                size={36}
                strokeWidth={1.5}
                aria-hidden="true"
                className="text-text-tertiary/60"
              />
              <div className="text-[14px] text-text-secondary">{t('inbox.emptyTitle')}</div>
              <div className="max-w-[320px] text-[12px] text-text-tertiary">
                {t('inbox.emptyHint')}
              </div>
            </div>
          ) : (
            <>
              <p className="mt-1.5 pl-[34px] text-[13px] text-text-secondary" data-inbox-summary="">
                {summary}
              </p>
              {triage ? (
                pending && (
                  <InboxTriage
                    waiting={waiting}
                    unread={unread}
                    running={running}
                    pending={pending}
                    locationOf={locationOf}
                    renderRunningRow={(item) => renderRow(item, 'running')}
                    renderUnreadRow={renderUnreadRow}
                    onSent={(title) => setToast((prev) => ({ n: (prev?.n ?? 0) + 1, title }))}
                  />
                )
              ) : (
                <>
                  {section('waiting', waiting)}
                  {unreadSection}
                  {section('running', running)}
                </>
              )}
            </>
          )}
        </div>
      </div>
      {toast && (
        <div
          key={toast.n}
          role="status"
          data-inbox-sent=""
          className="pointer-events-none absolute bottom-6 left-1/2 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded-[10px] bg-text-primary px-3.5 py-2 text-[13px] text-bg-primary shadow-lg"
        >
          <Check size={14} aria-hidden="true" className="shrink-0 text-success" />
          <span className="truncate">{t('inbox.sent', { title: toast.title })}</span>
        </div>
      )}
    </div>
  )
}

/** 行首图标：等你回答 → 问号（与侧栏询问点同一个琥珀色）；运行中 → 这条会话自己的身份图标，跳动的强调色（同侧栏转圈） */
function InboxItemIcon({ session, kind }: { session: Session; kind: Kind }): React.JSX.Element {
  if (kind === 'waiting') {
    return <MessageCircleQuestion size={18} aria-hidden="true" className="text-warning" />
  }
  return <SessionKindIcon session={session} className="animate-pulse text-accent" />
}
