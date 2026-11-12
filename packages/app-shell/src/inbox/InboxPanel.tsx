/**
 * 收件箱面板 —— 右侧面板的第一个标签（2026-11-12 用户选定 E1：与会话并排常驻，不再是主区的一页）。汇总要你处理或
 * 看一眼的会话（inboxItems.ts）。
 *
 * 版式（M1，2026-11-10 用户选定：元素精简，用图形和动效代替文字）：没有大标题（标签就是标题），两块，块名是灰色小字、
 * 不画分隔线：「跟踪中」在最上面，「会话」是一张列表，块名右边一个双勾（全部标为已读）（2026-11-11 用户：等你回答 /
 * 新回复 / 运行中不再分块，靠排序分轻重缓急 —— 等你回答的在前，有新回复的其次，只在跑的最后）。面板窄，每一行分两层
 * （InboxLine）：行首的形状说状态、标题、行尾时间，下面一句灰色预览。没有概况句、按键提示、位置信息、「已发送」提示。
 * 在跑的行行首就是侧栏那枚会话图标（SessionIcon，2026-11-11 S1：两处同一套）—— 蓝色呼吸 = agent 在干活，
 * 绿色不动 = 只剩后台命令开着（预览写那条命令）。
 *
 * - **只有列表这一种看法**（L1）：在等你回答的询问就是列表的行，开着的那一条就地变成会话里那张卡片（InboxAsks.tsx）。
 * - **父子会话一家只出现一次**（P3）：按家里最急的那一类排位，子会话缩进挂在父会话下面（不画竖线）；父会话行尾一排
 *   小圆点，一个子会话一个，在运行的那几条折在圆点后面，点圆点展开。家的归拢在 `inboxFamiliesOf`。
 * - 宿主给了跟踪项（`tracking`，桌面）时最上面一节「跟踪中」（InboxTracking.tsx，T1），不计入侧栏那一行的数字。
 * - 点一行 = 中间打开那条会话，收件箱不动；正开着的那条带选中底色。作为新回复打开的那一行读过了也留在原处，
 *   切到别的会话才离开（`useHeldUnread`，inboxStore.ts）。
 * - 按键只在焦点落在面板里时归它：J / K / ⏎ 走询问，数字键选开着那张卡的行（`OPTION_HOTKEY_SCOPE_ATTR`）——
 *   焦点在会话那边时，对话里那张卡照旧接数字键。从面板里打开了一条会话（点行、卡片的 ↗、跟踪项），焦点就交还出去：
 *   你看的是中间那条会话了，按「1」不该答到面板里开着的另一张卡上。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCheck, Inbox, MessageCircleQuestion } from 'lucide-react'
import { isBotSessionSettings } from '@shuvix/chat-protocol/botSession'
import type { TrackingStatus } from '@shuvix/chat-protocol/trackingNotes'
import {
  getChatApi,
  OPTION_HOTKEY_SCOPE_ATTR,
  OptionHotkeyGuardContext,
  OptionHotkeyScopeContext,
  RedactedText,
  RedactionSessionProvider,
  useChatStore,
  type Session,
  type SessionRunKind
} from '@shuvix/chat-ui'
import { useHeldUnread, useInboxHoldStore, useInboxSections } from './inboxStore'
import {
  askKeyOf,
  familyChildCount,
  inboxFamiliesOf,
  type InboxAsk,
  type InboxFamily,
  type InboxItem,
  type UnreadInboxItem
} from './inboxItems'
import { InboxAskCard, InboxAskRow, useInboxAnswering } from './InboxAsks'
import { InboxUnreadRow, useReplyExcerpts } from './InboxUnreadRow'
import { FamilyPips, GlyphCell, InboxLine } from './InboxLine'
import { SessionIcon, sessionIconShape } from '../sidebar/SessionIcon'
import { usePendingInputs } from './usePendingInputs'
import { InboxTrackingSection, useTrackingItems, type InboxTrackingAdapter } from './InboxTracking'

type SectionName = 'waiting' | 'unread' | 'running'

export interface InboxPanelProps {
  /** 跟踪项（桌面）；不给就没有「跟踪中」一节 */
  tracking?: InboxTrackingAdapter
}

/** 底部那一句：归档了一项（带「撤销」） */
interface ArchivedToast {
  n: number
  title: string
  undo: () => void
}

const SECTION_HEADING =
  'mb-0.5 mt-3 flex h-6 items-center gap-2 pl-2 text-[12px] font-medium text-text-tertiary'

