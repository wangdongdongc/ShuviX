/**
 * Agent 对话/运行时参数类型 —— 单一真源在 @shuvix/chat-protocol/chatApi（前端契约 SessionChannelApi/
 * HostApi 与后端共用）。这里全部「再导出」而非重新定义，使既有 main/preload/ipc 消费方
 * （`import … from '../types'`）的导入路径保持不变，同时杜绝桌面端与扩展端各维护一份副本：
 * 契约只改 chat-protocol 一处，两端自动同步，无需再各自重修。
 */
export type {
  AgentInitParams,
  AgentInitResult,
  AgentRuntimeInfo,
  AgentRuntimeToolInfo,
  ImageContentParam,
  AgentPromptParams,
  AgentSubAgentPromptParams,
  AgentSteerParams,
  AgentFollowUpParams,
  AgentNextTurnParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams
} from '@shuvix/chat-protocol/chatApi'

// 思考深度级别（再导出以兼容既有从本模块直接取 ThinkingLevel 的 main/types 消费方）
export type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
