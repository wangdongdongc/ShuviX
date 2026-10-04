/**
 * 模型层的桌面接线（内聚模块）。
 *
 * - `llmNetwork` / `installLlmNetwork()` —— LLM 请求的网络层（15 分钟 dispatcher + 失败成因链）
 *
 * 只依赖 dao / utils / logger（eslint-plugin-boundaries 的 main-service-module 约束）。
 */
export { installLlmNetwork, llmNetwork } from './llmNetwork'
