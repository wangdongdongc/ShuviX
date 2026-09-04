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
   * 那边就等于泄漏。读凭据走 `providerDao.readOAuth()`，只有主进程调得到。
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

/**
 * OAuth 凭据（加密落库，仅主进程可见）。
 *
 * 字段与 pi-ai 的 `OAuthCredential` 同形（去掉 `type` 标签）：`expires` 是毫秒时间戳，
 * 且 pi 在签发时已经减去了 5 分钟提前量，所以「到点即刷新」不会用到一个正在途中过期的 token。
 */
export interface ProviderOAuthCredential {
  access: string
  refresh: string
  expires: number
}
