/**
 * pi-ai `Message` 类型守卫 — 统一判断消息角色（宿主无关，纯逻辑）。
 *
 * pi-ai 1.0 的 `Message` 还多了 `system` 角色；这里只认三种对话角色，其余一律落空。
 */
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage
} from '@earendil-works/pi-ai'

export function isAssistantMessage(msg: Message): msg is AssistantMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'assistant'
}

export function isUserMessage(msg: Message): msg is UserMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'user'
}

export function isToolResultMessage(msg: Message): msg is ToolResultMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'toolResult'
}
