import { getSessionChannelApi, useChatHost } from '@shuvix/chat-ui'
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Archive } from 'lucide-react'
import {
  useChatStore,
  selectIsStreaming,
  selectCanChat,
  selectCanEdit,
  type ChatMessage,
  type AssistantTextMessage
} from '../../stores/chatStore'
import { useChatActions } from '../../hooks/useChatActions'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { MessageRenderer, type VisibleItem } from './MessageRenderer'
import { StreamingFooter } from './StreamingFooter'
import { PendingInputsPanel } from './PendingInputsPanel'
import { InputArea } from './InputArea'

/** Virtuoso Footer：流式指示器 + 底部留白（高度 = 悬浮输入卡片实高，经 --chat-input-h 变量传递） */
function ConversationFooter(): React.JSX.Element {
  return (
    <>
      <StreamingFooter />
      <div aria-hidden style={{ height: 'var(--chat-input-h, 0px)' }} />
    </>
  )
}

/** 判断消息是否为中间步骤/工具项 */
function isStepOrToolMsg(msg: ChatMessage): boolean {
  return (
    msg.type === 'tool_use' ||
    msg.type === 'step_text' ||
    msg.type === 'step_thinking' ||
    msg.type === 'steer'
  )
}

/**
 * 预处理消息列表：将 step/tool 消息合并到后续的 assistant text 消息中
 * 流式时在末尾追加合成占位项，由 AssistantBubble 自行从 store 读取流式状态
 */
function buildVisibleItems(messages: ChatMessage[], isStreaming: boolean): VisibleItem[] {
  const items: VisibleItem[] = []
  const stepBuffer: VisibleItem[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    // 跳过 system_notify（但保留 error_event）
    if (msg.role === 'system_notify' && msg.type !== 'error_event') continue

    // step/tool 消息 → 收集到 buffer
    if (isStepOrToolMsg(msg)) {
      stepBuffer.push({ msg })
      continue
    }

    // 非 step/tool 消息：先 flush buffer
    if (msg.role === 'assistant' && msg.type === 'text') {
      // assistant text → 将 buffer 中的 steps 附加到这条消息
      items.push({ msg, steps: stepBuffer.length > 0 ? [...stepBuffer] : undefined })
      stepBuffer.length = 0
      continue
    }

    // user text / error_event 等
    // 如果有未消费的 steps（如 agent 中断），先创建一个空 assistant bubble 承载它们
    if (stepBuffer.length > 0) {
      const syntheticMsg: AssistantTextMessage = {
        id: `orphan-${stepBuffer[0].msg.id}`,
        sessionId: msg.sessionId,
        role: 'assistant',
        type: 'text',
        content: '',
        metadata: null,
        model: stepBuffer[0].msg.model || '',
        createdAt: stepBuffer[0].msg.createdAt
      }
      items.push({ msg: syntheticMsg, steps: [...stepBuffer] })
      stepBuffer.length = 0
    }
    items.push({ msg })
  }

  // 尾部残留 steps
  if (stepBuffer.length > 0) {
    if (isStreaming) {
      // 流式中：将残留 steps 挂载到合成流式占位项
      const sessionId = stepBuffer[0].msg.sessionId
      const syntheticMsg: AssistantTextMessage = {
        id: 'streaming-live',
        sessionId,
        role: 'assistant',
        type: 'text',
        content: '',
        metadata: null,
        model: '',
        createdAt: Date.now()
      }
      items.push({ msg: syntheticMsg, steps: [...stepBuffer], isStreamingPlaceholder: true })
    } else {
      // 非流式：创建 orphan bubble
      const syntheticMsg: AssistantTextMessage = {
        id: `orphan-${stepBuffer[0].msg.id}`,
        sessionId: stepBuffer[0].msg.sessionId,
        role: 'assistant',
        type: 'text',
        content: '',
        metadata: null,
        model: stepBuffer[0].msg.model || '',
        createdAt: stepBuffer[0].msg.createdAt
      }
      items.push({ msg: syntheticMsg, steps: [...stepBuffer] })
    }
    stepBuffer.length = 0
  } else if (isStreaming) {
    // 流式中无残留 steps 时也追加空合成项（承载流式 content/thinking/toolCall）
    const lastMsg = messages[messages.length - 1]
    const sessionId = lastMsg?.sessionId || ''
    const syntheticMsg: AssistantTextMessage = {
      id: 'streaming-live',
      sessionId,
      role: 'assistant',
      type: 'text',
      content: '',
      metadata: null,
      model: '',
      createdAt: Date.now()
    }
    items.push({ msg: syntheticMsg, isStreamingPlaceholder: true })
  }

  return items
}

