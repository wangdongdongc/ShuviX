/** 消息类型标识 */
export type MessageType = 'text' | 'tool_call' | 'tool_result' | 'docker_event'

/** 消息数据结构 */
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

/** IPC: 新增消息参数 */
export interface MessageAddParams {
  sessionId: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'system_notify'
  type?: MessageType
  content: string
  metadata?: string | null
  model?: string
}
