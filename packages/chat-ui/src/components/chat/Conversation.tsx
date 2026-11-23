import { useChatHost } from '@shuvix/chat-ui'
import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  Virtuoso,
  type ContextProp,
  type FlatIndexLocationWithAlign,
  type ListProps,
  type VirtuosoHandle
} from 'react-virtuoso'
import {
  useChatStore,
  selectActivePendingInput,
  selectIsStreaming,
  selectPendingInputs,
  selectPendingPrompt,
  selectSessionQueueItems
} from '../../stores/chatStore'
import { useChatActions } from '../../hooks/useChatActions'
import { useCompactedHistory } from '../../hooks/useCompactedHistory'
import { forkRefusalKey, selectSessionForkable, useSessionFork } from '../../hooks/useSessionFork'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { MessageRenderer, type VisibleItem } from './MessageRenderer'
import { buildVisibleItems, isAssistantMessage, newContentIndex } from './conversationItems'
import { NewContentDivider } from './NewContentDivider'
import { useUnreadStore } from '../../stores/unreadStore'
import { SuggestionContext } from './SuggestionCards'
import { suggestionStatesOf } from '@shuvix/chat-protocol/suggestions'
import { StreamingFooter } from './StreamingFooter'
import { TaskListPanel } from './TaskListPanel'
import { PendingInputsCard, pendingCardOnScreen } from './PendingInputsCard'
import { InputArea } from './InputArea'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { ViewLoadGate } from './ConversationLoadBar'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

/** 列表经 Virtuoso 交给 List / Footer 的上下文 */
interface ListContext {
  /** 量到真的贴底了（见 ConversationList） */
  landed: boolean
  onInputResponse: (requestId: string, response: InputResponse) => void | Promise<void>
}

/**
 * Virtuoso Footer：流式指示器 + 任务列表 + 等人回答的询问卡片 + 底部留白（高度 = 悬浮输入卡片实高，经 --chat-input-h 变量传递）。
 * 询问排在对话的最末尾，而不是发起它的工具行旁边：工具行常被折进步骤组，派生 agent 的询问在这条对话里也没有工具行，
 * 几个工具并行时还会同时有几张。任务列表同理钉在最新内容之下，排在询问卡片之上（询问更急，要紧挨着输入框）
 */
function ConversationFooter({ context }: ContextProp<ListContext>): React.JSX.Element {
  return (
    <>
      <StreamingFooter />
      <TaskListPanel />
      <PendingInputsCard onResponse={context.onInputResponse} />
      <div aria-hidden style={{ height: 'var(--chat-input-h, 0px)' }} />
    </>
  )
}

/**
 * Virtuoso 定位初始项的时候把列表藏着（visibility: hidden），定位完还要等一个固定 150ms 的定时器（看高度还变不变）
 * 才揭开：不管会话多大，每次打开都要空白 250ms 以上，比数据到达（几十毫秒）慢得多。量到真的贴底（`landed`，
 * 见 MessageList）就不必再藏：之后高度再变由下面的跟随贴底接住。初始定位不在底部（日历跳到中间）的照旧等
 * Virtuoso 自己揭开
 */
const ConversationList = forwardRef<
  HTMLDivElement,
  Omit<ListProps, 'ref'> & ContextProp<ListContext>
>(function ConversationList({ context, style, ...rest }, ref) {
  return (
    <div ref={ref} {...rest} style={context.landed ? { ...style, visibility: 'visible' } : style} />
  )
})

/** 模块级常量：每次渲染给新组件会让 Virtuoso 重挂列表 */
const LIST_COMPONENTS = { Footer: ConversationFooter, List: ConversationList }

/**
 * 列表的「底部」：最后一项的**底边**贴视口底边。Virtuoso 对最后一项 + `align: 'end'` 会把 Footer 高度
 * 一并算进去，所以落点是真正的底 —— 末尾那几行不压在悬浮输入卡片下面。
 * 从前用 `align: 'start'`（最后一项的顶边贴视口顶边）：一轮对话整个折成一张卡，最后一轮一长，
 * 打开会话看到的就是那一轮的开头，还得自己往下翻。模块级常量：每次渲染给新对象会让 Virtuoso 重算
 */
const LIST_BOTTOM: FlatIndexLocationWithAlign = { index: 'LAST', align: 'end' }
/** 离真底不超过这么多（px）才算贴底，见 hasLanded */
const LANDED_SLACK_PX = 4

/**
 * 这一屏是不是已经是真内容、停在真底：有项渲染出来、上沿被铺满（第一项顶到视口上沿，或它就是开头）、最后一项的
 * 底边在视口内、滚动条也到底了。都量真实 DOM —— Virtuoso 第一次报「在底部」时高度还是估的（实测真底还差 6000px），
 * 只有一项的探测阶段总高也可能正好「到底」
 */
