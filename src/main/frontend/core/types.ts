/**
 * ChatEvent — 后端 → 前端通信协议
 *
 * 判别联合类型，每个变体只包含该事件所需字段。
 * 零外部依赖，作为前后端通信的唯一契约。
 */

// ─── 基础 ──────────────────────────────────────────────

interface ChatEventBase {
  sessionId: string
}

// ─── 流式生成 ──────────────────────────────────────────

/** Agent 开始生成 */
export interface ChatAgentStartEvent extends ChatEventBase {
  type: 'agent_start'
}

/** 文本增量 */
export interface ChatTextDeltaEvent extends ChatEventBase {
  type: 'text_delta'
  delta: string
}

/** 思考增量 */
export interface ChatThinkingDeltaEvent extends ChatEventBase {
  type: 'thinking_delta'
  delta: string
}

/** 单条 LLM 回复结束（后续可能有工具调用） */
export interface ChatTextEndEvent extends ChatEventBase {
  type: 'text_end'
}

/** Agent 完成本轮生成 */
export interface ChatAgentEndEvent extends ChatEventBase {
  type: 'agent_end'
  /** 持久化的 assistant 消息 (JSON string) */
  message?: string
  /** Token 用量统计 */
  usage?: ChatTokenUsage
}

// ─── 工具执行 ──────────────────────────────────────────

/** 工具开始执行 */
export interface ChatToolStartEvent extends ChatEventBase {
  type: 'tool_start'
  toolCallId: string
  toolName: string
  toolArgs?: Record<string, unknown>
  /** 持久化的 tool_call 消息 ID */
  messageId?: string
  /** 当前 turn 编号（UI 分组用） */
  turnIndex?: number
  /** 是否需要用户审批（bash 沙箱模式） */
  approvalRequired?: boolean
  /** 是否需要用户选择（ask 工具） */
  userInputRequired?: boolean
  /** 是否需要 SSH 凭据输入 */
  sshCredentialRequired?: boolean
}

/** 工具执行完成 */
export interface ChatToolEndEvent extends ChatEventBase {
  type: 'tool_end'
  toolCallId: string
  toolName: string
  /** 工具输出内容 */
  result?: string
  /** 是否为错误结果 */
  isError?: boolean
  /** 持久化的 tool_result 消息 ID */
  messageId?: string
}

// ─── 交互请求 ──────────────────────────────────────────

/** 工具审批请求（bash 命令等待允许/拒绝） */
export interface ChatApprovalRequestEvent extends ChatEventBase {
  type: 'tool_approval_request'
  toolCallId: string
  toolName: string
  toolArgs?: Record<string, unknown>
}

/** 用户输入请求（ask 工具等待选择） */
export interface ChatInputRequestEvent extends ChatEventBase {
  type: 'user_input_request'
  toolCallId: string
  toolName: string
  payload: {
    question: string
    options: Array<{ label: string; description: string }>
    allowMultiple: boolean
  }
}

/** SSH 凭据请求 */
export interface ChatCredentialRequestEvent extends ChatEventBase {
  type: 'ssh_credential_request'
  toolCallId: string
  toolName: string
}

// ─── 媒体 ──────────────────────────────────────────────

/** 图片数据 */
export interface ChatImageDataEvent extends ChatEventBase {
  type: 'image_data'
  /** JSON string: { data: string, mimeType: string } */
  image: string
}

// ─── 资源事件 ──────────────────────────────────────────

/** Docker 容器生命周期事件 */
export interface ChatDockerEvent extends ChatEventBase {
  type: 'docker_event'
  messageId: string
}

/** SSH 连接生命周期事件 */
export interface ChatSshEvent extends ChatEventBase {
  type: 'ssh_event'
  messageId: string
}

// ─── 错误 ──────────────────────────────────────────────

/** 错误事件 */
export interface ChatErrorEvent extends ChatEventBase {
  type: 'error'
  error: string
}

// ─── 联合类型 ──────────────────────────────────────────

export type ChatEvent =
  | ChatAgentStartEvent
  | ChatTextDeltaEvent
  | ChatThinkingDeltaEvent
  | ChatTextEndEvent
  | ChatAgentEndEvent
  | ChatToolStartEvent
  | ChatToolEndEvent
  | ChatApprovalRequestEvent
  | ChatInputRequestEvent
  | ChatCredentialRequestEvent
  | ChatImageDataEvent
  | ChatDockerEvent
  | ChatSshEvent
  | ChatErrorEvent

// ─── 辅助类型 ──────────────────────────────────────────

/** Token 用量统计 */
export interface ChatTokenUsage {
  input: number
  output: number
  cacheRead: number
  total: number
  details: Array<{
    input: number
    output: number
    cacheRead: number
    total: number
    stopReason: string
  }>
}
