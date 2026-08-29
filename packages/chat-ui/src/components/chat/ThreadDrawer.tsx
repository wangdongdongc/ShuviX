/**
 * ThreadDrawer — 笔记本会话的「对话抽屉」：输入框卡片内部的第一格（InputArea 的 thread 插槽），
 * 把主会话对话流渲染成一块限高、可折叠的面板 —— 笔记本以 markdown live-preview 为主界面，
 * 对话是输入框的延伸，不占满屏。
 *
 * 形态与 PendingInputsPanel / QueuePanel 同源：渲染进输入框卡片内部，自身无边框/底色/阴影，
 * 只用一条 border-b 与下方分隔；顶部圆角由本组件承担（它是卡片首格，位于待处理输入之上）。
 * 默认折叠成一条细摘要条（计数 + 运行状态/末条摘要）；展开限高滚动。
 *
 * 数据与普通会话完全同源：chatStore.messages + buildVisibleItems + MessageRenderer ——
 * 同一棵会话树、同一投影、同一渲染件，抽屉只是另一个滚动容器。刻意不用 Virtuoso：
 * 压缩使可见消息列表天然有界，普通滚动即可（外层永不限高、叶子自己限高的滚动契约见
 * detailViewport.ts —— 本面板就是那个「自己限高自己滚」的叶子）。
 *
 * 展开态按会话记忆（chatStore.sessionThreadOpen），由活动的**沿**驱动：流式开始自动展开；
 * 待审批出现与**一轮结束**自动折叠 —— 询问卡需要纵向空间（两块限高区同时展开会吃满整屏，
 * 询问区自己的折叠开关见 PendingInputsDrawer），轮结束后则回到以笔记为主的形态；
 * 询问清空且仍在流式时再展回。手动开合在下一个沿之前始终生效。
 * 无历史且未运行时整体隐藏（细条也不占高度）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Loader2, MessagesSquare } from 'lucide-react'
import {
  useChatStore,
  selectIsStreaming,
  selectPendingInputs,
  selectStreamingContent,
  selectStreamingThinking,
  type ChatMessage,
  type AssistantMessage
} from '../../stores/chatStore'
import { useChatActions } from '../../hooks/useChatActions'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { MessageRenderer } from './MessageRenderer'
import { StreamingFooter } from './StreamingFooter'
import { buildVisibleItems } from './Conversation'

/** 助手消息（与 Conversation 同口径） */
function isAssistantMessage(msg: ChatMessage): msg is AssistantMessage {
  return msg.role === 'assistant' && msg.type === 'message'
}

/** 折叠细条的末条摘要：最近一条有正文的助手消息的首行 */
function lastAssistantSnippet(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isAssistantMessage(m) && m.content.trim()) {
      return m.content.trim().split('\n')[0]
    }
  }
  return ''
}

export function ThreadDrawer({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore(selectIsStreaming)
  const hasPending = useChatStore((s) => selectPendingInputs(s).length > 0)
  // 流式正文/思考长度：只为「跟底」效果订阅增长节拍（rAF 批量后每次 flush 触发一次），不持有文本
  const streamLen = useChatStore(
    (s) => selectStreamingContent(s).length + selectStreamingThinking(s).length
  )
  const open = useChatStore((s) => s.sessionThreadOpen[sessionId] ?? false)
  const setThreadOpen = useChatStore((s) => s.setThreadOpen)

  const { handleRollback, pendingRollbackId, confirmRollback, cancelRollback, handleRegenerate } =
    useChatActions(sessionId)

  // 沿驱动开合：流式开始（且无待审批）→ 展开；待审批出现 / 一轮结束 → 折叠
  // （给询问卡让位；轮结束回到以笔记为主）；询问清空且仍在流式 → 展回。
  // 折叠沿优先于展开沿（中止时 pendingFell 与 streamFell 同拍，不该展）。
  // 手动开合在下一个沿之前始终生效。
  const prevStreamingRef = useRef(isStreaming)
  const prevPendingRef = useRef(hasPending)
  useEffect(() => {
    const streamRose = !prevStreamingRef.current && isStreaming
    const streamFell = prevStreamingRef.current && !isStreaming
    const pendingRose = !prevPendingRef.current && hasPending
    const pendingFell = prevPendingRef.current && !hasPending
    prevStreamingRef.current = isStreaming
    prevPendingRef.current = hasPending
    if (pendingRose || streamFell) setThreadOpen(sessionId, false)
    else if (streamRose && !hasPending) setThreadOpen(sessionId, true)
    else if (pendingFell && isStreaming) setThreadOpen(sessionId, true)
  }, [isStreaming, hasPending, sessionId, setThreadOpen])

  const visibleItems = useMemo(
    () => buildVisibleItems(messages, isStreaming),
    [messages, isStreaming]
  )
  // 仅当最后一条消息是助手消息时才允许重新生成（与 Conversation 同口径）
  const lastAssistantId = useMemo(() => {
    const last = messages[messages.length - 1]
    return last && isAssistantMessage(last) ? last.id : null
  }, [messages])

  const scrollerRef = useRef<HTMLDivElement>(null)
  // 展开瞬间滚到底（历史从末尾看起）
  useLayoutEffect(() => {
    if (!open) return
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [open])
  // 流式期间自动跟随最新输出；结束后不再打扰用户的滚动位置
  useEffect(() => {
    if (!open || !isStreaming) return
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [open, isStreaming, messages, streamLen])

  // 无历史且未运行：整体隐藏（首次发送的流式上升沿会让它带着自动展开出现）
  if (messages.length === 0 && !isStreaming) return null

  const snippet = lastAssistantSnippet(messages)

  return (
    <>
      <div className="rounded-t-2xl border-b border-border-secondary/40">
        {/* 细条：计数 + 运行状态/末条摘要；点任意处折叠/展开 */}
        <button
          type="button"
          onClick={() => setThreadOpen(sessionId, !open)}
          className="w-full flex items-center gap-2 px-3.5 py-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
          title={open ? t('threadDrawer.collapse') : t('threadDrawer.expand')}
        >
          <MessagesSquare size={12} className="flex-shrink-0" />
          <span className="flex-1 min-w-0 truncate text-left">
            {isStreaming ? (
              <span className="inline-flex items-center gap-1 text-accent">
                <Loader2 size={10} className="animate-spin" />
                {t('threadDrawer.running')}
              </span>
            ) : (
              snippet
            )}
          </span>
          {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>

        {/* 展开：限高滚动的对话流（与 Conversation 同一渲染件）。上限刻意保守 ——
            live preview 是主界面，对话是输入框的延伸；与询问区（40vh 级）叠放也不吃满屏 */}
        {open && (
          <div
            ref={scrollerRef}
            className="max-h-[22vh] overflow-y-auto overscroll-contain thin-scrollbar px-2 pb-2"
          >
            {visibleItems.map((item) => (
              <MessageRenderer
                key={item.key}
                item={item}
                lastAssistantId={lastAssistantId}
                onRollback={handleRollback}
                onRegenerate={handleRegenerate}
              />
            ))}
            <StreamingFooter />
          </div>
        )}
      </div>

      {/* 回退确认弹窗（与 Conversation 同构） */}
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
