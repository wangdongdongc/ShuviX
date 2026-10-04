/**
 * 模型层的桌面接线（内聚模块）：provider 表 → agent-runtime 的模型注册表。
 *
 * - `providerCredentialPort` —— 模型层看 provider 表的端口（密文进出 DAO，端口里是明文）
 * - `getModelRegistry()` —— 主进程唯一的 `Models`（懒建；`providers.changed` 时刷新）
 * - `llmNetwork` / `installLlmNetwork()` —— LLM 请求的网络层（15 分钟 dispatcher + 失败成因链）
 *
 * 只依赖 dao / utils / logger（eslint-plugin-boundaries 的 main-service-module 约束）；
 * 订阅登录的编排在平铺的 providerOAuthService，它从这里拿 `models`。
 */
export {
  createProviderCredentialPort,
  providerCredentialPort,
  type ProviderCredentialDao
} from './providerCredentialPort'
export {
  createDesktopModelRegistry,
  getModelRegistry,
  resetModelRegistry,
  resolveModelSelection,
  resolveRequestApiKey,
  type DesktopModelRegistry,
  type DesktopModelRegistryOptions,
  type ModelSelection
} from './modelRegistry'
export { installLlmNetwork, llmNetwork } from './llmNetwork'
