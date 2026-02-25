/** API 协议类型（用户可选） */
export type ApiProtocol = 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'

/** 模型能力元数据 */
export interface ModelCapabilities {
  vision?: boolean           // 图像输入
  imageOutput?: boolean      // 图像生成输出
  functionCalling?: boolean  // 工具调用
  reasoning?: boolean        // 推理/思考
  audioInput?: boolean
  audioOutput?: boolean
  pdfInput?: boolean
  maxInputTokens?: number
  maxOutputTokens?: number
  inputCostPerToken?: number   // 仅存储，暂不展示
  outputCostPerToken?: number  // 仅存储，暂不展示
}

/** 提供商数据结构 */
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

/** 提供商模型数据结构 */
export interface ProviderModel {
  id: string
  providerId: string
  modelId: string
  isEnabled: number // 0=禁用, 1=启用
  sortOrder: number
  capabilities: string // JSON 字符串，解析为 ModelCapabilities
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