/**
 * 对话区核心 —— 消息列表（虚拟滚动 + 归档回溯）+ 待处理输入 + 输入区。
 *
 * 这是可复用的"中间对话框"本体：只依赖 chatStore / ChatApi / ChatHost，
 * 不含标题栏、侧边栏/浏览器开关、会话配置等宿主外壳 chrome（那些在 ChatView 里）。
 */
export function Conversation({
  sessionId,
  emptyState
}: {
  sessionId: string
  /** 会话无消息时的占位（宿主可注入，如桌面的会话配置面板）；缺省为简单提示文案 */
  emptyState?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore(selectIsStreaming)
  const canChat = useChatStore(selectCanChat)
  const canEdit = useChatStore(selectCanEdit)
  // 仅查看（WebUI 分享端）：消息「内容」限宽居中，但滚动条仍贴屏幕右缘（不随内容内移）。
  // 故只把 Virtuoso 的内层 List 容器（含 header/items/footer）限宽居中，外层 Scroller 保持满宽。
  const viewOnly = useChatStore((s) => s.viewOnly)
  const CenteredList = useMemo(
    () =>
      viewOnly
        ? forwardRef<HTMLDivElement, { style?: React.CSSProperties; children?: React.ReactNode }>(
            function CenteredList({ style, children }, ref) {
              return (
                <div ref={ref} style={style} className="mx-auto w-full max-w-3xl">
                  {children}
                </div>
              )
            }
          )
        : undefined,
    [viewOnly]
  )
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // 悬浮输入卡片高度 → 根容器 CSS 变量（列表 Footer / 空态 padding 引用），避免卡片遮住末尾内容。
  // 直接写 DOM 变量而非 state：高度随输入增长高频变化，不触发列表重渲染
  const rootRef = useRef<HTMLDivElement>(null)
  const handleInputHeightChange = useCallback((h: number) => {
    rootRef.current?.style.setProperty('--chat-input-h', `${h}px`)
  }, [])

  const focusMode = useChatHost().appearance.focusMode
  const dim = focusMode

  const {
    handleRollback,
    pendingRollbackId,
    confirmRollback,
    cancelRollback,
    handleRegenerate,
    handleInputResponse
  } = useChatActions(sessionId)

  // ── 归档消息回溯 ──
  const [archivedCount, setArchivedCount] = useState(0)
  const [archivedItems, setArchivedItems] = useState<VisibleItem[]>([])
  const [archivedOffset, setArchivedOffset] = useState(0)
  const [archivedLoading, setArchivedLoading] = useState(false)
  const hasMoreArchived = archivedOffset < archivedCount

  // ── 归档消息：会话切换时重置并获取归档数 ──
  useEffect(() => {
    setArchivedItems([])
    setArchivedOffset(0)
    setArchivedCount(0)
    if (!sessionId) return
    getSessionChannelApi()
      .message.countArchived(sessionId)
      .then((cnt) => setArchivedCount(cnt))
  }, [sessionId])

  /** 加载更多归档消息（每次 5 条主消息） */
  const loadMoreArchived = useCallback(async () => {
    if (!sessionId || archivedLoading || !hasMoreArchived) return
    setArchivedLoading(true)
    try {
      const batch = await getSessionChannelApi().message.listArchived({
        sessionId,
        limit: 5,
        offset: archivedOffset
      })
      if (batch.length > 0) {
        const batchItems = buildVisibleItems(batch, false).map((item) => ({
          ...item,
          isArchived: true
        }))
        // 新加载的是更早的消息，需要放在已有归档项之前
        setArchivedItems((prev) => [...batchItems, ...prev])
        setArchivedOffset((prev) => prev + 5)
      }
    } finally {
      setArchivedLoading(false)
    }
  }, [sessionId, archivedLoading, hasMoreArchived, archivedOffset])

  // 预构建可见消息列表，messages 不变时复用缓存
  const liveItems = useMemo(() => buildVisibleItems(messages, isStreaming), [messages, isStreaming])
  // 合并：归档项在前，活跃项在后
  const visibleItems = useMemo(
    () => (archivedItems.length > 0 ? [...archivedItems, ...liveItems] : liveItems),
    [archivedItems, liveItems]
  )
  // 仅当最后一条消息是助手文本消息时才允许重新生成
  const lastAssistantTextId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last?.role === 'assistant' && last?.type === 'text' ? last.id : null
  }, [messages])

  /** 渲染单条可见消息 */
  const renderItem = useCallback(
    (_index: number, item: VisibleItem) => {
      if (item.isArchived) {
        return (
          <div className="opacity-45">
            <MessageRenderer
              item={item}
              lastAssistantTextId={null}
              onRollback={undefined}
              onRegenerate={undefined}
            />
          </div>
        )
      }
      return (
        <MessageRenderer
          item={item}
          lastAssistantTextId={lastAssistantTextId}
          onRollback={canEdit ? handleRollback : undefined}
          onRegenerate={canEdit ? handleRegenerate : undefined}
        />
      )
    },
    [lastAssistantTextId, handleRollback, handleRegenerate, canEdit]
  )

  /** Virtuoso Header：归档消息横幅 */
  const ArchivedBanner = useMemo(() => {
    if (archivedCount === 0) return undefined
    return function ArchivedBannerHeader() {
      if (!hasMoreArchived && archivedItems.length === 0) return null
      return (
        <button
          onClick={loadMoreArchived}
          disabled={archivedLoading || !hasMoreArchived}
          className="w-full flex items-center justify-center gap-2 py-2 px-4 text-xs text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-colors border-b border-border-secondary/40 disabled:opacity-50"
        >
          <Archive size={13} />
          {archivedLoading ? (
            <span>{t('compact.archivedLoading')}</span>
          ) : hasMoreArchived ? (
            <span>{t('compact.archivedBanner', { count: archivedCount - archivedOffset })}</span>
          ) : (
            <span>{t('compact.archivedAllLoaded')}</span>
          )}
        </button>
      )
    }
  }, [
    archivedCount,
    archivedOffset,
    archivedLoading,
    hasMoreArchived,
    archivedItems.length,
    loadMoreArchived,
    t
  ])

  return (
    <>
      {/* 对话列 relative 锚点：悬浮输入卡片绝对贴底定位于此（与笔记本会话同构） */}
      <div ref={rootRef} className="relative flex-1 min-h-0 flex flex-col">
        {messages.length === 0 && !isStreaming ? (
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
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            className="flex-1 min-w-0 thin-scrollbar"
            data={visibleItems}
            itemContent={renderItem}
            components={{
              Footer: ConversationFooter,
              ...(ArchivedBanner ? { Header: ArchivedBanner } : {}),
              ...(CenteredList ? { List: CenteredList } : {})
            }}
            initialTopMostItemIndex={visibleItems.length - 1}
            key={sessionId}
            increaseViewportBy={{ top: 200, bottom: 400 }}
            computeItemKey={(_index, item) => item.msg.id}
          />
        )}

        {/* 输入区（悬浮卡片）+ 待处理用户输入浮层（经 accessory 悬浮于卡片上方）— readonly 隐藏 */}
        {canChat && (
          <div
            className={`transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100 focus-within:opacity-100' : ''}`}
          >
            <InputArea
              accessory={<PendingInputsPanel onResponse={handleInputResponse} />}
              onHeightChange={handleInputHeightChange}
            />
          </div>
        )}
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
