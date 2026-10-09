import { useChatHost } from '@shuvix/chat-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type FlatIndexLocationWithAlign, type VirtuosoHandle } from 'react-virtuoso'
import {
  useChatStore,
  selectIsStreaming,
  selectPendingInputs,
  selectPendingPrompt
} from '../../stores/chatStore'
import { useChatActions } from '../../hooks/useChatActions'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { MessageRenderer, type VisibleItem } from './MessageRenderer'
import { buildVisibleItems, isAssistantMessage } from './conversationItems'
import { StreamingFooter } from './StreamingFooter'
import { PendingInputsPanel } from './PendingInputsPanel'
import { InputArea } from './InputArea'
import { ScrollToBottomButton } from './ScrollToBottomButton'

/** Virtuoso Footer：流式指示器 + 底部留白（高度 = 悬浮输入卡片实高，经 --chat-input-h 变量传递） */
function ConversationFooter(): React.JSX.Element {
  return (
    <>
      <StreamingFooter />
      <div aria-hidden style={{ height: 'var(--chat-input-h, 0px)' }} />
    </>
  )
}

/**
 * 列表的「底部」：最后一项的**底边**贴视口底边。Virtuoso 对最后一项 + `align: 'end'` 会把 Footer 高度
 * 一并算进去，所以落点是真正的底 —— 末尾那几行不压在悬浮输入卡片下面。
 * 从前用 `align: 'start'`（最后一项的顶边贴视口顶边）：一轮对话整个折成一张卡，最后一轮一长，
 * 打开会话看到的就是那一轮的开头，还得自己往下翻。模块级常量：每次渲染给新对象会让 Virtuoso 重算
 */
const LIST_BOTTOM: FlatIndexLocationWithAlign = { index: 'LAST', align: 'end' }
/** 离底部多远（px）才算「不在底部」：末尾一两行被输入卡片挡住、流式时刚长出几行，都不该把按钮招出来 */
const AT_BOTTOM_THRESHOLD = 160
/**
 * 列表挂上后多久才认它报的「不在底部」：初始定位要等几帧才落地，在那之前 Virtuoso 会先报一次「不在底部」，
 * 不拦着按钮就会在每次切会话时闪一下。第一次落到底即提前结束；初始定位本来就不在底部（日历跳到中间某天）
 * 时由这个宽限期兜底
 */
const BOTTOM_STATE_GRACE_MS = 800
/**
 * 落地之后多久内仍跟着底部：落地之后还会有东西长高 —— 末项里异步渲染的块（mermaid 图）、输入卡片顶格的
 * 询问面板（撑高 Footer），以及列表本身变矮（会话横幅、智能体条在 agent.init 回来后才出现，把列表上沿往下压；
 * 实测压低 29px，末尾那截就钻到输入卡片底下，又不到招出按钮的距离）。只跟随一次没被打扰的落地：用户自己
 * 一动（滚轮、触摸、按下鼠标或按键、往上滚）立即松开
 */
const PIN_TO_BOTTOM_MS = 3000
/** 离底部超过几屏就直接跳，不做平滑滚动：虚拟列表平滑滚过很长一段要沿途量一遍高度，又慢又抖 */
const SMOOTH_SCROLL_MAX_SCREENS = 3

// 折叠规则本体搬去了 `conversationItems.ts`（纯逻辑，不牵扯渲染树）；按同名再导出，
// ThreadDrawer 等既有 import 路径不动
export { buildVisibleItems } from './conversationItems'

/** 某条消息所在的可见项下标（助手卡里的任一条也算）；不在当前上下文回 -1 */
function indexOfMessage(items: VisibleItem[], messageId: string): number {
  return items.findIndex(
    (item) => item.msg.id === messageId || item.msgs?.some((m) => m.id === messageId)
  )
}

/**
 * 消息列表（虚拟滚动）+「回到底部」按钮。由 Conversation 按会话 key 重挂，所以下面的状态天然只属于
 * 这一条会话的这一份列表：换会话、或回退清空后重新出现，都从头来过。
 */
interface MessageListProps {
  items: VisibleItem[]
  renderItem: (index: number, item: VisibleItem) => React.ReactNode
  /** 本会话正在运行：按钮平时换成运行指示（见 ScrollToBottomButton） */
  running: boolean
  /** 本会话待办的日历跳转（点进某天 → 滚到当天第一条用户消息）；没有为 null */
  scrollRequest: { messageId: string; nonce: number } | null
}

