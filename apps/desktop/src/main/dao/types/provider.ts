export type { ApiProtocol } from '@shuvix/chat-protocol/types/provider'
import type { ApiProtocol } from '@shuvix/chat-protocol/types/provider'

/** 提供商数据结构（对应 DB 表 providers） */
export interface Provider {
  id: string
  name: string
  /** 用户友好的显示名称（内置提供商使用，如 "OpenAI"；自定义提供商可为空） */
  displayName: string
  apiKey: string
  baseUrl: string
  apiProtocol: ApiProtocol
  metadata: string // JSON 字符串，如 { customHeaders: { "X-Key": "val" } }
  isBuiltin: number // 0=自定义, 1=内置
  isEnabled: number // 0=禁用, 1=启用
  sortOrder: number
  createdAt: number
  updatedAt: number
  /**
   * 是否已完成订阅登录（0/1）—— DB 里是 `oauth` 列（加密的凭据 JSON），但**凭据本身
   * 永远不进入这个视图**：这个类型会原样经 IPC 发到渲染进程，refresh token 一旦到了
   * 那边就等于泄漏。读凭据走 `providerDao.readOAuthJson()`（模型层的凭据端口），只有主进程调得到。
   */
  oauthConnected: number
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
