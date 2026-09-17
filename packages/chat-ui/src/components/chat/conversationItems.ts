/**
 * 消息列表 → 对话流的项 —— 一段与 React 无关的纯逻辑。
 *
 * 从 `Conversation.tsx` 里抽出来的理由不止「好测」：它是**两个消费方**共用的形状构造器
 * （普通会话的 `Conversation` 与笔记本的 `ThreadDrawer` 都调它），而 `Conversation.tsx`
 * 顶部拉进了 react-virtuoso / useChatHost / 输入区那一整棵渲染树 —— 把这段折叠规则搁在
 * 那里面，就意味着任何人想验证「A、A、B 该怎么分组」都得先起一个浏览器环境。
 * `Conversation.tsx` 仍然按同名再导出，既有 import 路径一个都不用改。
 */
import type { ChatMessage, AssistantMessage, UserTextMessage } from '../../stores/chatStore'
import { STREAMING_PLACEHOLDER_ID, type VisibleItem } from './MessageRenderer'

/** 助手消息（会话树里一条 assistant entry = 一次 LLM 调用） */
export function isAssistantMessage(msg: ChatMessage): msg is AssistantMessage {
  return msg.role === 'assistant' && msg.type === 'message'
}

/** 不含工具块 = 本轮终答，这张卡到此收口（与投影里 toolCalls.length === 0 同义） */
export function isFinalAnswer(msg: AssistantMessage): boolean {
  return !msg.blocks.some((b) => b.type === 'tool')
}

/** 流式占位卡：正文/思考/工具调用由 AssistantBubble 自己从 store 读 */
export function streamingPlaceholder(sessionId: string): AssistantMessage {
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
 * 压缩摘要虽然也是 assistant 消息，但它是边界标记而不是哪一轮的终答：自成一项。
 *
 * 每项的 key 取组首消息 id：流式占位并入已有组时组首不变，本轮结束换成真实终答
 * 也不会让这一项重挂载 —— 展开着的工具卡/思考块因此不会被折回去。
 *
 * `pending` 是正在发送、后端还没落库的那条用户消息（乐观占位）：排在列表末尾、流式占位卡
 * 之前；它落库后 `user_message` 把真实 entry 送来，占位随即撤下，同一句话换成真的那条。
 */
export function buildVisibleItems(
  messages: ChatMessage[],
  isStreaming: boolean,
  pending?: UserTextMessage | null
): VisibleItem[] {
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
      // 压缩摘要是边界标记，不是某一轮的终答：自成一项，不并入前后任何一张卡 ——
      // 并进去的话，一段没有终答的过程（中止 / steer）会把摘要当成自己的「结论」
      if (msg.metadata?.isCompactionSummary) {
        flush()
        items.push({ key: msg.id, msg })
        continue
      }
      group.push(msg)
      if (isFinalAnswer(msg)) flush()
      continue
    }

    flush()
    items.push({ key: msg.id, msg })
  }

  // 乐观占位的用户消息：先把没收口的助手卡收掉 —— 它是上一轮的，新一轮的占位卡不该并进去
  if (pending) {
    flush()
    items.push({ key: pending.id, msg: pending })
  }

  if (isStreaming) {
    const sessionId =
      group[0]?.sessionId || pending?.sessionId || messages[messages.length - 1]?.sessionId || ''
    group.push(streamingPlaceholder(sessionId))
    flush(true)
  } else {
    flush()
  }

  return items
}
