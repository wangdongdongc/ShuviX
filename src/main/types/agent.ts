/** Agent 初始化时历史消息 */
export interface AgentInitMessage {
  role: string
  content: string
}

/** Agent 初始化参数 */
export interface AgentInitParams {
  sessionId: string
  provider: string
  model: string
  systemPrompt: string
  workingDirectory?: string
  dockerEnabled?: boolean
  dockerImage?: string
  apiKey?: string
  baseUrl?: string
  apiProtocol?: string
  messages?: AgentInitMessage[]
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
