import { getHostApi } from '@shuvix/chat-ui'
import { AlertCircle, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage, ErrorEventMessage, UserTextMessage } from '../../stores/chatStore'
import { useChatStore } from '../../stores/chatStore'
import { UserBubble } from './UserBubble'
import { AssistantBubble } from './AssistantBubble'
import { InstructionBubble } from './InstructionBubble'
import type { StepItem, StepMessage } from './types'

/** 可见消息项（由 ChatView 预处理后传入） */
export interface VisibleItem {
  msg: ChatMessage
  /** 内嵌的中间步骤（仅 assistant text 消息携带） */
  steps?: VisibleItem[]
  /** 流式合成占位项（由 AssistantBubble 自行从 store 读取流式状态） */
  isStreamingPlaceholder?: boolean
  /** 已归档消息（只读，不显示操作按钮） */
  isArchived?: boolean
}

interface MessageRendererProps {
  item: VisibleItem
  lastAssistantTextId: string | null
  onRollback?: (messageId: string) => void
  onRegenerate?: (assistantMsgId: string) => void
}

function ErrorEventBlock({ msg }: { msg: ErrorEventMessage }): React.JSX.Element {
  const { t } = useTranslation()
  const removeMessage = useChatStore((s) => s.removeMessage)
  const handleDelete = async (): Promise<void> => {
    try {
      // 渠道端无写权限：仅本地移除（host 缺省即跳过持久化删除）
      await getHostApi()?.message.deleteErrorEvent({
        sessionId: msg.sessionId,
        messageId: msg.id
      })
    } finally {
      removeMessage(msg.id)
    }
  }
  return (
    <div className="group relative flex items-center gap-1.5 pl-10 pr-8 mr-4 my-1 text-[11px] text-error/90">
      <div className="absolute left-[1.35rem] top-0 bottom-0 w-px bg-border-secondary/40" />
      <AlertCircle size={12} />
      <span className="whitespace-pre-wrap break-words">{msg.content}</span>
      <button
        type="button"
        onClick={handleDelete}
        className="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-error/10 text-error/70 hover:text-error"
        title={t('common.delete', '删除')}
        aria-label={t('common.delete', '删除')}
      >
        <Trash2 size={12} />
      </button>
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

  const isArchived = item.isArchived

  // 用户消息
  if (msg.role === 'user' && msg.type === 'text') {
    // 项目指令注入消息走专用卡片
    if ((msg as UserTextMessage).metadata?.isInstructionInjection) {
      return <InstructionBubble msg={msg as UserTextMessage} />
    }
    return (
      <UserBubble
        msg={msg}
        onRollback={!isArchived && onRollback ? () => onRollback(msg.id) : undefined}
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
      isStreaming={item.isStreamingPlaceholder}
      onRegenerate={
        !isArchived && msg.id === lastAssistantTextId && onRegenerate
          ? () => onRegenerate(msg.id)
          : undefined
      }
    />
  )
}
