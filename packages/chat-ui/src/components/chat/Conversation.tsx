import { useChatHost } from '@shuvix/chat-ui'
import { useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import {
  useChatStore,
  selectIsStreaming,
  selectPendingInputs,
  type ChatMessage,
  type AssistantMessage
} from '../../stores/chatStore'
import { useChatActions } from '../../hooks/useChatActions'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { MessageRenderer, STREAMING_PLACEHOLDER_ID, type VisibleItem } from './MessageRenderer'
import { StreamingFooter } from './StreamingFooter'
import { BotActivityCards } from './BotActivityCards'
import { PendingInputsPanel } from './PendingInputsPanel'
import { InputArea } from './InputArea'

/** Virtuoso Footer：流式指示器 / bot 在飞占位卡 + 底部留白（高度 = 悬浮输入卡片实高，经 --chat-input-h 变量传递） */
function ConversationFooter(): React.JSX.Element {
  return (
    <>
      <StreamingFooter />
      <BotActivityCards />
      <div aria-hidden style={{ height: 'var(--chat-input-h, 0px)' }} />
    </>
  )
}

/** 助手消息（会话树里一条 assistant entry = 一次 LLM 调用） */
function isAssistantMessage(msg: ChatMessage): msg is AssistantMessage {
  return msg.role === 'assistant' && msg.type === 'message'
}

/** 不含工具块 = 本轮终答，这张卡到此收口（与投影里 toolCalls.length === 0 同义） */
function isFinalAnswer(msg: AssistantMessage): boolean {
  return !msg.blocks.some((b) => b.type === 'tool')
}

/** 流式占位卡：正文/思考/工具调用由 AssistantBubble 自己从 store 读 */
function streamingPlaceholder(sessionId: string): AssistantMessage {
  return {
    id: STREAMING_PLACEHOLDER_ID,
    sessionId,
    role: 'assistant',
    type: 'message',
    blocks: [],
    content: '',
    metadata: null,
    model: '',
    createdAt: 0
  }
}

/**
 * 消息列表 → 对话流的项。
 *
 * 数据侧一条 entry 一条消息；呈现侧把**连续的 assistant 消息**收成一张卡
 * （过程在上、终答在下），遇到终答、用户消息或列表结束即收口。所以轮中 steer /
 * 中途 abort 都只是「这张卡没有终答」，不需要造合成消息去承载它们。
 *
 * 每项的 key 取组首消息 id：流式占位并入已有组时组首不变，本轮结束换成真实终答
 * 也不会让这一项重挂载 —— 展开着的工具卡/思考块因此不会被折回去。
 */
export function buildVisibleItems(messages: ChatMessage[], isStreaming: boolean): VisibleItem[] {
  const items: VisibleItem[] = []
  let group: AssistantMessage[] = []

  const flush = (streamingTail = false): void => {
    if (group.length === 0) return
    items.push({
      key: group[0].id,
      msg: group[group.length - 1],
      msgs: group,
      ...(streamingTail ? { isStreamingPlaceholder: true } : {})
    })
    group = []
  }

  for (const msg of messages) {
    // 跳过 system_notify（但保留 error_event）
    if (msg.role === 'system_notify' && msg.type !== 'error_event') continue

    if (isAssistantMessage(msg)) {
      group.push(msg)
      if (isFinalAnswer(msg)) flush()
      continue
    }

    flush()
    items.push({ key: msg.id, msg })
  }

  if (isStreaming) {
    const sessionId = group[0]?.sessionId || messages[messages.length - 1]?.sessionId || ''
    group.push(streamingPlaceholder(sessionId))
    flush(true)
  } else {
    flush()
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
  const virtuosoRef = useRef<VirtuosoHandle>(null)
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
    handleInputResponse
  } = useChatActions(sessionId)

  // 预构建可见消息列表，messages 不变时复用缓存。
  // 注：被压缩掉的历史不在其中 —— message.list 走 buildContextEntries，自带压缩过滤，
  // 压缩点之前的消息原地换成一张摘要卡片，UI 不提供回看入口。
  const visibleItems = useMemo(
    () => buildVisibleItems(messages, isStreaming),
    [messages, isStreaming]
  )
  // 仅当最后一条消息是助手消息时才允许重新生成
  const lastAssistantId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last && isAssistantMessage(last) ? last.id : null
  }, [messages])

  /** 渲染单条可见消息 */
  const renderItem = useCallback(
    (_index: number, item: VisibleItem) => (
      <MessageRenderer
        item={item}
        lastAssistantId={lastAssistantId}
        onRollback={handleRollback}
        onRegenerate={handleRegenerate}
      />
    ),
    [lastAssistantId, handleRollback, handleRegenerate]
  )

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
            // conversation-scroller：供外壳按需微调本列滚动条（如会话面板展开时内缩轨道，见 base.css）
            // relative z-0：把正文自成一个层叠上下文，正文内的定位元素（时间线头像、代码块按钮…）
            // 不再溢出到悬浮输入卡片之上——卡片在 DOM 中更靠后，始终盖住正文
            className="relative z-0 flex-1 min-w-0 thin-scrollbar conversation-scroller"
            data={visibleItems}
            itemContent={renderItem}
            components={{ Footer: ConversationFooter }}
            initialTopMostItemIndex={visibleItems.length - 1}
            key={sessionId}
            increaseViewportBy={{ top: 200, bottom: 400 }}
            computeItemKey={(_index, item) => item.key}
          />
        )}

        {/* 输入区（悬浮卡片）：待处理用户输入经 accessory 并入卡片顶格，与输入区同一张卡片 */}
        <div
          className={`transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100 focus-within:opacity-100' : ''}`}
        >
          <InputArea
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
