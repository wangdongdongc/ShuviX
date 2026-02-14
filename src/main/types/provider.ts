/** 提供商数据结构 */
export interface Provider {
  id: string
  name: string
  apiKey: string
  baseUrl: string
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