function hasLanded(scroller: HTMLElement): boolean {
  const rendered = scroller.querySelectorAll<HTMLElement>('[data-item-index]')
  if (rendered.length === 0) return false
  const view = scroller.getBoundingClientRect()
  const first = rendered[0]
  // `data-index` 是数据里的下标（从 0 数）；`data-item-index` 带着 firstItemIndex（压缩前的历史接在上面时它不从 0 起）
  const dataIndex = first.dataset.index ?? first.dataset.itemIndex
  const startsFilled = dataIndex === '0' || first.getBoundingClientRect().top <= view.top
  const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  return (
    startsFilled &&
    rendered[rendered.length - 1].getBoundingClientRect().bottom <= view.bottom &&
    dist <= LANDED_SLACK_PX
  )
}

/** 离底部多远（px）才算「不在底部」：末尾一两行被输入卡片挡住、流式时刚长出几行，都不该把按钮招出来 */
const AT_BOTTOM_THRESHOLD = 160
/**
 * 列表挂上后多久才认它报的「不在底部」：初始定位要等几帧才落地，在那之前 Virtuoso 会先报一次「不在底部」，
 * 不拦着按钮就会在每次切会话时闪一下。第一次落到底即提前结束；初始定位本来就不在底部（日历跳到中间某天）
 * 时由这个宽限期兜底
 */
const BOTTOM_STATE_GRACE_MS = 800
/**
 * Virtuoso 的 `firstItemIndex` 起点：压缩前的历史接在列表上面时，它减去接上的项数，Virtuoso 据此保住
 * 眼前那一项的位置（不跳）。只能是正数，所以从一个够大的数起
 */
const FIRST_ITEM_BASE = 1_000_000
/** 离顶部多近（px）就去取上面那一段：留一点余量，翻到顶之前就接上，不用停下来等 */
const AT_TOP_THRESHOLD = 600
/**
 * 接上压缩前的一段之后，最多再摆正几帧：接上的项先按估计的高度排，画出来量到真高才变（一张长卡可以差上千 px），
 * 量完之前眼前那一项会被顶走。连续这么多帧没再动就收手
 */
const PREPEND_SETTLE_FRAMES = 6
const PREPEND_MAX_FRAMES = 90
/**
 * 落地之后多久内仍跟着底部：落地之后还会有东西长高 —— 末项里异步出现的块（某种 mermaid 图第一次用到、等它的图类型分包加载）、输入卡片顶格的
 * 询问面板（撑高 Footer），以及列表本身变矮（会话横幅、智能体条在 agent.init 回来后才出现，把列表上沿往下压；
 * 实测压低 29px，末尾那截就钻到输入卡片底下，又不到招出按钮的距离）。只跟随一次没被打扰的落地：用户自己
 * 一动（滚轮、触摸、按下鼠标或按键、往上滚）立即松开
 */
const PIN_TO_BOTTOM_MS = 3000
/** 新询问露面之后多久内继续贴底：卡片的表单隔一拍才画出来（draft 在 effect 里初始化），Footer 随后才长高 */
const REVEAL_ASK_MS = 400
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
  sessionId: string
  /** 当前视图的消息（压缩前历史的锚点与查重看它） */
  messages: readonly ChatMessage[]
  /** 当前上下文的项（压缩前历史由列表自己接在它们上面） */
  items: VisibleItem[]
  /**
   * 画一项。`index` 是它在 `items`（当前上下文）里的下标；`compacted` = 接上来的压缩前历史（只读），那时 index 为 -1
   */
  renderItem: (index: number, item: VisibleItem, compacted: boolean) => React.ReactNode
  /** 本会话正在运行：按钮平时换成运行指示（见 ScrollToBottomButton） */
  running: boolean
  /** 本会话待办的日历跳转（点进某天 → 滚到当天第一条用户消息）；没有为 null */
  scrollRequest: { messageId: string; nonce: number } | null
  /**
   * 滚动容器的竖向滚动条占了多宽（px，没有滚动条为 0）；变了才报，卸载时报 0。
   * 正文按滚动容器的内容区居中，悬浮在列表上的输入卡片与「回到底部」按钮要据此让出同一条，三者才同一根中线
   */
  onScrollbarWidthChange: (px: number) => void
  /** 消息已经可见（量到贴底，或过了宽限期）：外面的进度条可以撤了 */
  onLanded: () => void
  /** 询问卡片（在列表 Footer 里）的回答 */
  onInputResponse: (requestId: string, response: InputResponse) => void | Promise<void>
}

