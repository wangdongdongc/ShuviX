/** 消息数据结构 */
export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

/** IPC: 新增消息参数 */
export interface MessageAddParams {
  sessionId: string
  role: 'user' | 'assistant'
  content: string
}
