import { AlertCircle, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AssistantMessage, ChatMessage, ErrorEventMessage } from '../../stores/chatStore'
import { useChatStore } from '../../stores/chatStore'
import { UserBubble } from './UserBubble'
import { BotBubble } from './BotBubble'
import { AssistantBubble } from './AssistantBubble'
import { BackgroundNoticeBubble } from './BackgroundNoticeBubble'
import { InstructionBubble } from './InstructionBubble'

/** 流式占位卡的固定 id（Conversation 追加，AssistantBubble 据此读流式状态） */
export const STREAMING_PLACEHOLDER_ID = 'streaming-live'

/**
 * 对话流里的一项。
 *
 * 助手项可覆盖**多条**连续 assistant 消息 —— 会话树里一次 agent 循环是若干条
 * entry（每次 LLM 调用一条），呈现上仍收成一张卡（过程在上、终答在下）。
 */
export interface VisibleItem {
  /**
   * 列表项身份（React / Virtuoso 的 key）：取组内**首条**消息的 id。
   * 与 `msg.id` 分开是有意的 —— 流式占位卡并入已有组时组首不变，
   * 本轮结束、占位换成真实终答时这一项不会重挂载，展开着的工具卡/思考块不被折回。
   */
  key: string
  /** 代表消息：决定 data-msg-* 与渲染分发（助手组取末条 = 终答） */
  msg: ChatMessage
  /** 助手组的全部消息（msg 是其末条）；非助手项没有 */
  msgs?: AssistantMessage[]
  /** 该组末尾是流式占位卡 */
  isStreamingPlaceholder?: boolean
  /** 群聊气泡：上一项也是同一个 bot 说的 —— 合并头部，只留气泡 */
  mergeHeader?: boolean
}

interface MessageRendererProps {
  item: VisibleItem
  lastAssistantId: string | null
  onRollback?: (messageId: string) => void
  onRegenerate?: (assistantMsgId: string) => void
}

function ErrorEventBlock({ msg }: { msg: ErrorEventMessage }): React.JSX.Element {
  const { t } = useTranslation()
  const removeMessage = useChatStore((s) => s.removeMessage)
  // 错误块不再是可删除的持久化消息：模型侧错误是 entry 树的一部分（随回退一起消失），
  // 前端侧错误本就只在视图里 —— 关闭按钮统一只做本地移除。
  const handleDelete = async (): Promise<void> => {
    removeMessage(msg.id)
  }
  return (
    <div className="group relative flex items-center gap-1.5 pl-4 pr-8 mr-4 my-1 text-[11px] text-error/90">
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
 * 消息渲染器 — 根据代表消息的 role/type 分发渲染。
 *
 * 根节点带 `data-msg-id` / `data-msg-role` / `data-msg-type`：对话流的消息身份
 * （投影契约里的那个 id）在 DOM 上唯一的、与配色/图标无关的锚点，e2e 据此定位条目。
 *
 * 也是**正文限宽**的落点（笔记本正文早就限在 .cm-content 700px，对话流一直没限）。
 * 784 = 输入卡片的 max-w-3xl(768) − 它的 p-2(16) + 本行 px-4(32)：算下来文字列与
 * 输入卡片**左右缘逐像素对齐**，整个对话区读起来是一列而不是两列错开。窗口再宽也
 * 不把行拉长 —— 长行会让眼睛回扫时找不到下一行行首。
 *
 * 限在**每条消息**而不是整个滚动容器上：限容器会把滚动条一起推进来，滚动条就不贴
 * 窗口右缘了。两侧空白由 mx-auto 产生。
 */
const CONTENT_MAX_W = 'max-w-[784px] mx-auto'

export function MessageRenderer(props: MessageRendererProps): React.JSX.Element {
  const { msg } = props.item
  return (
    <div
      className={CONTENT_MAX_W}
      data-msg-id={msg.id}
      data-msg-role={msg.role}
      data-msg-type={msg.type}
    >
      <MessageBody {...props} />
    </div>
  )
}

function MessageBody({
  item,
  lastAssistantId,
  onRollback,
  onRegenerate
}: MessageRendererProps): React.JSX.Element | null {
  const { msg } = item

  if (msg.type === 'error_event') return <ErrorEventBlock msg={msg} />

  if (msg.role === 'user') {
    // 项目指令注入消息走专用卡片
    if (msg.metadata?.isInstructionInjection) {
      return <InstructionBubble msg={msg} />
    }
    // 自动续跑那一轮的「用户消息」其实是系统写的通知 —— 用户没说过这句话，不能画成用户气泡
    if (msg.metadata?.isSystemNotice) {
      return <BackgroundNoticeBubble msg={msg} />
    }
    return <UserBubble msg={msg} onRollback={onRollback ? () => onRollback(msg.id) : undefined} />
  }

  if (msg.role !== 'assistant' || !item.msgs) return null

  // 群聊会话：bot 的发言是群里的另一个人，不是助手卡。
  // 判据是 metadata.sender —— 只有聊天会话的消息带它（有根会话的助手消息永远没有）。
  if (msg.metadata?.sender) {
    return <BotBubble msg={msg} mergeHeader={item.mergeHeader} />
  }

  return (
    <AssistantBubble
      msgs={item.msgs}
      isStreaming={item.isStreamingPlaceholder}
      onRegenerate={
        msg.id === lastAssistantId && onRegenerate ? () => onRegenerate(msg.id) : undefined
      }
    />
  )
}
