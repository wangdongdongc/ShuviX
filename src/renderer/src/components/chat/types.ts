import type { StepTextMessage, StepThinkingMessage, ToolUseMessage } from '../../stores/chatStore'

/** 步骤消息窄类型 */
export type StepMessage = StepTextMessage | StepThinkingMessage | ToolUseMessage

/** 内嵌步骤项（tool_use / step thinking / step text） */
export interface StepItem {
  msg: StepMessage
}
