/** 会话数据结构 */
export interface Session {
  id: string
  title: string
  provider: string
  model: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

/** 消息数据结构 */
export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

/** 提供商数据结构 */
export interface Provider {
  id: string
  name: string
  apiKey: string
  baseUrl: string
  isEnabled: number      // 0=禁用, 1=启用
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** 提供商模型数据结构 */
export interface ProviderModel {
  id: string             // '{providerId}:{modelId}'
  providerId: string
  modelId: string
  isEnabled: number      // 0=禁用, 1=启用
  sortOrder: number
}

/** 设置数据结构 */
export interface Settings {
  key: string
  value: string
}
