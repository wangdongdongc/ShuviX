/**
 * AgentHarness 接入层 —— 会话状态的存储与上下文构建全部交给 pi 的 `AgentHarness`。
 *
 * 与旧 runtimeAgent.ts + eventHandler.ts + transcript/ 的关系：
 *  - `HarnessSession`  取代 `RuntimeAgent`（不再持有 messages，不再落库）
 *  - `forwardHarnessEvent` 取代 `forwardAgentEvent`（纯协议翻译）
 *  - `entriesToChatMessages` 取代 `chatMessagesToAgentMessages` 的反向（且是唯一方向）
 */
export { HarnessSession, type HarnessSessionDeps, type ToolCallGate } from './harnessSession'
export {
  forwardHarnessEvent,
  createHarnessEventState,
  type HarnessEventContext,
  type HarnessEventDeps,
  type HarnessEventState
} from './eventHandler'
export {
  entriesToChatMessages,
  INSTRUCTION_CUSTOM_TYPE,
  INLINE_TOKENS_CUSTOM_TYPE,
  SIDECAR_CUSTOM_TYPES,
  type InlineTokensSidecar
} from './projection'
export { createModelsAdapter, type ModelsAdapterDeps } from './modelsAdapter'
export { createStubExecutionEnv } from './stubEnv'
