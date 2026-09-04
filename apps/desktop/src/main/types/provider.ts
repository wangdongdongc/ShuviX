export type { ApiProtocol, Provider, ProviderModel } from '../dao/types'
import type { ApiProtocol, ProviderModel } from '../dao/types'

// 模型能力元数据 —— 单一源在 @shuvix/chat-protocol（前端 IPC 视图复用），此处再导出
export type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'

/** 可用模型（含提供商显示名称，对应 findAllEnabledModels JOIN 结果） */
export interface AvailableModel extends ProviderModel {
  providerName: string
}

/** IPC: 更新提供商配置参数 */
export interface ProviderUpdateConfigParams {
  id: string
  name?: string
  apiKey?: string
  baseUrl?: string
  apiProtocol?: ApiProtocol
  metadata?: string
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
  metadata?: string
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

/** IPC: 更新模型能力参数 */
export interface ProviderUpdateModelCapabilitiesParams {
  id: string
  capabilities: ModelCapabilities
}

/** IPC: 订阅登录（OAuth）状态 */
export interface ProviderOAuthStatusInfo {
  /** 该提供商是否支持订阅登录（目前只有 xAI） */
  supported: boolean
  /** 是否已登录 */
  connected: boolean
  /** access token 到期时间（毫秒），未登录为 null */
  expiresAt: number | null
  /** 是否有登录流程正在进行 */
  pending: boolean
}

/**
 * IPC: 登录过程中推给界面的事件。
 *
 * 刻意窄于 pi-ai 的 `AuthEvent` —— preload/renderer 不该间接依赖 pi-ai 的类型，
 * 而界面真正要显示的只有「用户码 + 验证链接」和一行进度文字。
 */
export type ProviderOAuthUiEvent =
  | {
      providerId: string
      kind: 'device_code'
      userCode: string
      verificationUri: string
      expiresInSeconds?: number
    }
  | { providerId: string; kind: 'message'; message: string }
