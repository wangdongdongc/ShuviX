import { useTranslation } from 'react-i18next'
import { Container } from 'lucide-react'
import { useChatStore, type ChatMessage } from '../../stores/chatStore'
import { MessageBubble } from './MessageBubble'
import { ToolCallBlock } from './ToolCallBlock'

/** 可见消息项（由 ChatView 预处理后传入） */
export interface VisibleItem {
  msg: ChatMessage
  meta?: any
  pairedCallMeta?: any
}

interface MessageRendererProps {
  item: VisibleItem
  isLastMessage: boolean
  lastAssistantTextId: string | null
  onRollback: (messageId: string) => void
  onRegenerate: (assistantMsgId: string) => void
}

/**
 * 消息渲染器 — 根据消息类型分发渲染
 * 独立组件，替代 ChatView 中的 renderItem useCallback
 */
export function MessageRenderer({
  item,
  isLastMessage,
  lastAssistantTextId,
  onRollback,
  onRegenerate
}: MessageRendererProps): React.JSX.Element {
  const { t } = useTranslation()
  const { msg, meta, pairedCallMeta } = item
  const toolExecutions = useChatStore((s) => s.toolExecutions)

  if (msg.type === 'docker_event') {
    const isCreate = msg.content === 'container_created'
    let containerId = ''
    let reason = ''
    if (msg.metadata) {
      try {
        const meta = JSON.parse(msg.metadata)
        containerId = meta.containerId || ''
        reason = meta.reason || ''
      } catch { /* 忽略 */ }
    }
    return (
      <div className="flex items-center gap-1.5 ml-14 mr-4 my-1 text-[11px] text-text-tertiary">
        <Container size={12} />
        <span>{isCreate ? t('chat.containerCreated') : t('chat.containerDestroyed')}</span>
        {containerId && <span className="font-mono opacity-60">{containerId}</span>}
        {reason && <span className="opacity-50">({t(`chat.destroyReason_${reason}`)})</span>}
      </div>
    )
  }

  if (msg.type === 'tool_call') {
    // 查找实时工具执行状态（流式期间有值，完成后回退到 running）
    const liveExec = toolExecutions.find((te) => te.toolCallId === meta?.toolCallId)
    return (
      <ToolCallBlock
        toolName={meta?.toolName || '未知工具'}
        toolCallId={meta?.toolCallId}
        args={meta?.args}
        status={liveExec?.status || 'running'}
      />
    )
  }

  if (msg.type === 'tool_result') {
    return (
      <ToolCallBlock
        toolName={meta?.toolName || '未知工具'}
        args={pairedCallMeta?.args}
        result={msg.content}
        status={meta?.isError ? 'error' : 'done'}
      />
    )
  }

  return (
    <MessageBubble
      role={msg.role as 'user' | 'assistant' | 'system' | 'tool'}
      content={msg.content}
      metadata={msg.metadata}
      model={msg.model}
      onRollback={!isLastMessage ? () => onRollback(msg.id) : undefined}
      onRegenerate={msg.id === lastAssistantTextId ? () => onRegenerate(msg.id) : undefined}
    />
  )
}
