/** API 协议类型（用户可选） */
export type ApiProtocol = 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'

/** 提供商数据结构（对应 DB 表 providers） */
export interface Provider {
  id: string
  name: string
  /** 用户友好的显示名称（内置提供商使用，如 "OpenAI"；自定义提供商可为空） */
  displayName: string
  apiKey: string
  baseUrl: string
  apiProtocol: ApiProtocol
  isBuiltin: number // 0=自定义, 1=内置
  isEnabled: number // 0=禁用, 1=启用
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** 提供商模型数据结构（对应 DB 表 provider_models） */
export interface ProviderModel {
  id: string
  providerId: string
  modelId: string
  isEnabled: number // 0=禁用, 1=启用
  sortOrder: number
  capabilities: string // JSON 字符串，解析为 ModelCapabilities
}
