/**
 * 模型解析（桌面 wrapper）：从 providerDao 读取提供商信息，委托 @shuvix/agent-runtime 的
 * 宿主无关 resolveModel 构造 pi-ai Model 对象。env 注入走 electronEnv（process.env）。
 *
 * 保留与既有调用方一致的签名（create / setModel / generateTitle 直接调用）。
 */
import type { Model, Api } from '@earendil-works/pi-ai'
import {
  resolveModel as resolveModelCore,
  type ResolveModelProviderInfo
} from '@shuvix/agent-runtime'
import { providerDao } from '../dao/providerDao'
import type { ModelCapabilities } from '../types'
import { electronEnv } from './agentRuntimeAdapters'

export interface ResolveModelParams {
  provider: string
  model: string
  capabilities: ModelCapabilities
  baseUrl?: string // setModel 传入的覆盖值
  apiProtocol?: string // setModel 传入的覆盖值
}

/** 统一模型解析逻辑：从 provider + model + capabilities 解析出 pi-ai Model 对象 */
export function resolveModel(params: ResolveModelParams): Model<Api> {
  const p = providerDao.findById(params.provider)
  const providerInfo: ResolveModelProviderInfo | null = p
    ? {
        id: p.id,
        name: p.name,
        isBuiltin: !!p.isBuiltin,
        apiKey: p.apiKey,
        baseUrl: p.baseUrl,
        apiProtocol: p.apiProtocol,
        metadata: p.metadata
      }
    : null
  return resolveModelCore({ ...params, providerInfo, env: electronEnv })
}
