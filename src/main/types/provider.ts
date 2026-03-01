export type { ApiProtocol, Provider, ProviderModel } from '../dao/types'
import type { ApiProtocol, ProviderModel } from '../dao/types'

/** 模型能力元数据 */
export interface ModelCapabilities {
  vision?: boolean // 图像输入
  imageOutput?: boolean // 图像生成输出
  functionCalling?: boolean // 工具调用
  reasoning?: boolean // 推理/思考
  audioInput?: boolean
  audioOutput?: boolean
  pdfInput?: boolean
  maxInputTokens?: number
  maxOutputTokens?: number
  inputCostPerToken?: number // 仅存储，暂不展示
  outputCostPerToken?: number // 仅存储，暂不展示
}

/** 可用模型（含提供商显示名称，对应 findAllEnabledModels JOIN 结果） */
export interface AvailableModel extends ProviderModel {
  providerName: string
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

/** IPC: 更新模型能力参数 */
export interface ProviderUpdateModelCapabilitiesParams {
  id: string
  capabilities: ModelCapabilities
}
