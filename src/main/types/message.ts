export type { MessageType, Message } from '../dao/types'
import type { MessageType } from '../dao/types'

/** IPC: 新增消息参数 */
export interface MessageAddParams {
  sessionId: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'system_notify'
  type?: MessageType
  content: string
  metadata?: string | null
  model?: string
}
