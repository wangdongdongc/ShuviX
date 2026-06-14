import type { ModelCapabilities } from './provider'
import type { SessionModelMetadata } from './session'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

// 思考深度级别已抽到 @shuvix/chat-protocol（UI 与后端共享），此处再导出以兼容既有 main/types 消费方
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
export type { ThinkingLevel }

/** Agent 初始化参数（仅需 sessionId，后端自行查询其余信息） */
export interface AgentInitParams {
  sessionId: string
}

/** Agent 初始化返回结果（后端解析的会话信息，供前端同步 UI 状态） */
export interface AgentInitResult {
  success: boolean
  /** 是否新创建了 Agent（false 表示已存在，跳过创建） */
  created: boolean
  /** 会话所属提供商 ID */
  provider: string
  /** 会话当前模型 ID */
  model: string
  /** 模型能力 */
  capabilities: ModelCapabilities
  /** 会话模型元数据 */
  modelMetadata: SessionModelMetadata
  /** 项目工作目录 */
  workingDirectory: string
  /** 当前生效的工具列表 */
  enabledTools: string[]
}

/** 图片内容（base64） */
export interface ImageContentParam {
  type: 'image'
  data: string
  mimeType: string
}

/** Agent 发送消息参数 */
export interface AgentPromptParams {
  sessionId: string
  text: string
  /** 附带的图片列表（base64 编码） */
  images?: ImageContentParam[]
  /** 前端预处理的内联 Token（斜杠命令展开等），后端直接使用不再重复查询 */
  inlineTokens?: Record<string, InlineToken>
}

/** Agent steer 消息参数（运行中注入引导消息） */
export interface AgentSteerParams {
  sessionId: string
  text: string
}

/** Agent 模型切换参数 */
export interface AgentSetModelParams {
  sessionId: string
  provider: string
  model: string
  baseUrl?: string
  apiProtocol?: string
}

/** Agent 设置思考深度参数 */
export interface AgentSetThinkingLevelParams {
  sessionId: string
  level: ThinkingLevel
}
