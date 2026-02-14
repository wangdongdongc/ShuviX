/** Agent 初始化时历史消息 */
export interface AgentInitMessage {
  role: string
  content: string
}

/** Agent 初始化参数（字段较多，统一类型） */
export interface AgentInitParams {
  provider: string
  model: string
  systemPrompt: string
  apiKey?: string
  baseUrl?: string
  messages?: AgentInitMessage[]
}

/** Agent 模型切换参数（后续可扩展） */
export interface AgentSetModelParams {
  provider: string
  model: string
  baseUrl?: string
}
