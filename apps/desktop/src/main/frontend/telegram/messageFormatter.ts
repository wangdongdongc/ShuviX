import { InlineKeyboard } from 'grammy'
import type {
  ApprovalInputRequest,
  ChoiceInputRequest
} from '@shuvix/chat-protocol/types/inputRequest'

/** Telegram 消息长度上限 */
const MAX_MESSAGE_LENGTH = 4096

/** 截断文本至 Telegram 限制 */
function truncate(text: string, max = MAX_MESSAGE_LENGTH): string {
  if (text.length <= max) return text
  return text.slice(0, max - 15) + '\n... (truncated)'
}

/** 从持久化消息 JSON 中提取助手文本内容 */
export function extractMessageContent(messageJson: string | undefined): string | null {
  if (!messageJson) return null
  try {
    const parsed = JSON.parse(messageJson)
    return parsed.content || null
  } catch {
    return null
  }
}

/** 格式化工具审批消息 + Inline Keyboard(基于统一 InputRequest 模型) */
export function formatApprovalMessage(request: ApprovalInputRequest): {
  text: string
  keyboard: InlineKeyboard
} {
  let text = `🔧 Tool: ${request.toolName}\n  command: ${request.command}`
  if (request.description) {
    text += `\n  description: ${request.description}`
  }
  text = truncate(text)

  const keyboard = new InlineKeyboard()
    .text('✅ Allow', `approve:${request.id}:yes`)
    .text('❌ Deny', `approve:${request.id}:no`)

  return { text, keyboard }
}

/** 格式化 ask(选择题)交互消息 + Inline Keyboard(基于统一 InputRequest 模型) */
export function formatAskMessage(request: ChoiceInputRequest): {
  text: string
  keyboard: InlineKeyboard
} {
  const { question, detail, options, allowMultiple } = request
  let text = question
  if (detail) text += `\n${detail}`
  text = truncate(text)

  const keyboard = new InlineKeyboard()
  for (let i = 0; i < options.length; i++) {
    const label = options[i].label
    keyboard.text(label, `ask:${request.id}:${i}`).row()
  }
  if (allowMultiple) {
    keyboard.text('📤 Submit', `ask:${request.id}:done`).row()
  }

  return { text, keyboard }
}

/** 截断工具输出 */
export function formatToolResult(result: string | undefined, isError?: boolean): string {
  if (!result) return isError ? '(error, no output)' : '(no output)'
  const prefix = isError ? '❌ ' : ''
  return truncate(prefix + result, 500)
}

/** 格式化助手回复文本（截断至 Telegram 限制） */
export function formatAssistantText(text: string): string {
  return truncate(text)
}