function MessageList({
  items,
  renderItem,
  running,
  scrollRequest
}: MessageListProps): React.JSX.Element {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  // 初始定位只认挂载那一刻：那时已有日历跳转就直接落在目标上（记下用掉的是哪一个请求），否则落在底部。
  // 按请求对象认而不按 nonce 认：nonce 在请求清掉之后又从 1 数起，下一次点日历会撞上同一个数
  const [initial] = useState<{
    location: FlatIndexLocationWithAlign
    request: MessageListProps['scrollRequest']
  }>(() => {
    const index = scrollRequest ? indexOfMessage(items, scrollRequest.messageId) : -1
    return index >= 0
      ? { location: { index, align: 'start' }, request: scrollRequest }
      : { location: LIST_BOTTOM, request: null }
  })
  const [atBottom, setAtBottom] = useState(true)
  /** 初始定位是否已过：过了才认「不在底部」、才执行后到的日历跳转（见 BOTTOM_STATE_GRACE_MS） */
  const [settled, setSettled] = useState(false)

  // 落地后的短暂跟随（见 PIN_TO_BOTTOM_MS）。listeners 是挂在滚动容器上、用来察觉用户动作的那几个监听
  const pinnedRef = useRef(initial.location === LIST_BOTTOM)
  /** 已经落到过底部：在那之前 Virtuoso 自己的初始定位也会上下修正，不能当成用户往上滚 */
  const landedRef = useRef(false)
  const listenersRef = useRef<AbortController | null>(null)
  const unpin = useCallback(() => {
    pinnedRef.current = false
    listenersRef.current?.abort()
    listenersRef.current = null
  }, [])

  const handleAtBottomChange = useCallback((value: boolean) => {
    setAtBottom(value)
    if (value) {
      setSettled(true)
      landedRef.current = true
    }
  }, [])
  useEffect(() => {
    const settle = setTimeout(() => setSettled(true), BOTTOM_STATE_GRACE_MS)
    const release = setTimeout(unpin, PIN_TO_BOTTOM_MS)
    return () => {
      clearTimeout(settle)
      clearTimeout(release)
      unpin()
    }
  }, [unpin])
  // 贴底：直接把滚动容器滚到最底，合并到下一帧（一帧至多一次）。不在 Virtuoso / ResizeObserver 的回调里
  // 同步改滚动位置 —— 那会让同一帧里的尺寸观察再触发一轮（「ResizeObserver loop」）
  const stickFrame = useRef(0)
  const stickToBottom = useCallback(() => {
    if (stickFrame.current) return
    stickFrame.current = requestAnimationFrame(() => {
      stickFrame.current = 0
      const el = scrollerRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])
  useEffect(() => () => cancelAnimationFrame(stickFrame.current), [])
  // 列表总高（含 Footer，所以输入卡片长高也算）变了：还在跟随就再贴一次底
  const handleTotalHeightChange = useCallback(() => {
    if (pinnedRef.current) stickToBottom()
  }, [stickToBottom])

  // 日历跳转。请求经一次 IPC 才到，可能早于也可能晚于列表挂载：早于 → 上面已当作初始定位用掉，这里只清；
  // 晚于 → 等初始定位过了再滚 —— Virtuoso 的初始定位要隔几帧才落地，赶在它之前滚，会被它拉回底部。
  // 滚完或目标不在当前上下文都清掉，免得 items 再变（流式/新消息）把用户弹回去
  useEffect(() => {
    if (!scrollRequest) return
    if (scrollRequest !== initial.request) {
      if (!settled) return
      unpin()
      const index = indexOfMessage(items, scrollRequest.messageId)
      if (index >= 0) virtuosoRef.current?.scrollToIndex({ index, align: 'start' })
      document
        .querySelector(`[data-msg-id=${JSON.stringify(scrollRequest.messageId)}]`)
        ?.scrollIntoView({ block: 'start' })
    }
    useChatStore.getState().clearScrollToMessage()
  }, [scrollRequest, settled, items, initial, unpin])

  // 列表本身变矮（上方横幅出现、底部面板拉开、窗口缩小）：跟随期内照贴；跟随期外，原本正贴在底就留在底 ——
  // 视口从上沿收进来时滚动位置不动，末尾会被往下推到输入卡片底下。只管变矮、只管原本就在最底，
  // 所以不会替用户做「流式时跟着往下走」的决定（那仍是没有 followOutput 的老样子）
  const resizeRef = useRef<ResizeObserver | null>(null)
  useEffect(() => () => resizeRef.current?.disconnect(), [])

  const handleScrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      scrollerRef.current = el instanceof HTMLElement ? el : null
      listenersRef.current?.abort()
      listenersRef.current = null
      resizeRef.current?.disconnect()
      resizeRef.current = null
      const scroller = scrollerRef.current
      if (!scroller) return
      if (typeof ResizeObserver !== 'undefined') {
        let prevHeight = scroller.clientHeight
        const observer = new ResizeObserver(() => {
          const height = scroller.clientHeight
          const wasAtEnd = scroller.scrollHeight - scroller.scrollTop - prevHeight <= 2
          if (pinnedRef.current || (height < prevHeight && wasAtEnd)) stickToBottom()
          prevHeight = height
        })
        observer.observe(scroller)
        resizeRef.current = observer
      }
      if (!pinnedRef.current) return
      const listeners = new AbortController()
      const options = { passive: true, signal: listeners.signal }
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        scroller.addEventListener(type, unpin, options)
      }
      // 往上滚也算用户在动（拖滚动条之外，脚本 / 查找定位也是这样）；跟随自己只会往下贴
      let lastTop = scroller.scrollTop
      scroller.addEventListener(
        'scroll',
        () => {
          if (landedRef.current && scroller.scrollTop < lastTop - 1) unpin()
          lastTop = scroller.scrollTop
        },
        options
      )
      listenersRef.current = listeners
    },
    [unpin, stickToBottom]
  )
  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current
    const far =
      !el ||
      el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * SMOOTH_SCROLL_MAX_SCREENS
    virtuosoRef.current?.scrollToIndex({ ...LIST_BOTTOM, behavior: far ? 'auto' : 'smooth' })
  }, [])

  return (
    <>
      <Virtuoso
        ref={virtuosoRef}
        // conversation-scroller：供外壳按需微调本列滚动条（如会话面板展开时内缩轨道、加宽可点范围，见 base.css）
        // relative z-0：把正文自成一个层叠上下文，正文内的定位元素（时间线头像、代码块按钮…）
        // 不再溢出到悬浮输入卡片之上——卡片在 DOM 中更靠后，始终盖住正文
        className="relative z-0 flex-1 min-w-0 thin-scrollbar conversation-scroller"
        data={items}
        itemContent={renderItem}
        components={{ Footer: ConversationFooter }}
        initialTopMostItemIndex={initial.location}
        increaseViewportBy={{ top: 200, bottom: 400 }}
        computeItemKey={(_index, item) => item.key}
        scrollerRef={handleScrollerRef}
        atBottomThreshold={AT_BOTTOM_THRESHOLD}
        atBottomStateChange={handleAtBottomChange}
        totalListHeightChanged={handleTotalHeightChange}
      />
      {/* 排在输入卡片之前：卡片向上展开的浮层要盖住它（见 ScrollToBottomButton） */}
      <ScrollToBottomButton
        visible={settled && !atBottom}
        running={running}
        onClick={scrollToBottom}
      />
    </>
  )
}

