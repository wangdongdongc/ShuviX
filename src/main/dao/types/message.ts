// 基础元数据类型从 shared 导入（唯一定义源）
export type { ImageMeta, UsageInfo, MessageMetadata } from '../../../shared/types/chatMessage'
import type { MessageMetadata } from '../../../shared/types/chatMessage'

/** 消息类型标识 */
export type MessageType =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'step_text'
  | 'step_thinking'
  | 'docker_event'
  | 'ssh_event'
  | 'error_event'

/** 消息数据结构（对应 DB 表 messages / message_steps） */
export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'system_notify'
  type: MessageType
  content: string
  metadata: MessageMetadata | null
  model: string
  createdAt: number
}
