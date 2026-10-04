/**
 * 桌面端的 `ProviderCredentialPort` —— agent-runtime 模型层看 `providers` / `provider_models`
 * 两张表的唯一窗口。
 *
 * 端口只做翻译，不带语义：DB 的 0/1 → 布尔、密文 → 明文、NULL → 空串。哪一行回答哪个 pi
 * provider id（内置按 slug、自定义按行 id）、OAuth 压过 API Key、旧记录归一、写入串行，全在
 * 模型层那一侧（agent-runtime models/credentialStore.ts），在那边测一次。
 *
 * - **读是同步、现读的**：DAO 本来就是同步调用；模型层每次请求都经这里现取 key，设置里刚改的
 *   key 下一条请求就生效 —— 两侧都不缓存。
 * - **OAuth 记录是原文 JSON**：pi-ai 的 `OAuthCredential` 可以带 provider 自己的额外字段，
 *   端口原样进出（`providerDao.readOAuthJson` / `saveOAuthJson`），落库仍是同一套加密
 *   （utils/crypto 的 `$SHUVIX_ENC$v1$` 格式），已有的记录（没有 `type` 字段的那一代）照读。
 * - **密文不出 DAO**：端口拿到的 apiKey / OAuth JSON 都已解密；这个对象只在主进程里用，
 *   绝不经 IPC 外发（发给渲染进程的是 providerDao 的视图，那里只有 `oauthConnected` 一位）。
 */
import type { ProviderCredentialPort, ProviderModelRow, ProviderRow } from '@shuvix/agent-runtime'
import { providerDao, type ProviderDao } from '../../dao/providerDao'

/** 端口用到的那几个 DAO 方法（测试可以换一个假的进来） */
export type ProviderCredentialDao = Pick<
  ProviderDao,
  | 'findAllForModels'
  | 'findAllModels'
  | 'readOAuthJson'
  | 'saveOAuthJson'
  | 'clearOAuth'
  | 'updateApiKey'
>

export function createProviderCredentialPort(
  dao: ProviderCredentialDao = providerDao
): ProviderCredentialPort {
  return {
    listProviders: (): ProviderRow[] =>
      dao.findAllForModels().map((row) => ({
        id: row.id,
        name: row.name ?? '',
        displayName: row.displayName ?? '',
        isBuiltin: row.isBuiltin === 1,
        isEnabled: row.isEnabled === 1,
        apiKey: row.apiKey ?? '',
        baseUrl: row.baseUrl ?? '',
        apiProtocol: row.apiProtocol ?? '',
        metadata: row.metadata ?? ''
      })),
    listModels: (): ProviderModelRow[] =>
      dao.findAllModels().map((row) => ({
        providerId: row.providerId,
        modelId: row.modelId,
        isEnabled: row.isEnabled === 1,
        capabilities: row.capabilities ?? ''
      })),
    readOAuth: (providerRowId) => dao.readOAuthJson(providerRowId),
    saveOAuth: (providerRowId, json) => dao.saveOAuthJson(providerRowId, json),
    clearOAuth: (providerRowId) => dao.clearOAuth(providerRowId),
    saveApiKey: (providerRowId, apiKey) => dao.updateApiKey(providerRowId, apiKey)
  }
}

/** 主进程唯一的端口实例（模型注册表与订阅登录服务共用） */
export const providerCredentialPort: ProviderCredentialPort = createProviderCredentialPort()