/** 时间标签（今天 / 更早）的「现在」：面板一开就是好几天，每分钟走一格 */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function InboxPanel({ tracking }: InboxPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const held = useHeldUnread()
  const sections = useInboxSections(held)
  const { waiting, unread, running } = sections
  const {
    items: trackingItems,
    patch: patchTracking,
    rescan: rescanTracking
  } = useTrackingItems(tracking)
  const sessions = useChatStore((s) => s.sessions)
  const select = useChatStore((s) => s.setActiveSessionId)
  const activeId = useChatStore((s) => s.activeSessionId)
  const rootRef = useRef<HTMLDivElement>(null)
  // 开着那张卡的数字键：焦点在面板里才算（对话里那张卡在焦点不在这里时照旧接）
  const hotkeyGuard = useCallback(
    () => !!rootRef.current && rootRef.current.contains(document.activeElement),
    []
  )
  const families = useMemo(() => inboxFamiliesOf(sections, sessions), [sections, sessions])
  // 会话图标的形状要知道有没有子会话（同侧栏：有子会话的是两片对话框）
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of sessions) {
      if (s.parentId) counts.set(s.parentId, (counts.get(s.parentId) ?? 0) + 1)
    }
    return counts
  }, [sessions])
  // 宿主给不出询问本身（没有 `agent.pendingInputs`）时，等你回答的行点了就打开会话
  const pending = usePendingInputs(typeof getChatApi().agent.pendingInputs === 'function')
  const [toast, setToast] = useState<ArchivedToast | null>(null)
  const toastSeq = useRef(0)
  // 答出去的那一条自己收起、下一条展开，就是回执 —— 不另弹「已发送」
  const answering = useInboxAnswering(families.waiting, pending, undefined, rootRef)

  // 打开了一条会话（不管从哪里打开）而焦点还在面板里：交还出去，数字键归中间那条会话的卡（见文件头）
  useEffect(() => {
    const root = rootRef.current
    const focused = document.activeElement
    if (root && focused instanceof HTMLElement && root.contains(focused)) focused.blur()
  }, [activeId])
  /** 展开着运行中子会话的家（根会话 id） */
  const [openFamilies, setOpenFamilies] = useState<ReadonlySet<string>>(() => new Set())
  const excerpts = useReplyExcerpts(unread)
  const now = useMinuteClock()
  const sessionApi = getChatApi().session
  const markRead = sessionApi.markRead
    ? (sessionId: string): void => void sessionApi.markRead?.(sessionId)
    : undefined

  // 「已归档 · 撤销」停 6 秒，给人找到撤销的时间
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(timer)
  }, [toast])

  const onTrackingArchived = (
    item: { fileName: string; title: string },
    previous: TrackingStatus
  ): void => {
    if (!tracking) return
    setToast({
      n: ++toastSeq.current,
      title: item.title,
      undo: () => {
        setToast(null)
        patchTracking(item.fileName, previous)
        void tracking.setStatus(item.fileName, previous).catch(rescanTracking)
      }
    })
  }

  const toggleFamily = (rootId: string): void =>
    setOpenFamilies((prev) => {
      const next = new Set(prev)
      if (!next.delete(rootId)) next.add(rootId)
      return next
    })

  /** 在跑的是哪一种（行首图标的提示，与侧栏同一句） */
  const runLabelOf = (run: SessionRunKind | null): string | undefined =>
    run === 'agent'
      ? t('sidebar.runAgent')
      : run === 'resident'
        ? t('sidebar.runResident')
        : undefined

  /**
   * 行首那枚会话图标：侧栏的同一个组件，形状按会话的种类，颜色和动效按在跑的是哪一种；`active` = 侧栏选中的样子
   * （留在原处的那条新回复用它）
   */
  const iconOf = (
    session: Session,
    run: SessionRunKind | null,
    active = false
  ): React.JSX.Element => (
    <SessionIcon
      shape={sessionIconShape({
        isTriggerRun: !!session.settings.triggerRun,
        isBot: isBotSessionSettings(session.settings),
        isNotebook: !!session.settings.notebookPath,
        subCount: childCounts.get(session.id) ?? 0
      })}
      run={run}
      active={active}
      size={15}
    />
  )

  /** 打开一条新回复：先留住它（未读马上就会被清掉），再选中 */
  const openUnread = (item: UnreadInboxItem): void => {
    if (!item.held) useInboxHoldStore.getState().hold(item.session.id, item.unread)
    select(item.session.id)
  }

  /** 只剩后台命令开着：预览写第一条命令（只取第一行），再有就 +N */
  const commandsPreview = (commands: string[]): React.ReactNode => {
    if (commands.length === 0) return null
    return (
      <span data-inbox-commands={commands.length}>
        <span className="font-mono text-[12px]">
          <RedactedText text={commands[0].split('\n')[0].trim()} />
        </span>
        {commands.length > 1 && <span className="text-text-tertiary"> +{commands.length - 1}</span>}
      </span>
    )
  }

  const total = waiting.length + unread.length + running.length
  // 页面有没有东西可摆：收件箱的三节，或者跟踪项（连已归档的也算 —— 归档那一格是能点开的）
  const hasContent = total > 0 || (!!tracking && (trackingItems?.length ?? 0) > 0)

  const renderUnreadRow = (
    item: UnreadInboxItem,
    indent = false,
    trailing?: React.ReactNode
  ): React.JSX.Element => (
    <InboxUnreadRow
      key={item.session.id}
      item={item}
      excerpts={excerpts}
      now={now}
      indent={indent}
      trailing={trailing}
      selected={item.session.id === activeId}
      heldIcon={item.held ? iconOf(item.session, null, true) : undefined}
      onOpen={() => openUnread(item)}
      onMarkRead={markRead}
    />
  )

  /**
   * 一条在运行（或在等你回答、但询问表还没取到）的会话：行首会话图标 / 问号，点开那条会话。
   * `trailing` 是父会话行尾的子会话圆点
   */
  const renderSessionRow = (
    item: InboxItem,
    indent = false,
    trailing?: React.ReactNode
  ): React.JSX.Element => {
    const { session } = item
    const waitingRow = item.asks > 0
    return (
      <RedactionSessionProvider key={session.id} sessionId={session.id}>
        <InboxLine
          attrs={{
            'data-inbox-item': session.id,
            'data-inbox-kind': waitingRow ? 'waiting' : 'running',
            'data-run': item.run ?? undefined
          }}
          leading={
            waitingRow ? (
              <GlyphCell>
                <MessageCircleQuestion size={17} aria-hidden="true" className="text-warning" />
              </GlyphCell>
            ) : (
              <GlyphCell label={runLabelOf(item.run)}>{iconOf(session, item.run)}</GlyphCell>
            )
          }
          title={<RedactedText text={session.title} />}
          preview={
            waitingRow
              ? t('inbox.asks', { count: item.asks })
              : item.run === 'resident'
                ? commandsPreview(item.commands)
                : null
          }
          trailing={trailing}
          indent={indent}
          selected={session.id === activeId}
          onOpen={() => select(session.id)}
        />
      </RedactionSessionProvider>
    )
  }

  const renderAsk = (ask: InboxAsk, indent: boolean): React.JSX.Element => {
    const key = askKeyOf(ask)
    const waited = answering.waited(ask.request.createdAt)
    return key === answering.openKey ? (
      <InboxAskCard
        key={key}
        ask={ask}
        waited={waited}
        context={answering.context}
        onCollapse={answering.collapse}
        onResponse={(response) => answering.respond(ask, response)}
      />
    ) : (
      <InboxAskRow
        key={key}
        ask={ask}
        waited={waited}
        indent={indent}
        selected={ask.session.id === activeId}
        onOpen={() => answering.open(key)}
      />
    )
  }

  /** 一条挂着询问的会话：询问表里有它就一条询问一行；还没取到（或宿主给不出）就是一行，点了打开会话 */
  const renderWaiting = (item: InboxItem, indent = false): React.ReactNode =>
    pending?.[item.session.id] === undefined
      ? renderSessionRow(item, indent)
      : answering.items
          .filter((ask) => ask.session.id === item.session.id)
          .map((ask) => renderAsk(ask, indent))

  const renderFamily = (family: InboxFamily, section: SectionName): React.ReactNode => {
    const { root, rootItem, rootUnread } = family
    const childCount = familyChildCount(family)
    // 只有它自己：与普通的一行一样
    if (childCount === 0) {
      if (section === 'waiting' && rootItem) return renderWaiting(rootItem)
      if (section === 'running' && rootItem) return renderSessionRow(rootItem)
      return rootUnread ? renderUnreadRow(rootUnread) : null
    }

    const rootAsks = !!rootItem && rootItem.asks > 0
    const isOpen = openFamilies.has(root.id)
    // 父会话自己在等你回答时它的询问占着那一行，圆点没处放：在运行的子会话就都摆出来
    const foldRunning = !rootAsks && family.running.length > 0
    const pips = (
      <FamilyPips
        family={family}
        open={isOpen}
        label={t('inbox.childCount', { count: childCount })}
        onToggle={foldRunning ? () => toggleFamily(root.id) : undefined}
      />
    )

    let head: React.ReactNode
    if (rootAsks && rootItem) head = renderWaiting(rootItem)
    else if (rootUnread) head = renderUnreadRow(rootUnread, false, pips)
    else if (rootItem) head = renderSessionRow(rootItem, false, pips)
    else {
      // 父会话停着、没有新回复：只是这一家的抬头
      head = (
        <RedactionSessionProvider sessionId={root.id}>
          <InboxLine
            attrs={{ 'data-inbox-family-head': root.id }}
            leading={<GlyphCell>{iconOf(root, null)}</GlyphCell>}
            title={<RedactedText text={root.title} />}
            trailing={pips}
            selected={root.id === activeId}
            onOpen={() => select(root.id)}
          />
        </RedactionSessionProvider>
      )
    }

    return (
      <Fragment key={root.id}>
        {head}
        <div data-inbox-children={root.id} className="flex flex-col">
          {family.waiting.map((item) => (
            <Fragment key={item.session.id}>{renderWaiting(item, true)}</Fragment>
          ))}
          {family.unread.map((item) => renderUnreadRow(item, true))}
          {(!foldRunning || isOpen) && family.running.map((item) => renderSessionRow(item, true))}
        </div>
      </Fragment>
    )
  }

  // 一张列表，按轻重缓急：等你回答 > 新回复 > 运行中（一家归在它最急的那一类，见 inboxFamiliesOf）
  const ranked = (['waiting', 'unread', 'running'] as const).flatMap((name) =>
    families[name].map((family) => ({ family, name }))
  )
  const markAll =
    unread.some((item) => !item.held) && sessionApi.markAllRead ? (
      <button
        type="button"
        data-inbox-mark-all-read=""
        onClick={() => void sessionApi.markAllRead?.()}
        title={t('inbox.markAllRead')}
        aria-label={t('inbox.markAllRead')}
        className="ml-auto mr-1 flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover/60 hover:text-text-primary"
      >
        <CheckCheck size={15} aria-hidden="true" />
      </button>
    ) : null

  const sessionBlock =
    ranked.length === 0 ? null : (
      <section data-inbox-section="sessions" aria-label={t('inbox.sessionsSection')}>
        <h2 className={SECTION_HEADING}>
          <span className="min-w-0 truncate">{t('inbox.sessionsSection')}</span>
          {markAll}
        </h2>
        <div className="flex flex-col">
          {ranked.map(({ family, name }) => (
            <Fragment key={family.root.id}>{renderFamily(family, name)}</Fragment>
          ))}
        </div>
      </section>
    )

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={rootRef}
        data-inbox-panel=""
        {...{ [OPTION_HOTKEY_SCOPE_ATTR]: '' }}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 outline-none"
      >
        {!hasContent ? (
          <div
            data-inbox-empty=""
            className="mt-24 flex flex-col items-center gap-2 px-4 text-center"
          >
            <Inbox
              size={32}
              strokeWidth={1.5}
              aria-hidden="true"
              className="text-text-tertiary/60"
            />
            <div className="text-[13px] text-text-tertiary">{t('inbox.emptyTitle')}</div>
          </div>
        ) : (
          <OptionHotkeyScopeContext.Provider value={true}>
            <OptionHotkeyGuardContext.Provider value={hotkeyGuard}>
              {tracking && trackingItems && (
                <InboxTrackingSection
                  adapter={tracking}
                  items={trackingItems}
                  now={now}
                  patch={patchTracking}
                  rescan={rescanTracking}
                  onArchived={onTrackingArchived}
                />
              )}
              {sessionBlock}
            </OptionHotkeyGuardContext.Provider>
          </OptionHotkeyScopeContext.Provider>
        )}
      </div>
      {toast && (
        <div
          key={toast.n}
          role="status"
          data-inbox-archived=""
          className="absolute bottom-4 left-1/2 flex max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-[10px] bg-text-primary py-2 pl-3.5 pr-2.5 text-[13px] text-bg-primary shadow-lg"
        >
          <span className="truncate">{t('inbox.trackingArchived', { title: toast.title })}</span>
          <button
            type="button"
            data-inbox-undo=""
            onClick={toast.undo}
            className="shrink-0 rounded-md bg-bg-primary/20 px-2 py-0.5 text-[12px] font-semibold transition-colors hover:bg-bg-primary/30"
          >
            {t('inbox.undo')}
          </button>
        </div>
      )}
    </div>
  )
}
