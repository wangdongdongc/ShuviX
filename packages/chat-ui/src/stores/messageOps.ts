/**
 * 消息列表的两个基本操作 —— 主会话（chatStore）与子会话（subSessionStore）共用。
 *
 * 都是纯函数：入参是当前列表，返回新列表（引用不变即表示无改动），
 * 直接在 zustand 的 set() 里调用，保持"一次事件一次 set"。
 */
import type {
  AssistantMessage,
  AssistantToolBlock,
  ChatMessage
} from '@shuvix/chat-protocol/types/chatMessage'

/** 按 id upsert：已存在则原地替换，否则追加。 */
export function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id)
  if (idx === -1) return [...messages, message]
  const next = messages.slice()
  next[idx] = message
  return next
}

/**
 * 把工具结果回填进某张助手卡的工具块。
 *
 * 定位只认 toolCallId（它才是工具调用的身份）；messageId 仅用来命中那张卡，
 * 拿不到或对不上时从后往前找 —— 结果总是属于最近那次调用。
 */
export function fillToolResult(
  messages: ChatMessage[],
  toolCallId: string,
  messageId: string | undefined,
  patch: Pick<AssistantToolBlock, 'result' | 'isError' | 'details'>
): ChatMessage[] {
  const hit = (m: ChatMessage): boolean =>
    m.role === 'assistant' &&
    m.type === 'message' &&
    m.blocks.some((b) => b.type === 'tool' && b.toolCallId === toolCallId)

  let idx = messageId ? messages.findIndex((m) => m.id === messageId && hit(m)) : -1
  if (idx === -1) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (hit(messages[i])) {
        idx = i
        break
      }
    }
  }
  if (idx === -1) return messages

  const target = messages[idx] as AssistantMessage
  const next = messages.slice()
  next[idx] = {
    ...target,
    blocks: target.blocks.map((b) =>
      b.type === 'tool' && b.toolCallId === toolCallId ? { ...b, ...patch } : b
    )
  }
  return next
}
