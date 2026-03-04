import type {
  StepTextMessage,
  StepThinkingMessage,
  ToolCallMessage,
  ToolResultMessage,
  ToolCallMeta
} from '../../stores/chatStore'

/** 步骤消息窄类型（仅 step/tool 四种） */
export type StepMessage = StepTextMessage | StepThinkingMessage | ToolCallMessage | ToolResultMessage

/** 内嵌步骤项（tool call/result + step thinking/text） */
export interface StepItem {
  msg: StepMessage
  pairedCallMeta?: ToolCallMeta
}
