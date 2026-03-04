import { InlineKeyboard } from 'grammy'
import type { ChatApprovalRequestEvent, ChatInputRequestEvent } from '../core/types'

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

/** 格式化工具参数为简短摘要 */
function formatToolArgs(args?: Record<string, unknown>): string {
  if (!args) return ''
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  return entries
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v)
      const short = val.length > 100 ? val.slice(0, 97) + '...' : val
      return `  ${k}: ${short}`
    })
    .join('\n')
}

/** 格式化工具审批消息 + Inline Keyboard */
export function formatApprovalMessage(event: ChatApprovalRequestEvent): {
  text: string
  keyboard: InlineKeyboard
} {
  let text = `🔧 Tool: ${event.toolName}`
  const argsStr = formatToolArgs(event.toolArgs)
  if (argsStr) {
    text += `\n${argsStr}`
  }
  text = truncate(text)

  const keyboard = new InlineKeyboard()
    .text('✅ Allow', `approve:${event.toolCallId}:yes`)
    .text('❌ Deny', `approve:${event.toolCallId}:no`)

  return { text, keyboard }
}

/** 格式化 ask 工具交互消息 + Inline Keyboard */
export function formatAskMessage(event: ChatInputRequestEvent): {
  text: string
  keyboard: InlineKeyboard
} {
  const { question, options, allowMultiple } = event.payload
  let text = question
  text = truncate(text)

  const keyboard = new InlineKeyboard()
  for (let i = 0; i < options.length; i++) {
    const label = options[i].label
    keyboard.text(label, `ask:${event.toolCallId}:${i}`).row()
  }
  if (allowMultiple) {
    keyboard.text('📤 Submit', `ask:${event.toolCallId}:done`).row()
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
