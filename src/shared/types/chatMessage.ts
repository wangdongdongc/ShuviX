/**
 * 消息相关共享类型 — main / preload / renderer 共用
 * 唯一定义源，消除跨进程类型重复
 */

// ---- 基础元数据类型 ----

/** 图片元数据（用户附图 / AI 生成图 / 中间步骤图） */
export interface ImageMeta {
  data?: string
  preview?: string
  mimeType: string
  thoughtSignature?: string
}

/** token 用量统计 */
export interface UsageInfo {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  total: number
  details?: Array<{
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    total: number
    stopReason: string
  }>
}

/** 消息元数据（扁平超集，DAO 层使用） */
export interface MessageMetadata {
  // —— user ——
  source?: { type: string; [k: string]: unknown }
  // —— user / assistant text / step_text ——
  images?: ImageMeta[]
  // —— assistant text ——
  thinking?: string
  usage?: UsageInfo
  // —— tool_call / tool_result ——
  toolCallId?: string
  toolName?: string
  // —— tool_call ——
  args?: Record<string, unknown>
  // —— tool_result ——
  isError?: boolean
  // —— step / tool_call ——
  turnIndex?: number
  // —— docker_event ——
  containerId?: string
  image?: string
  reason?: string
  // —— ssh_event ——
  host?: string
  port?: string
  username?: string
}

// ---- per-type metadata 接口 ----

/** 用户文本消息元数据 */
export interface UserTextMeta {
  source?: { type: string; [k: string]: unknown }
  images?: ImageMeta[]
}

/** 助手文本消息元数据（最终回复） */
export interface AssistantTextMeta {
  images?: ImageMeta[]
  thinking?: string
  usage?: UsageInfo
}

/** 工具调用元数据 */
export interface ToolCallMeta {
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  turnIndex?: number
}

/** 工具结果元数据 */
export interface ToolResultMeta {
  toolCallId: string
  toolName: string
  isError?: boolean
}

/** 中间步骤文本元数据 */
export interface StepTextMeta {
  turnIndex?: number
  images?: ImageMeta[]
}

/** 中间步骤思考元数据 */
export interface StepThinkingMeta {
  turnIndex?: number
}

/** Docker 事件元数据 */
export interface DockerEventMeta {
  containerId?: string
  image?: string
  reason?: string
}

/** SSH 事件元数据 */
export interface SshEventMeta {
  host?: string
  port?: string
  username?: string
  reason?: string
}

// error_event 无 metadata

// ---- 判别联合基础 ----

export interface MessageBase {
  id: string
  sessionId: string
  content: string
  model: string
  createdAt: number
}

// ---- 联合成员 ----

export interface UserTextMessage extends MessageBase {
  role: 'user'
  type: 'text'
  metadata: UserTextMeta | null
}

export interface AssistantTextMessage extends MessageBase {
  role: 'assistant'
  type: 'text'
  metadata: AssistantTextMeta | null
}

export interface ToolCallMessage extends MessageBase {
  role: 'assistant'
  type: 'tool_call'
  metadata: ToolCallMeta | null
}

export interface ToolResultMessage extends MessageBase {
  role: 'tool'
  type: 'tool_result'
  metadata: ToolResultMeta | null
}

export interface StepTextMessage extends MessageBase {
  role: 'assistant'
  type: 'step_text'
  metadata: StepTextMeta | null
}

export interface StepThinkingMessage extends MessageBase {
  role: 'assistant'
  type: 'step_thinking'
  metadata: StepThinkingMeta | null
}

export interface DockerEventMessage extends MessageBase {
  role: 'system_notify'
  type: 'docker_event'
  metadata: DockerEventMeta | null
}

export interface SshEventMessage extends MessageBase {
  role: 'system_notify'
  type: 'ssh_event'
  metadata: SshEventMeta | null
}

export interface ErrorEventMessage extends MessageBase {
  role: 'system_notify'
  type: 'error_event'
  metadata: null
}

/** 判别联合：所有消息类型 */
export type ChatMessage =
  | UserTextMessage
  | AssistantTextMessage
  | ToolCallMessage
  | ToolResultMessage
  | StepTextMessage
  | StepThinkingMessage
  | DockerEventMessage
  | SshEventMessage
  | ErrorEventMessage
