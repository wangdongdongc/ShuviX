import type {
  StepTextMessage,
  StepThinkingMessage,
  ToolCallMessage,
  ToolResultMessage,
  ToolUseMessage,
  ToolCallMeta
} from '../../stores/chatStore'

/** 步骤消息窄类型（step/tool 五种） */
export type StepMessage = StepTextMessage | StepThinkingMessage | ToolCallMessage | ToolResultMessage | ToolUseMessage

/** 内嵌步骤项（tool_use / step thinking / step text） */
export interface StepItem {
  msg: StepMessage
  /** @deprecated 仅用于旧 tool_call/tool_result 配对兼容 */
  pairedCallMeta?: ToolCallMeta
}
