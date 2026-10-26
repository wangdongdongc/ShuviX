import { AlertCircle, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AssistantMessage, ChatMessage, ErrorEventMessage } from '../../stores/chatStore'
import { useChatStore, PENDING_PROMPT_ID } from '../../stores/chatStore'
import { UserBubble } from './UserBubble'
import { AssistantBubble } from './AssistantBubble'
import { BackgroundNoticeRow } from './BackgroundNoticeRow'
import { DateNoticeRow } from './DateNoticeRow'
import { EmptyReplyNoticeRow } from './EmptyReplyNoticeRow'
import { InstructionNoticeRow } from './InstructionNoticeRow'
import { CompactionNoticeRow } from './CompactionNoticeRow'
import {
  DATE_NOTICE_KIND,
  EMPTY_REPLY_NOTICE_KIND
} from '@shuvix/chat-protocol/systemNoticeContract'

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
   * 列表项身份（React / Virtuoso 的 key）：助手卡按轮次 `turn:<第几条用户消息>.<这一轮的第几张卡>`，
   * 其余项按自己的消息 id（见 buildVisibleItems）。与 `msg.id` 分开是有意的 —— 一张卡从流式到落定
   * 组内消息会换人，key 不变，展开着的工具卡/思考块不被折回。
   */
  key: string
  /** 代表消息：决定 data-msg-* 与渲染分发（助手组取末条 = 终答） */
  msg: ChatMessage
  /** 助手组的全部消息（msg 是其末条）；非助手项没有，压缩摘要项也没有（它自成一项，不是组） */
  msgs?: AssistantMessage[]
  /** 该组末尾是流式占位卡 */
  isStreamingPlaceholder?: boolean
}

interface MessageRendererProps {
  item: VisibleItem
  lastAssistantId: string | null
  onRollback?: (messageId: string) => void
  onRegenerate?: (assistantMsgId: string) => void
  /** 从某张卡分支出新会话（每张定稿的卡都给；不给 = 没有这个按钮） */
  onFork?: (assistantMsgId: string) => void
}

function ErrorEventBlock({ msg }: { msg: ErrorEventMessage }): React.JSX.Element {
  const { t } = useTranslation()
  const removeMessage = useChatStore((s) => s.removeMessage)
  // 错误块不再是可删除的持久化消息：模型侧错误是 entry 树的一部分（随回退一起消失），
  // 前端侧错误本就只在视图里 —— 关闭按钮统一只做本地移除。
  const handleDelete = async (): Promise<void> => {
    removeMessage(msg.id)
  }
  const retried = msg.metadata?.retried
  return (
    <div className="group relative flex items-center gap-1.5 pl-4 pr-8 mr-4 my-1 text-[11px] text-error/90">
      <AlertCircle size={12} className="flex-shrink-0" />
      {/* min-w-0：错误原文里常有折不开的长串（请求地址、异常链），不让它把这一行撑出对话列 */}
      <span className="min-w-0 whitespace-pre-wrap break-words">{msg.content}</span>
      {/* 最终失败前折叠掉的重试（Q-P3-06 / PIN-21）：一行错误带上次数 */}
      {retried && retried.count > 0 && (
        <span data-error-retries="" className="shrink-0 text-error/60">
          {t('run.errorAfterRetries', { count: retried.count })}
        </span>
      )}
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
  onRegenerate,
  onFork
}: MessageRendererProps): React.JSX.Element | null {
  const { msg } = item

  if (msg.type === 'error_event') return <ErrorEventBlock msg={msg} />

  // 压缩摘要：边界标记，自成一项（见 buildVisibleItems），不是任何一张助手卡的终答
  if (msg.role === 'assistant' && msg.type === 'message' && msg.metadata?.isCompactionSummary) {
    return <CompactionNoticeRow msg={msg} />
  }

  if (msg.role === 'user') {
    // 项目指令注入消息（历史会话）走系统通知行
    if (msg.metadata?.isInstructionInjection) {
      return <InstructionNoticeRow msg={msg} />
    }
    // 自动续跑那一轮的「用户消息」其实是系统写的通知 —— 用户没说过这句话，不能画成用户气泡。
    // 日期通知、空回复追问各有一行：它们不是「后台任务已完成」（种类由投影带来）
    if (msg.metadata?.isSystemNotice) {
      if (msg.metadata.noticeKind === DATE_NOTICE_KIND) return <DateNoticeRow msg={msg} />
      if (msg.metadata.noticeKind === EMPTY_REPLY_NOTICE_KIND) {
        return <EmptyReplyNoticeRow msg={msg} />
      }
      return <BackgroundNoticeRow msg={msg} />
    }
    // 乐观占位（还没落库）：按用户气泡画但压淡，不给回退 —— 树上还没有它
    if (msg.id === PENDING_PROMPT_ID) return <UserBubble msg={msg} pending />
    return <UserBubble msg={msg} onRollback={onRollback ? () => onRollback(msg.id) : undefined} />
  }

  if (msg.role !== 'assistant' || !item.msgs) return null

  return (
    <AssistantBubble
      msgs={item.msgs}
      isStreaming={item.isStreamingPlaceholder}
      // 直接把调用方给的（稳定的）回调交下去，卡以自己的代表消息 id 调用 —— 每次渲染新建一个闭包会让
      // 最后一张卡的 memo 永远失效
      onRegenerate={msg.id === lastAssistantId ? onRegenerate : undefined}
      onFork={onFork}
    />
  )
}
