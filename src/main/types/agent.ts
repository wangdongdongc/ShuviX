import type { ModelCapabilities } from './provider'

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
  /** 会话 modelMetadata（JSON 字符串） */
  modelMetadata: string
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
}

/** Agent 模型切换参数 */
export interface AgentSetModelParams {
  sessionId: string
  provider: string
  model: string
  baseUrl?: string
  apiProtocol?: string
}

/** 思考深度级别 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Agent 设置思考深度参数 */
export interface AgentSetThinkingLevelParams {
  sessionId: string
  level: ThinkingLevel
}
