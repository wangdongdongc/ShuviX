/** API 协议类型（用户可选） */
export type ApiProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

/** 协议选项列表（UI 下拉框 + 类型守卫共用） */
export const API_PROTOCOL_OPTIONS: Array<{ value: ApiProtocol; labelKey: string }> = [
  { value: 'openai-completions', labelKey: 'settings.protocolOpenAI' },
  { value: 'openai-responses', labelKey: 'settings.protocolOpenAIResponses' },
  { value: 'anthropic-messages', labelKey: 'settings.protocolAnthropic' },
  { value: 'google-generative-ai', labelKey: 'settings.protocolGoogle' }
]

// ─── 前端可见的提供商/模型形状（供 chat-ui ModelPicker / ChatHost 复用） ───
// 注：与 main/dao 的 Provider/ProviderModel（DB 行）平行，这里是前端 IPC 视图。
// preload 的全局 ProviderInfo/ProviderModelInfo/AvailableModel 即指向这三者。

/** 提供商（前端视图） */
export interface ProviderInfo {
  id: string
  name: string
  /** 用户友好的显示名称（内置提供商使用，如 "OpenAI"） */
  displayName: string
  apiKey: string
  baseUrl: string
  apiProtocol: ApiProtocol
  metadata: string
  isBuiltin: number
  isEnabled: number
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** 提供商模型（前端视图） */
export interface ProviderModelInfo {
  id: string
  providerId: string
  modelId: string
  isEnabled: number
  sortOrder: number
  capabilities: string
}

/** 可用模型（含提供商名称） */
export interface AvailableModel extends ProviderModelInfo {
  providerName: string
}
