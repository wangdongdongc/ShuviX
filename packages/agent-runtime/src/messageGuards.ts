/**
 * AgentMessage 类型守卫 — 统一判断消息角色（宿主无关，纯逻辑）
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'

export function isAssistantMessage(msg: AgentMessage): msg is AssistantMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'assistant'
}

export function isUserMessage(msg: AgentMessage): msg is UserMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'user'
}

export function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
  return typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'toolResult'
}