function MessageList({
  sessionId,
  messages,
  items: currentItems,
  renderItem,
  running,
  scrollRequest,
  onScrollbarWidthChange,
  onLanded,
  onInputResponse
}: MessageListProps): React.JSX.Element {
  // 压缩前的历史：往上翻到顶就把压缩掉的那一段接在最上面（只给人看，见 useCompactedHistory）。状态挂在这里而不是
  // Conversation：列表按会话重挂，换会话、再回来都从头来过。一段一段单独建项，助手卡的 key 带着这一段的前缀 ——
  // 与当前上下文的 turn:… 不撞，再往上接一段也不动已经接上的项
  // 接上之前眼前那一项（当前上下文的第一项，即压缩摘要那条分隔线）离滚动区上沿多远：接上之后照着摆回去，
  // 屏幕不动。Virtuoso 的 firstItemIndex 只按估计的高度保位置，接上的项一画出来量到真高就会把它顶走
  const scrollerRef = useRef<HTMLElement | null>(null)
  const prependedRef = useRef(0)
  /** 当前上下文第一项的消息 id（按 `data-msg-id` 找它，不按下标：接上的那一刻下标跟着变） */
  const anchorIdRef = useRef<string | undefined>(currentItems[0]?.msg.id)
  useEffect(() => {
    anchorIdRef.current = currentItems[0]?.msg.id
  }, [currentItems])
  const prependAnchor = useRef<{ id: string; offset: number } | null>(null)
  /** 正在摆的那个位置（摆正的循环还没收手）：这时接着又取回一段（还在顶上，接着取），记它而不是现量 —— 现量的是半路上的一帧 */
  const restoring = useRef<{ id: string; offset: number } | null>(null)
  const captureAnchor = useCallback(() => {
    prependAnchor.current = null
    if (restoring.current && restoring.current.id === anchorIdRef.current) {
      prependAnchor.current = restoring.current
      return
    }
    const scroller = scrollerRef.current
    const id = anchorIdRef.current
    if (!scroller || id === undefined) return
    const found = scroller.querySelector<HTMLElement>(`[data-msg-id=${JSON.stringify(id)}]`)
    // 量 Virtuoso 包着这一项的那一层（`data-index`）：项与项首尾相接，摆正时没画出它也能用上面那一项的下沿推出它的位置
    const node = found?.closest<HTMLElement>('[data-index]') ?? found
    if (!node) return
    prependAnchor.current = {
      id,
      offset: node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    }
  }, [])
  const compactedOptions = useMemo(() => ({ onBeforePrepend: captureAnchor }), [captureAnchor])
  const compacted = useCompactedHistory(sessionId, messages, compactedOptions)
  const compactedItems = useMemo(
    () =>
      compacted.segments.flatMap((segment) =>
        buildVisibleItems(
          segment.messages,
          false,
          null,
          undefined,
          `compacted:${segment.compactionId}:`
        )
      ),
    [compacted.segments]
  )
  const prependedCount = compactedItems.length
  const items = useMemo(
    () => (prependedCount === 0 ? currentItems : [...compactedItems, ...currentItems]),
    [compactedItems, currentItems, prependedCount]
  )
  const onReachTop = compacted.canLoad ? compacted.load : undefined
  // 布局阶段就跟上（排在下面那个摆位置的 useLayoutEffect 之前）：摆位置时要读这一次的 items
  const itemsRef = useRef(items)
  useLayoutEffect(() => {
    itemsRef.current = items
  }, [items])

  const virtuosoRef = useRef<VirtuosoHandle>(null)
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

  /** 量到真的贴底了：揭开列表（见 ConversationList） */
  const [landed, setLanded] = useState(false)
  const checkLanded = useCallback(() => {
    const el = scrollerRef.current
    if (!el || hasLanded(el)) setLanded(true)
  }, [])
  // 初始定位不在底部（日历跳到中间）：不会有贴底那一刻，列表由 Virtuoso 自己揭开，进度条不等它
  const startsAtBottom = initial.location === LIST_BOTTOM
  useEffect(() => {
    if (landed || !startsAtBottom) onLanded()
  }, [landed, startsAtBottom, onLanded])
  const listContext = useMemo(() => ({ landed, onInputResponse }), [landed, onInputResponse])

  const handleAtBottomChange = useCallback(
    (value: boolean) => {
      setAtBottom(value)
      if (value) {
        setSettled(true)
        landedRef.current = true
        checkLanded()
      }
    },
    [checkLanded]
  )
  useEffect(() => {
    const settle = setTimeout(() => {
      setSettled(true)
      // 窗口在后台之类量不到贴底：到点也算上屏
      onLanded()
    }, BOTTOM_STATE_GRACE_MS)
    const release = setTimeout(unpin, PIN_TO_BOTTOM_MS)
    return () => {
      clearTimeout(settle)
      clearTimeout(release)
      unpin()
    }
  }, [unpin, onLanded])
  // 贴底：直接把滚动容器滚到最底，合并到下一帧（一帧至多一次）。不在 Virtuoso / ResizeObserver 的回调里
  // 同步改滚动位置 —— 那会让同一帧里的尺寸观察再触发一轮（「ResizeObserver loop」）
  const stickFrame = useRef(0)
  const stickToBottom = useCallback(() => {
    if (stickFrame.current) return
    stickFrame.current = requestAnimationFrame(() => {
      stickFrame.current = 0
      const el = scrollerRef.current
      if (el) el.scrollTop = el.scrollHeight
      checkLanded()
    })
  }, [checkLanded])
  useEffect(() => () => cancelAnimationFrame(stickFrame.current), [])
  // 列表总高（含 Footer，所以询问卡片长高也算）变了：还在跟随就再贴一次底
  const revealAskRef = useRef(false)
  const measureAskCardRef = useRef<() => void>(() => {})
  const handleTotalHeightChange = useCallback(() => {
    if (pinnedRef.current || revealAskRef.current) stickToBottom()
    measureAskCardRef.current()
  }, [stickToBottom])

  // 新询问露面：人本来就在底部就把卡片露出来（列表没有 followOutput，末尾长高不会自己跟）；人在往上翻历史就不打扰，
  // 由下面那枚提示告诉他。步进到另一张、前一张答完换下一张同样算露面
  const activeAsk = useChatStore(selectActivePendingInput)
  const activeAskId = activeAsk?.id
  const atBottomRef = useRef(atBottom)
  useEffect(() => {
    // 日历跳到中间时 atBottom 还是初值 true：在初始定位过去之前不能算「人在底部」，否则会把跳转拉回底部
    atBottomRef.current = atBottom && (startsAtBottom || settled)
  }, [atBottom, startsAtBottom, settled])
  // 卡片是否露着（「等你批准」提示看它，不看 atBottom：离底 160px 之内也算在底部，那时卡片已经大半压在输入卡片底下）
  const [askCardVisible, setAskCardVisible] = useState(true)
  const measureAskCard = useCallback(() => {
    const scroller = scrollerRef.current
    const card = scroller?.querySelector<HTMLElement>('[data-pending-card]')
    if (!scroller || !card || revealAskRef.current) {
      setAskCardVisible(true)
      return
    }
    // 卡片比可见区还高（窗口很矮）时到底了也露不全：已经到底就别再提示，点了也没处可去
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2
    setAskCardVisible(atEnd || pendingCardOnScreen(card))
  }, [])
  useEffect(() => {
    measureAskCardRef.current = measureAskCard
  }, [measureAskCard])
  useEffect(() => {
    if (activeAskId === undefined) return
    const scroller = scrollerRef.current
    const listeners = new AbortController()
    const release = (): void => {
      revealAskRef.current = false
    }
    let done: ReturnType<typeof setTimeout> | undefined
    if (atBottomRef.current) {
      revealAskRef.current = true
      stickToBottom()
      done = setTimeout(() => {
        release()
        measureAskCard()
      }, REVEAL_ASK_MS)
      // 人一动就松开，别把正往上翻的人拉回去（同落地后的跟随）
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        scroller?.addEventListener(type, release, { passive: true, signal: listeners.signal })
      }
    }
    scroller?.addEventListener('scroll', measureAskCard, {
      passive: true,
      signal: listeners.signal
    })
    const frame = requestAnimationFrame(measureAskCard)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(done)
      listeners.abort()
      release()
    }
  }, [activeAskId, stickToBottom, measureAskCard])

  // 排队气泡露面（运行中发出一条，列表末尾多一条占位气泡）：同新询问 —— 人在底部就跟到底（刚发的那句与它下面的
  // 询问卡片都还露着），人在翻历史就不动。只看变多：放下 / 撤回让末尾变矮，不需要跟
  const queuedCount = useMemo(
    () => items.reduce((count, item) => count + (item.queued ? 1 : 0), 0),
    [items]
  )
  const prevQueuedCount = useRef(queuedCount)
  useEffect(() => {
    const grew = queuedCount > prevQueuedCount.current
    prevQueuedCount.current = queuedCount
    if (!grew || !atBottomRef.current) return
    const scroller = scrollerRef.current
    const listeners = new AbortController()
    const release = (): void => {
      revealAskRef.current = false
    }
    revealAskRef.current = true
    stickToBottom()
    const done = setTimeout(() => {
      release()
      measureAskCard()
    }, REVEAL_ASK_MS)
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      scroller?.addEventListener(type, release, { passive: true, signal: listeners.signal })
    }
    return () => {
      clearTimeout(done)
      listeners.abort()
      release()
    }
  }, [queuedCount, stickToBottom, measureAskCard])

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

  // 滚动条宽度：内容溢出后才出现（滚动条样式化后不再是浮层，要占布局宽度 —— 对话列是 10px，见 base.css）。
  // 它出现 / 消失时滚动容器的内容区变窄 / 变宽，上面那个 ResizeObserver 正好察觉
  const scrollbarWidthRef = useRef(0)
  const reportScrollbarWidth = useCallback(
    (px: number) => {
      if (px === scrollbarWidthRef.current) return
      scrollbarWidthRef.current = px
      onScrollbarWidthChange(px)
    },
    [onScrollbarWidthChange]
  )
  useEffect(() => () => reportScrollbarWidth(0), [reportScrollbarWidth])

  const handleScrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      scrollerRef.current = el instanceof HTMLElement ? el : null
      listenersRef.current?.abort()
      listenersRef.current = null
      resizeRef.current?.disconnect()
      resizeRef.current = null
      const scroller = scrollerRef.current
      if (!scroller) return
      const measureScrollbar = (): void =>
        reportScrollbarWidth(scroller.offsetWidth - scroller.clientWidth)
      measureScrollbar()
      if (typeof ResizeObserver !== 'undefined') {
        let prevHeight = scroller.clientHeight
        const observer = new ResizeObserver(() => {
          measureScrollbar()
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
          checkLanded()
        },
        options
      )
      listenersRef.current = listeners
    },
    [unpin, stickToBottom, reportScrollbarWidth, checkLanded]
  )
  // 翻到顶：初始定位落了地才算，接上一段之后还在顶部就接着取，直到上面没有可取的。只看 settled 不够：Virtuoso 挂上的
  // 那一刻条目还没画出来，滚动区就一屏高、scrollTop 0，它同时报「在顶部」与「在底部」（settled 随之成立），跳到底之后的
  // 「不在顶部」又节流在 50ms 之后 —— 只看这两个值，一打开长会话就会去取。所以要等量到贴底（landed：条目上了屏，短到一屏
  // 放得下的会话此刻就在顶上；日历跳到中间的不等），再按滚动区此刻的位置核一遍「在顶部」
  const [atTop, setAtTop] = useState(false)
  const positioned = landed || !startsAtBottom
  useEffect(() => {
    if (!atTop || !settled || !positioned) return
    const el = scrollerRef.current
    if (el && el.scrollTop > AT_TOP_THRESHOLD) return
    onReachTop?.()
  }, [atTop, settled, positioned, onReachTop])
  // 接上了一段：把眼前那一项摆回接上之前的位置，一直摆到高度量完（连着几帧不再动），人一动就松手。
  // 每一帧画完才量（rAF 里排 setTimeout(0)）：接上的项量到真高时 Virtuoso 自己也会补滚动位置，在同一帧里先量先补，
  // 就会和它补两遍（实测闪过一帧 −3000px）；画完再量，量到的是它补完之后真正画出来的位置，只补它没补齐的那一截
  useLayoutEffect(() => {
    const before = prependedRef.current
    prependedRef.current = prependedCount
    const anchor = prependAnchor.current
    prependAnchor.current = null
    const scroller = scrollerRef.current
    if (prependedCount <= before || !anchor || !scroller) return
    const index = prependedCount
    let frames = 0
    let still = 0
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const listeners = new AbortController()
    restoring.current = anchor
    const next = (): void => {
      raf = requestAnimationFrame(() => {
        timer = setTimeout(settle, 0)
      })
    }
    // 接上的项画出来、量到真高的那一帧：Virtuoso 的尺寸观察把报告推到下一帧的 rAF 里才补滚动位置，这一帧会照原样画出来
    // （实测有一帧连分隔线都不在屏上）。自己观察列表的高度，在这一帧画之前就摆正；Virtuoso 下一帧的 rAF 里再补一遍时，
    // 紧跟着（同一帧、排在它后面的 rAF）再摆一次，把它补多的那一截抵掉
    let followRaf = 0
    // 眼前那一项正上方的那一项（新接上的这一段的最后一项）：Virtuoso 量到真高的那一帧可能没画眼前那一项，
    // 它的位置就是这一项的下沿
    const aboveId = itemsRef.current[prependedCount - 1]?.msg.id
    const topOfAnchor = (): number | null => {
      const found = scroller.querySelector<HTMLElement>(
        `[data-msg-id=${JSON.stringify(anchor.id)}]`
      )
      const node = found?.closest<HTMLElement>('[data-index]') ?? found
      if (node) return node.getBoundingClientRect().top
      if (aboveId === undefined) return null
      const above = scroller
        .querySelector<HTMLElement>(`[data-msg-id=${JSON.stringify(aboveId)}]`)
        ?.closest<HTMLElement>('[data-index]')
      return above ? above.getBoundingClientRect().bottom : null
    }
    const correct = (): number => {
      const top = topOfAnchor()
      if (top === null) return Number.NaN
      const delta = top - scroller.getBoundingClientRect().top - anchor.offset
      if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
      return delta
    }
    const list = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
    const observer =
      list && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            correct()
            cancelAnimationFrame(followRaf)
            followRaf = requestAnimationFrame(() => {
              correct()
            })
          })
        : null
    if (list) observer?.observe(list)
    const stop = (): void => {
      cancelAnimationFrame(raf)
      cancelAnimationFrame(followRaf)
      clearTimeout(timer)
      observer?.disconnect()
      listeners.abort()
      if (restoring.current === anchor) restoring.current = null
    }
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      scroller.addEventListener(type, stop, { passive: true, signal: listeners.signal })
    }
    const settle = (): void => {
      const delta = correct()
      if (!Number.isNaN(delta)) {
        if (Math.abs(delta) > 0.5) still = 0
        else still++
      } else {
        // 被顶出了渲染范围：先让 Virtuoso 把它滚回来，下一帧再量
        virtuosoRef.current?.scrollToIndex({ index, align: 'start', offset: -anchor.offset })
        still = 0
      }
      frames++
      if (still >= PREPEND_SETTLE_FRAMES || frames >= PREPEND_MAX_FRAMES) {
        stop()
        return
      }
      next()
    }
    next()
    return stop
  }, [prependedCount])
  const firstItemIndex = FIRST_ITEM_BASE - prependedCount
  // Virtuoso 交给 itemContent 的下标带着 firstItemIndex；外面按当前上下文里的下标认。压缩前的历史只读：
  // 提议卡片没有会话上下文就只读（不能拿一组旧提议去「采纳」）
  const itemContent = useCallback(
    (index: number, item: VisibleItem) => {
      const dataIndex = index - firstItemIndex
      if (dataIndex < prependedCount) {
        return (
          <SuggestionContext.Provider value={null}>
            {renderItem(-1, item, true)}
          </SuggestionContext.Provider>
        )
      }
      return renderItem(dataIndex - prependedCount, item, false)
    },
    [renderItem, firstItemIndex, prependedCount]
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
        firstItemIndex={firstItemIndex}
        itemContent={itemContent}
        components={LIST_COMPONENTS}
        context={listContext}
        initialTopMostItemIndex={initial.location}
        increaseViewportBy={{ top: 200, bottom: 400 }}
        computeItemKey={(_index, item) => item.key}
        scrollerRef={handleScrollerRef}
        atBottomThreshold={AT_BOTTOM_THRESHOLD}
        atBottomStateChange={handleAtBottomChange}
        atTopThreshold={AT_TOP_THRESHOLD}
        skipAnimationFrameInResizeObserver
        atTopStateChange={setAtTop}
        totalListHeightChanged={handleTotalHeightChange}
      />
      {/* 排在输入卡片之前：卡片向上展开的浮层要盖住它（见 ScrollToBottomButton） */}
      <ScrollToBottomButton
        visible={settled && (activeAsk ? !askCardVisible : !atBottom)}
        running={running}
        waiting={activeAsk?.kind ?? null}
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
  // 运行中发出、还排着等边界的输入：画成列表末尾的占位气泡（可撤回）
  const queue = useChatStore(selectSessionQueueItems)
  // 悬浮输入卡片高度 → 根容器 CSS 变量（列表 Footer / 空态 padding 引用），避免卡片遮住末尾内容。
  // 直接写 DOM 变量而非 state：高度随输入增长高频变化，不触发列表重渲染
  const rootRef = useRef<HTMLDivElement>(null)
  const handleInputHeightChange = useCallback((h: number) => {
    const root = rootRef.current
    if (!root) return
    // 询问卡片本来整张露着，输入卡片长高（打字）：列表跟着上移，别盖住它。卡片没露全时不动，
    // 不替翻历史的人挪位置。要在写新值之前量：用的是长高之前盖住的那一截
    const card = root.querySelector<HTMLElement>('[data-pending-card]')
    const grew = h - (parseFloat(root.style.getPropertyValue('--chat-input-h')) || 0)
    const keepCard = !!card && grew > 0 && pendingCardOnScreen(card)
    root.style.setProperty('--chat-input-h', `${h}px`)
    if (keepCard) {
      const scroller = card.closest<HTMLElement>('[data-virtuoso-scroller]')
      if (scroller) scroller.scrollTop += grew
    }
  }, [])
  // 列表滚动条宽度 → --chat-scrollbar-w：输入卡片与「回到底部」按钮在右侧让出这一条（见 MessageList）
  const handleScrollbarWidthChange = useCallback((w: number) => {
    rootRef.current?.style.setProperty('--chat-scrollbar-w', `${w}px`)
  }, [])

  const chatHost = useChatHost()
  const focusMode = chatHost.appearance.focusMode
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
  // 从某条回复分支出新会话：宿主能 fork、这个窗口能切去别的会话（悬浮窗 / md 窗口不能）、这条会话的形态给
  // 且此刻空闲 —— 在跑时不给（拷贝要等它停下，旧卡上的按钮点了也只会被拒）
  const {
    available: forkAvailable,
    forkSession,
    forkError,
    clearForkError
  } = useSessionFork(chatHost.openSession)
  const forkable = useChatStore((s) => selectSessionForkable(s, sessionId))
  const handleFork = useCallback(
    (assistantMsgId: string) => void forkSession(sessionId, assistantMsgId),
    [forkSession, sessionId]
  )
  const onFork = forkAvailable && chatHost.openSession && forkable ? handleFork : undefined

  // 预构建可见消息列表，messages 不变时复用缓存。视图只有活上下文：压缩掉的历史原地换成一行压缩摘要
  const visibleItems = useMemo(
    () => buildVisibleItems(messages, isStreaming, pendingPrompt, queue),
    [messages, isStreaming, pendingPrompt, queue]
  )

  // 「新内容」分隔线（docs/inbox-read-state-design.md §7）：这次打开时它是未读的，就在那一轮开跑之后的第一项前画一条；
  // 锚点是切进来那一刻记下的（打开即已读，未读随即没了），离开这条会话就不再画
  const newContentAt = useUnreadStore((s) => (s.mark?.sessionId === sessionId ? s.mark.at : null))
  const dividerIndex = useMemo(
    () => newContentIndex(visibleItems, newContentAt),
    [visibleItems, newContentAt]
  )
  // 每组提议开着还是关了、采纳的是哪一条：按整条消息列表算（之后用户说了别的话就关），卡片从 context 里取。
  // 接上来的压缩前历史不在这里：那些卡片拿到的是空的上下文，一律只读（见 MessageList）
  const suggestionContext = useMemo(
    () => ({ sessionId, states: suggestionStatesOf(messages) }),
    [sessionId, messages]
  )
  // 列表与空态都等这条会话的视图到了再画（历史久久没上屏就出进度条，见 ViewLoadGate）。视图到达之前 messages 是空的，
  // 这个「空」不说明任何事：画空态，每次打开有记录的会话都会先闪一下空态（桌面是整张会话设置面板）。
  // 也可能已经有东西要画：运行中的会话退订时留下「还在跑」的余项（isStreaming，见 releaseSessionView），
  // 切回来就是一张孤零零的流式占位卡。那时挂上列表，初始定位落在这一项上；等真消息到了，初始定位早已用掉，
  // 列表就停在会话开头。
  // 乐观占位例外：那是刚建、还没有历史的会话，没有「底部」可找，刚发出的那句话也不能等后端
  const viewLoaded = useChatStore((s) => s.sessionViews[sessionId] !== undefined)
  const listReady = viewLoaded || !!pendingPrompt
  // 订阅失败不重试（useSessionView），视图不会来了：不能让进度条一直走下去
  const viewFailed = useChatStore((s) => !!s.sessionViewFailed[sessionId])
  // 空态只在**真的什么都没有**时才顶上：乐观占位也算内容 —— 漏掉它，「新会话第一条消息」
  // 与「只有一轮时点重新生成」这两条路上，刚发出的那句话会被整片空态盖住（回退清空了
  // messages，而这两条路上流式态都没开着），正是占位要解决的那个毛病
  const isEmpty = messages.length === 0 && !isStreaming && !pendingPrompt && !hasPendingInputs
  // 有没有历史要等，进度条只为它出现。视图到了看消息；视图没到只能看别的：正发着第一句话（乐观占位）是刚建的会话，
  // 会话行的 lastActiveAt 还停在建行那一刻则是没发过消息，等来的也是空态。fork、内存会话、Chrome 标签页会话
  // 有历史也可能停在那一刻：这几种视图迟到时是一段没有进度条的空白
  const neverUsed = useChatStore((s) => {
    const row = s.sessions.find((session) => session.id === sessionId)
    return row !== undefined && row.lastActiveAt === row.createdAt
  })
  const awaitsHistory = viewLoaded
    ? messages.length > 0
    : !pendingPrompt && !viewFailed && !neverUsed
  // 仅当最后一条消息是助手消息时才允许重新生成
  const lastAssistantId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last && isAssistantMessage(last) ? last.id : null
  }, [messages])

  // 日历点进某天的跳转请求（只取本会话的）；执行在 MessageList 里，那里知道初始定位落地了没有
  const scrollRequest = useChatStore((s) =>
    s.scrollToMessageRequest?.sessionId === sessionId ? s.scrollToMessageRequest : null
  )

  /** 渲染单条可见消息。接上来的压缩前历史只读：不给回退 / 重新生成 / 分支，也不画「新内容」分隔线 */
  const renderItem = useCallback(
    (index: number, item: VisibleItem, compactedItem: boolean) => {
      const message = compactedItem ? (
        <MessageRenderer item={item} lastAssistantId={null} />
      ) : (
        <MessageRenderer
          item={item}
          lastAssistantId={lastAssistantId}
          onRollback={onRollback}
          onRegenerate={onRegenerate}
          onFork={onFork}
        />
      )
      // 接上来的压缩前历史以 index -1 进来：dividerIndex 也是 -1（不画分隔线）时不能把它们当成那一项
      if (compactedItem || index !== dividerIndex || newContentAt === null) return message
      return (
        <>
          <NewContentDivider at={newContentAt} />
          {message}
        </>
      )
    },
    [lastAssistantId, onRollback, onRegenerate, onFork, dividerIndex, newContentAt]
  )

  return (
    <>
      {/* 对话列 relative 锚点：悬浮输入卡片绝对贴底定位于此（与笔记本会话同构） */}
      <div ref={rootRef} className="relative flex-1 min-h-0 flex flex-col">
        <ViewLoadGate
          key={sessionId}
          dataReady={listReady || viewFailed}
          awaitsHistory={awaitsHistory}
        >
          {(onPainted) =>
            !listReady ? (
              <div
                data-conversation-load-failed
                className="flex-1 min-h-0 flex items-center justify-center px-6"
                style={{ paddingBottom: 'var(--chat-input-h, 0px)' }}
              >
                <p className="text-sm text-text-tertiary">{t('chat.historyLoadFailed')}</p>
              </div>
            ) : isEmpty ? (
              // 空态同样按输入卡片高度留白，避免居中内容被悬浮卡片遮挡
              <div
                data-conversation-empty
                className="flex-1 min-h-0 flex flex-col"
                style={{ paddingBottom: 'var(--chat-input-h, 0px)' }}
              >
                {emptyState ?? (
                  <div className="flex-1 flex items-center justify-center px-6">
                    <p className="text-sm text-text-tertiary">{t('chat.emptyHint')}</p>
                  </div>
                )}
              </div>
            ) : (
              // 按会话重挂：初始定位只在挂载那一刻生效，「在不在底部」的状态也只属于这一份列表
              <SuggestionContext.Provider value={suggestionContext}>
                <MessageList
                  key={sessionId}
                  sessionId={sessionId}
                  messages={messages}
                  items={visibleItems}
                  renderItem={renderItem}
                  running={isStreaming}
                  scrollRequest={scrollRequest}
                  onScrollbarWidthChange={handleScrollbarWidthChange}
                  onLanded={onPainted}
                  onInputResponse={handleInputResponse}
                />
              </SuggestionContext.Provider>
            )
          }
        </ViewLoadGate>

        {/* 输入区（悬浮卡片）。待处理用户输入在列表末尾（ConversationFooter），这里只发消息。
            卡片最顶格是目标栏（会话有目标时；裁决 D8：常驻在输入框上方，不随对话滚动），宿主的插槽排在它下面 */}
        <div
          className={`transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100 focus-within:opacity-100' : ''}`}
        >
          <InputArea thread={inputTop} onHeightChange={handleInputHeightChange} />
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

      {/* fork 被拒的说明（fork 不毁任何东西，所以事前不确认，只在没做成时说一声） */}
      {forkError && (
        <ConfirmDialog
          title={t('chat.forkFailedTitle')}
          description={t(forkRefusalKey(forkError))}
          confirmText={t('common.close')}
          danger={false}
          onConfirm={clearForkError}
          onCancel={clearForkError}
        />
      )}
    </>
  )
}
