// DAO 层类型
export type { MessageType, Message } from '../dao/types'

// 消息相关共享类型（从 shared 统一导入，消除重复定义）
export type {
  ImageMeta,
  UsageInfo,
  MessageMetadata,
  UserTextMeta,
  AssistantTextMeta,
  ToolUseMeta,
  ToolResultDetails,
  EditToolDetails,
  BashToolDetails,
  ReadToolDetails,
  GlobToolDetails,
  GrepToolDetails,
  LsToolDetails,
  AskToolDetails,
  SshToolDetails,
  SkillToolDetails,
  SubAgentToolDetails,
  ShuvixSettingToolDetails,
  ShuvixProjectToolDetails,
  McpToolDetails,
  StepTextMeta,
  StepThinkingMeta,
  MessageBase,
  UserTextMessage,
  AssistantTextMessage,
  ToolUseMessage,
  StepTextMessage,
  StepThinkingMessage,
  ErrorEventMessage,
  ChatMessage
} from '../../shared/types/chatMessage'

import type { MessageMetadata } from '../../shared/types/chatMessage'
import type { MessageType } from '../dao/types'
import type { Message } from '../dao/types'
import type { ChatMessage } from '../../shared/types/chatMessage'

/** DAO Message → ChatMessage 窄类型（运行时零开销，仅类型断言） */
export function narrowMessage(msg: Message): ChatMessage {
  return msg as unknown as ChatMessage
}

// ---- IPC 参数 ----

/** IPC: 新增消息参数 */
export interface MessageAddParams {
  sessionId: string
  role: 'user' | 'assistant' | 'tool' | 'system' | 'system_notify'
  type?: MessageType
  content: string
  metadata?: MessageMetadata | null
  model?: string
}

/** IPC: 新增 error_event 参数 */
export interface ErrorEventAddParams {
  sessionId: string
  content: string
}
