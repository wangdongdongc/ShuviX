import { useTranslation } from 'react-i18next'
import { Container, AlertCircle, Terminal } from 'lucide-react'
import { useChatStore, selectToolExecutions, type ChatMessage } from '../../stores/chatStore'
import { MessageBubble } from './MessageBubble'
import { ToolCallBlock } from './ToolCallBlock'

/** turn 分组信息（仅工具调用项携带） */
export interface TurnGroupInfo {
  /** 全局 turn 序号（0-based，按消息顺序递增） */
  globalIndex: number
  /** 是否是该 turn 组的第一项 */
  isFirst: boolean
  /** 是否是该 turn 组的最后一项 */
  isLast: boolean
  /** 该 turn 是否会被上下文压缩 */
  willBeCompressed: boolean
  /** 该 turn 组内的工具调用总数 */
  groupSize: number
}

/** 可见消息项（由 ChatView 预处理后传入） */
export interface VisibleItem {
  msg: ChatMessage
  meta?: Record<string, unknown>
  pairedCallMeta?: Record<string, unknown>
  /** turn 分组信息（仅工具调用项携带） */
  turnGroup?: TurnGroupInfo
}

interface MessageRendererProps {
  item: VisibleItem
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
  lastAssistantTextId,
  onRollback,
  onRegenerate
}: MessageRendererProps): React.JSX.Element {
  const { t } = useTranslation()
  const { msg, meta, pairedCallMeta } = item
  const toolExecutions = useChatStore(selectToolExecutions)

  if (msg.type === 'error_event') {
    return (
      <div className="flex items-center gap-1.5 ml-14 mr-4 my-1 text-[11px] text-error/90">
        <AlertCircle size={12} />
        <span className="whitespace-pre-wrap break-words">{msg.content}</span>
      </div>
    )
  }

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

  if (msg.type === 'ssh_event') {
    const isConnect = msg.content === 'ssh_connected'
    let host = ''
    let port = ''
    let username = ''
    if (msg.metadata) {
      try {
        const meta = JSON.parse(msg.metadata)
        host = meta.host || ''
        port = meta.port || ''
        username = meta.username || ''
      } catch { /* 忽略 */ }
    }
    const target = username && host ? `${username}@${host}${port && port !== '22' ? ':' + port : ''}` : ''
    return (
      <div className="flex items-center gap-1.5 ml-14 mr-4 my-1 text-[11px] text-text-tertiary">
        <Terminal size={12} />
        <span>{isConnect ? t('chat.sshConnected') : t('chat.sshDisconnected')}</span>
        {target && <span className="font-mono opacity-60">{target}</span>}
      </div>
    )
  }

  if (msg.type === 'tool_call' || msg.type === 'tool_result') {
    const isCall = msg.type === 'tool_call'
    const liveExec = isCall ? toolExecutions.find((te) => te.toolCallId === meta?.toolCallId) : undefined

    const toolBlock = isCall ? (
      <ToolCallBlock
        toolName={(meta?.toolName as string) || '未知工具'}
        toolCallId={meta?.toolCallId as string | undefined}
        args={meta?.args as Record<string, unknown> | undefined}
        status={liveExec?.status || 'running'}
      />
    ) : (
      <ToolCallBlock
        toolName={(meta?.toolName as string) || '未知工具'}
        args={pairedCallMeta?.args as Record<string, unknown> | undefined}
        result={msg.content}
        status={meta?.isError ? 'error' : 'done'}
      />
    )

    const tg = item.turnGroup
    if (!tg) return <div className="ml-14 mr-4">{toolBlock}</div>

    // 仅用背景色区分：奇偶 turn 交替底色 + 压缩 turn 降低透明度
    const isOdd = tg.globalIndex % 2 === 1
    return (
      <div className={`ml-14 mr-4 ${
        tg.isFirst ? 'mt-0.5 rounded-t' : ''
      } ${
        tg.isLast ? 'mb-0.5 rounded-b' : ''
      } ${
        isOdd ? 'bg-bg-secondary/30' : ''
      } ${
        tg.willBeCompressed ? 'opacity-50' : ''
      }`}>
        {toolBlock}
      </div>
    )
  }

  return (
    <MessageBubble
      role={msg.role as 'user' | 'assistant' | 'system' | 'tool'}
      content={msg.content}
      metadata={msg.metadata}
      model={msg.model}
      onRollback={msg.role === 'user' && msg.type === 'text' ? () => onRollback(msg.id) : undefined}
      onRegenerate={msg.id === lastAssistantTextId ? () => onRegenerate(msg.id) : undefined}
    />
  )
}