/**
 * 对话区核心 —— 消息列表（虚拟滚动 + 归档回溯）+ 待处理输入 + 输入区。
 *
 * 这是可复用的"中间对话框"本体：只依赖 chatStore / ChatApi / ChatHost，
 * 不含标题栏、侧边栏/浏览器开关、会话配置等宿主外壳 chrome（那些在 ChatView 里）。
 */
export function Conversation({
  sessionId,
  emptyState,
  inputTop
}: {
  sessionId: string
  /** 会话无消息时的占位（宿主可注入，如桌面的会话配置面板）；缺省为简单提示文案 */
  emptyState?: React.ReactNode
  /**
   * 输入卡片最顶格的宿主内容（InputArea 的 thread 插槽）—— Chrome 侧边栏把「这条消息带哪些标签页」
   * 的选择放在这里，紧挨着要发出去的那段话
   */
  inputTop?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore(selectIsStreaming)
  // 正在发送、后端还没落库的那条用户消息（乐观占位；视图里出现这条用户消息就撤）
  const pendingPrompt = useChatStore(selectPendingPrompt)
  // 悬浮输入卡片高度 → 根容器 CSS 变量（列表 Footer / 空态 padding 引用），避免卡片遮住末尾内容。
  // 直接写 DOM 变量而非 state：高度随输入增长高频变化，不触发列表重渲染
  const rootRef = useRef<HTMLDivElement>(null)
  const handleInputHeightChange = useCallback((h: number) => {
    rootRef.current?.style.setProperty('--chat-input-h', `${h}px`)
  }, [])

  const focusMode = useChatHost().appearance.focusMode
  // 有待处理输入（ask / 审批）时不淡化：它们在等用户响应，鼠标没悬浮也必须一眼看见
  const hasPendingInputs = useChatStore((s) => selectPendingInputs(s).length > 0)
  const dim = focusMode && !hasPendingInputs

  const {
    handleRollback,
    pendingRollbackId,
    confirmRollback,
    cancelRollback,
    handleRegenerate,
    canRollback,
    handleInputResponse
  } = useChatActions(sessionId)
  // PIN-07：会话不能回退（旧格式只读 / 没有存储）就不给回退与重新生成的入口
  const onRollback = canRollback ? handleRollback : undefined
  const onRegenerate = canRollback ? handleRegenerate : undefined

  // 预构建可见消息列表，messages 不变时复用缓存。
  // 注：被压缩掉的历史不在其中 —— message.list 走 buildContextEntries，自带压缩过滤，
  // 压缩点之前的消息原地换成一张摘要卡片，UI 不提供回看入口。
  const visibleItems = useMemo(
    () => buildVisibleItems(messages, isStreaming, pendingPrompt),
    [messages, isStreaming, pendingPrompt]
  )
  // 列表等这条会话的视图到了再挂。视图到达之前 messages 是空的，却可能已经有东西要画：运行中的会话
  // 退订时留下「还在跑」的余项（isStreaming，见 releaseSessionView），切回来就是一张孤零零的流式占位卡。
  // 那时挂上列表，初始定位落在这一项上；等真消息到了，初始定位早已用掉，列表就停在会话开头。
  // 乐观占位例外：那是刚建、还没有历史的会话，没有「底部」可找，刚发出的那句话也不能等后端
  const viewLoaded = useChatStore((s) => s.sessionViews[sessionId] !== undefined)
  const listReady = viewLoaded || !!pendingPrompt
  // 仅当最后一条消息是助手消息时才允许重新生成
  const lastAssistantId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last && isAssistantMessage(last) ? last.id : null
  }, [messages])

  // 日历点进某天的跳转请求（只取本会话的）；执行在 MessageList 里，那里知道初始定位落地了没有
  const scrollRequest = useChatStore((s) =>
    s.scrollToMessageRequest?.sessionId === sessionId ? s.scrollToMessageRequest : null
  )

  /** 渲染单条可见消息 */
  const renderItem = useCallback(
    (_index: number, item: VisibleItem) => (
      <MessageRenderer
        item={item}
        lastAssistantId={lastAssistantId}
        onRollback={onRollback}
        onRegenerate={onRegenerate}
      />
    ),
    [lastAssistantId, onRollback, onRegenerate]
  )

  return (
    <>
      {/* 对话列 relative 锚点：悬浮输入卡片绝对贴底定位于此（与笔记本会话同构） */}
      <div ref={rootRef} className="relative flex-1 min-h-0 flex flex-col">
        {/* 空态只在**真的什么都没有**时才顶上：乐观占位也算内容 —— 漏掉它，「新会话第一条消息」
            与「只有一轮时点重新生成」这两条路上，刚发出的那句话会被整片空态盖住（回退清空了
            messages，而这两条路上流式态都没开着），正是占位要解决的那个毛病 */}
        {messages.length === 0 && !isStreaming && !pendingPrompt ? (
          // 空态同样按输入卡片高度留白，避免居中内容被悬浮卡片遮挡
          <div
            className="flex-1 min-h-0 flex flex-col"
            style={{ paddingBottom: 'var(--chat-input-h, 0px)' }}
          >
            {emptyState ?? (
              <div className="flex-1 flex items-center justify-center px-6">
                <p className="text-sm text-text-tertiary">{t('chat.emptyHint')}</p>
              </div>
            )}
          </div>
        ) : !listReady ? (
          // 有余项占位、视图还没到：先空着，等视图带着真消息到了再挂列表（见 listReady）
          <div className="flex-1 min-h-0" />
        ) : (
          // 按会话重挂：初始定位只在挂载那一刻生效，「在不在底部」的状态也只属于这一份列表
          <MessageList
            key={sessionId}
            items={visibleItems}
            renderItem={renderItem}
            running={isStreaming}
            scrollRequest={scrollRequest}
          />
        )}

        {/* 输入区（悬浮卡片）：待处理用户输入经 accessory 并入卡片顶格，与输入区同一张卡片 */}
        <div
          className={`transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100 focus-within:opacity-100' : ''}`}
        >
          <InputArea
            thread={inputTop}
            accessory={<PendingInputsPanel onResponse={handleInputResponse} />}
            onHeightChange={handleInputHeightChange}
          />
        </div>
      </div>

      {/* 回退确认弹窗 */}
      {pendingRollbackId && (
        <ConfirmDialog
          title={t('chat.rollbackConfirm')}
          description={t('chat.rollbackWarning')}
          confirmText={t('common.confirm')}
          cancelText={t('common.cancel')}
          onConfirm={confirmRollback}
          onCancel={cancelRollback}
        />
      )}
    </>
  )
}
