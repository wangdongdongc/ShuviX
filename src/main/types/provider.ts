/** API 协议类型（用户可选） */
export type ApiProtocol = 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'

/** 提供商数据结构 */
export interface Provider {
  id: string
  name: string
  apiKey: string
  baseUrl: string
  apiProtocol: ApiProtocol
  isBuiltin: number // 0=自定义, 1=内置
  isEnabled: number // 0=禁用, 1=启用
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** 提供商模型数据结构 */
export interface ProviderModel {
  id: string // '{providerId}:{modelId}'
  providerId: string
  modelId: string
  isEnabled: number // 0=禁用, 1=启用
  sortOrder: number
}

/** IPC: 更新提供商配置参数 */
export interface ProviderUpdateConfigParams {
  id: string
  apiKey?: string
  baseUrl?: string
}

/** IPC: 切换提供商启用状态参数 */
export interface ProviderToggleEnabledParams {
  id: string
  isEnabled: boolean
}

/** IPC: 切换模型启用状态参数 */
export interface ProviderToggleModelEnabledParams {
  id: string
  isEnabled: boolean
}

/** IPC: 同步提供商模型参数 */
export interface ProviderSyncModelsParams {
  providerId: string
}

/** IPC: 添加自定义提供商参数 */
export interface ProviderAddParams {
  name: string
  baseUrl: string
  apiKey: string
  apiProtocol: ApiProtocol
}

/** IPC: 删除提供商参数 */
export interface ProviderDeleteParams {
  id: string
}

/** IPC: 添加模型参数 */
export interface ProviderAddModelParams {
  providerId: string
  modelId: string
}
