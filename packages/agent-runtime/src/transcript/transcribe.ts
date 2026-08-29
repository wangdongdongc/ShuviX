/**
 * transcribeAgentMessages —— 面向 Agent 的转写门面。
 *
 * 任意 Agent（根会话 / 派生临时 agent）的上下文消息
 * （派生 agent 的内存会话树上下文）经反向投影进入 ChatMessage 世界，
 * 再由 chat-protocol 的 transcribeConversation（导出等能力共用的唯一渲染引擎）渲染为
 * Markdown 转写。端无关、无存储依赖 —— 数据源即 LLM 实际看到的上下文。
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  transcribeConversation,
  type TranscribeOptions
} from '@shuvix/chat-protocol/utils/transcript'
import { agentMessagesToChatMessages } from './convert'

/** 把一段 Agent 上下文渲染为 Markdown 转写（选项与 transcribeConversation 一致） */
export function transcribeAgentMessages(
  messages: AgentMessage[],
  options: TranscribeOptions = {}
): string {
  return transcribeConversation(agentMessagesToChatMessages(messages), options)
}
