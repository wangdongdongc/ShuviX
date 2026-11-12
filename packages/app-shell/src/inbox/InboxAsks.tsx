/**
 * 「等你回答」的询问：列表的一行，点开（或轮到它）就地变成那张卡片（L1，2026-11-10 用户选定；取代了单独的「逐张处理」看法）。
 *
 * - 同时只开一条。进收件箱时第一条自动开着；答完换到它后面那条（没有就前面那条）；J / K 换下一条 / 上一条；收起之后
 *   ⏎ 打开第一条。
 * - 收起时是一行（InboxLine：状态图形 + 标题 + 问的是什么 + 等了多久），展开的卡片头只有标题、等了多久和一个 ↗，
 *   点标题收起（M1，2026-11-10：元素精简）。
 * - 卡片里是对话中那张卡的**同一个表单**（chat-ui `InputRequestForm`：命令、真实路径、diff、要填的值、「允许并记住」
 *   各行、「其它」那一行一样不少）—— 在收件箱里批准看到的东西不能比在会话里少。数字键 1–9 选行也照旧。表单上面
 *   是那条询问之前 AI 说的话。
 * - 应答走 `respondToInput`，与在会话里答完全一样；询问已在别处答掉时主进程回 `success: false`，卡片照样收起。
 *   刚答过的先藏起来，等主进程的新一份询问表到了自然不再有它。
 * - 不存任何状态：没有已读，也没有「跳过」记录 —— 换走的卡还在，换回来照样答。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, MessageCircleQuestion, ShieldAlert } from 'lucide-react'
import {
  getChatApi,
  getSessionChannelApi,
  InputRequestForm,
  RedactedText,
  RedactionSessionProvider,
  useChatStore
} from '@shuvix/chat-ui'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import {
  askContextOf,
  askItemsOf,
  askKeyOf,
  waitedMinutes,
  type InboxAsk,
  type InboxFamily
} from './inboxItems'
import { FullAccessShield, GlyphCell, InboxLine } from './InboxLine'

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

/** 焦点在按钮 / 链接上时 ⏎ 是点它 */
function isActionTarget(e: KeyboardEvent): boolean {
  const target = e.composedPath()[0] ?? e.target
  return target instanceof HTMLElement && target.closest('button,a,[role="button"]') !== null
}

export interface InboxAnswering {
  /** 页面上从上到下的询问（J / K 的次序） */
  items: InboxAsk[]
  /** 此刻展开的那一条；全都收起为 null */
  openKey: string | null
  open: (key: string) => void
  collapse: () => void
  respond: (ask: InboxAsk, response: InputResponse) => Promise<void>
  /** 展开那一条之前 AI 说的话 */
  context: string | null
  /** 等了多久（「8 分钟」） */
  waited: (createdAt: number) => string
}

