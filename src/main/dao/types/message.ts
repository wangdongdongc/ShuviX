/** 消息类型标识 */
export type MessageType =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'docker_event'
  | 'ssh_event'
  | 'error_event'

/** 消息数据结构（对应 DB 表 messages） */
export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'system_notify'
  type: MessageType
  content: string
  metadata: string | null
  model: string
  createdAt: number
}
