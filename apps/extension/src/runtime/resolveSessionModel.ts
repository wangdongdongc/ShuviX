/**
 * 由 provider/model/capabilities 解析出 pi-ai Model（取 chrome.storage 的 providerInfo + browserEnv）。
 *
 * 单一来源 —— 父会话创建(ensureRuntimeSession)、模型切换(setSessionModel)、子代理(subAgent.buildModel)
 * 共用，避免同一段 providerInfo→resolveModel 逻辑在多处重复。
 */
import { resolveModel, type RuntimeEnv, type ResolveModelProviderInfo } from '@shuvix/agent-runtime'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { settingsStore } from '../storage/settingsStore'

/** 浏览器 RuntimeEnv —— pi-ai 的环境变量注入在浏览器 no-op（apiKey 经 providerInfo 直传） */
export const browserEnv: RuntimeEnv = { setApiKey: () => {} }

export function resolveSessionModel(
  provider: string,
  model: string,
  capabilities: ModelCapabilities
): ReturnType<typeof resolveModel> {
  const providerRow = settingsStore.getProviderWithKey(provider)
  const providerInfo: ResolveModelProviderInfo | null = providerRow
    ? {
        id: providerRow.id,
        name: providerRow.name,
        isBuiltin: !!providerRow.isBuiltin,
        apiKey: providerRow.apiKey,
        baseUrl: providerRow.baseUrl,
        apiProtocol: providerRow.apiProtocol,
        metadata: providerRow.metadata
      }
    : null
  return resolveModel({ provider, model, capabilities, providerInfo, env: browserEnv })
}
