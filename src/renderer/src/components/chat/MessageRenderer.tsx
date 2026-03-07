import { AlertCircle } from 'lucide-react'
import type { ChatMessage, ErrorEventMessage } from '../../stores/chatStore'
import { UserBubble } from './UserBubble'
import { AssistantBubble } from './AssistantBubble'
import type { StepItem, StepMessage } from './types'

/** 可见消息项（由 ChatView 预处理后传入） */
export interface VisibleItem {
  msg: ChatMessage
  /** 内嵌的中间步骤（仅 assistant text 消息携带） */
  steps?: VisibleItem[]
}

interface MessageRendererProps {
  item: VisibleItem
  lastAssistantTextId: string | null
  onRollback?: (messageId: string) => void
  onRegenerate?: (assistantMsgId: string) => void
}

function ErrorEventBlock({ msg }: { msg: ErrorEventMessage }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 ml-14 mr-4 my-1 text-[11px] text-error/90">
      <AlertCircle size={12} />
      <span className="whitespace-pre-wrap break-words">{msg.content}</span>
    </div>
  )
}

/**
 * 消息渲染器 — 根据消息类型分发渲染
 * step/tool 消息已合并到 assistant text 的 AssistantBubble 内部，不再独立渲染
 */
export function MessageRenderer({
  item,
  lastAssistantTextId,
  onRollback,
  onRegenerate
}: MessageRendererProps): React.JSX.Element {
  const { msg } = item

  switch (msg.type) {
    case 'error_event':
      return <ErrorEventBlock msg={msg} />
  }

  // 将 VisibleItem.steps 转换为 StepItem[]（窄化 msg 类型）
  const steps: StepItem[] | undefined = item.steps?.map((s) => ({
    msg: s.msg as StepMessage
  }))

  // 用户消息
  if (msg.role === 'user' && msg.type === 'text') {
    return (
      <UserBubble
        msg={msg}
        onRollback={onRollback ? () => onRollback(msg.id) : undefined}
      />
    )
  }

  // 助手消息（含 synthetic orphan messages）
  // switch 已排除事件类型，if 已排除 user text；剩余 step/tool 类型在实际流程中
  // 不会走到这里（它们被收入 steps 数组），但 TS 无法静态推断，需显式断言
  const assistantMsg = msg as import('../../stores/chatStore').AssistantTextMessage
  return (
    <AssistantBubble
      msg={assistantMsg}
      steps={steps}
      onRegenerate={msg.id === lastAssistantTextId && onRegenerate ? () => onRegenerate(msg.id) : undefined}
    />
  )
}