export function useInboxAnswering(
  families: InboxFamily[],
  pending: Record<string, InputRequest[]> | null,
  onSent?: (sessionTitle: string) => void,
  /**
   * J / K / ⏎ 只在焦点落在这个元素里时生效：收件箱在会话旁边的面板里，按键不该从会话那边被它截走
   */
  scope?: React.RefObject<HTMLElement | null>
): InboxAnswering {
  const { t } = useTranslation()
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  /** undefined = 还没定（开第一条）；null = 用户收起了；字符串 = 开着这一条 */
  const [chosen, setChosen] = useState<string | null | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [context, setContext] = useState<{ key: string; text: string | null } | null>(null)

  const items = useMemo(() => askItemsOf(families, pending, hidden), [families, pending, hidden])
  // 开着的那条没了（在别处答掉、会话停了）：回到第一条
  const firstKey = items[0] ? askKeyOf(items[0]) : null
  const openKey =
    chosen === null
      ? null
      : items.some((i) => askKeyOf(i) === chosen)
        ? (chosen as string)
        : firstKey
  // 自动开的那一条记下来：之后新来一条排到它前面，也不把正在看的卡换掉
  if (openKey !== null && openKey !== chosen) setChosen(openKey)

  const openAsk = openKey ? items.find((i) => askKeyOf(i) === openKey) : undefined

  // 「等了多久」每半分钟走一格
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // 这张卡之前 AI 说的话：只取展开这一条所在会话的消息
  const openSessionId = openAsk?.session.id
  const openRequestId = openAsk?.request.id
  useEffect(() => {
    if (!openKey || !openSessionId || !openRequestId) return
    let cancelled = false
    getChatApi()
      .message.list(openSessionId)
      .then((messages) => {
        if (!cancelled) setContext({ key: openKey, text: askContextOf(messages, openRequestId) })
      })
      .catch(() => {
        if (!cancelled) setContext({ key: openKey, text: null })
      })
    return () => {
      cancelled = true
    }
  }, [openKey, openSessionId, openRequestId])

  const step = useCallback(
    (delta: number) => {
      if (items.length === 0) return
      const at = items.findIndex((i) => askKeyOf(i) === openKey)
      // 全都收起时：J 从第一条开始，K 从最后一条开始
      const index =
        at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length
      setChosen(askKeyOf(items[index]))
    },
    [items, openKey]
  )

  // J / K：下一条 / 上一条；都收起时 ⏎ 打开第一条
  useEffect(() => {
    if (items.length === 0) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const root = scope?.current
      if (root && !(e.target instanceof Node && root.contains(e.target))) return
      if (isEditableTarget(e)) return
      const key = e.key.toLowerCase()
      if (key === 'enter') {
        if (openKey !== null || isActionTarget(e)) return
        e.preventDefault()
        step(1)
        return
      }
      if (key !== 'j' && key !== 'k') return
      e.preventDefault()
      step(key === 'j' ? 1 : -1)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [items.length, openKey, step, scope])

  const respond = async (ask: InboxAsk, response: InputResponse): Promise<void> => {
    const result = await getSessionChannelApi().agent.respondToInput({
      sessionId: ask.session.id,
      requestId: ask.request.id,
      response
    })
    // 答出去了，或者它已经在别处落定：都收起这一条，换到它后面那条（没有就前面那条）
    const at = items.findIndex((i) => askKeyOf(i) === askKeyOf(ask))
    const next = items[at + 1] ?? items[at - 1]
    setHidden((prev) => new Set(prev).add(askKeyOf(ask)))
    setChosen(next ? askKeyOf(next) : undefined)
    if (result.success) onSent?.(ask.session.title)
  }

  const waited = (createdAt: number): string => {
    const minutes = waitedMinutes(createdAt, now)
    if (minutes < 1) return t('inbox.waitedShortJustNow')
    if (minutes < 60) return t('inbox.waitedShortMinutes', { count: minutes })
    return t('inbox.waitedShortHours', { count: Math.floor(minutes / 60) })
  }

  return {
    items,
    openKey,
    open: setChosen,
    collapse: () => setChosen(null),
    respond,
    context: context && context.key === openKey ? context.text : null,
    waited
  }
}

/** 行首 / 卡片头的图形：选择题是问号，批准是盾牌，申请完全访问的批准是实心盾牌 */
function AskGlyph({ request }: { request: InputRequest }): React.JSX.Element {
  const { t } = useTranslation()
  if (request.kind === 'ask' && request.unsandboxed) {
    return (
      <GlyphCell label={t('toolCall.fullAccessTag')}>
        <FullAccessShield />
      </GlyphCell>
    )
  }
  const Icon = request.kind === 'ask' ? ShieldAlert : MessageCircleQuestion
  return (
    <GlyphCell>
      <Icon size={17} aria-hidden="true" className="text-warning" />
    </GlyphCell>
  )
}

/** 收起时那一句：选择题是问题；审批是工具写的说明，没有说明就是命令本身 */
function AskSummary({ request }: { request: InputRequest }): React.JSX.Element {
  const description = request.kind === 'ask' ? request.description?.trim() : request.question
  return description ? (
    <RedactedText text={description} />
  ) : (
    <code className="font-mono text-[12px]">
      <RedactedText text={request.kind === 'ask' ? request.command : ''} />
    </code>
  )
}

export interface InboxAskRowProps {
  ask: InboxAsk
  waited: string
  /** 挂在父会话下面 */
  indent?: boolean
  /** 这条会话正开在中间 */
  selected?: boolean
  onOpen: () => void
}

export function InboxAskRow({
  ask,
  waited,
  indent = false,
  selected = false,
  onOpen
}: InboxAskRowProps): React.JSX.Element {
  const { session, request } = ask
  return (
    <RedactionSessionProvider sessionId={session.id}>
      <InboxLine
        attrs={{ 'data-inbox-ask': request.kind, 'data-inbox-ask-session': session.id }}
        leading={<AskGlyph request={request} />}
        title={<RedactedText text={session.title} />}
        preview={<AskSummary request={request} />}
        meta={waited}
        indent={indent}
        selected={selected}
        onOpen={onOpen}
      />
    </RedactionSessionProvider>
  )
}

export interface InboxAskCardProps {
  ask: InboxAsk
  waited: string
  context: string | null
  onCollapse: () => void
  onResponse: (response: InputResponse) => Promise<void>
}

export function InboxAskCard({
  ask,
  waited,
  context,
  onCollapse,
  onResponse
}: InboxAskCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const openSession = useChatStore((s) => s.setActiveSessionId)
  const { session, request } = ask
  const ref = useRef<HTMLElement>(null)
  // J / K、答完换下一条时可能换到屏幕外的一行
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  return (
    <article
      ref={ref}
      data-inbox-card={request.kind}
      data-inbox-card-session={session.id}
      className="-mx-1.5 my-1 rounded-[14px] border border-border-secondary bg-bg-primary shadow-[0_1px_2px_rgba(31,35,40,0.06),0_8px_24px_rgba(31,35,40,0.10)] dark:shadow-[0_8px_24px_rgba(1,4,9,0.5)]"
    >
      <RedactionSessionProvider sessionId={session.id}>
        <header className="flex items-center gap-1.5 pl-3.5 pr-2.5 pt-2">
          <button
            type="button"
            data-inbox-collapse=""
            onClick={onCollapse}
            title={t('inbox.collapse')}
            className="flex min-w-0 flex-1 items-center gap-2.5 py-1 text-left"
          >
            <AskGlyph request={request} />
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-text-primary">
              <RedactedText text={session.title} />
            </span>
            <span className="shrink-0 text-[12px] tabular-nums text-text-tertiary">{waited}</span>
          </button>
          <button
            type="button"
            data-inbox-open-session=""
            onClick={() => openSession(session.id)}
            title={t('inbox.openSession')}
            aria-label={t('inbox.openSession')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
          >
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </header>
        {context && (
          <p
            data-inbox-context=""
            className="line-clamp-3 whitespace-pre-line pl-[42px] pr-3.5 pt-1 text-[13px] leading-relaxed text-text-secondary"
          >
            <RedactedText text={context} />
          </p>
        )}
      </RedactionSessionProvider>
      <div className="pl-7">
        <InputRequestForm
          key={askKeyOf(ask)}
          sessionId={session.id}
          request={request}
          onResponse={onResponse}
        />
      </div>
    </article>
  )
}
