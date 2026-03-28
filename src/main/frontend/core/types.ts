/**
 * ChatEvent — 后端 → 前端通信协议
 *
 * 判别联合类型，每个变体只包含该事件所需字段。
 * 零外部依赖，作为前后端通信的唯一契约。
 */

import type { ToolResultDetails } from '../../../shared/types/chatMessage'
import type { LucideIconName, ThemeColor } from '../../../shared/theme'

// ─── 基础 ──────────────────────────────────────────────

interface ChatEventBase {
  sessionId: string
  /** 子智能体 task ID（来自子智能体的事件会携带此字段） */
  subAgentId?: string
  /** 子智能体类型名（如 'explore'） */
  subAgentType?: string
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

/** 中间轮次步骤已持久化（step_thinking / step_text） */
export interface ChatStepEndEvent extends ChatEventBase {
  type: 'step_end'
  messageId: string
  /** 持久化的 step 消息 (JSON string)，前端可直接解析避免异步查询 */
  message?: string
}

/** Agent 完成本轮生成 */
export interface ChatAgentEndEvent extends ChatEventBase {
  type: 'agent_end'
  /** 持久化的 assistant 消息 (JSON string) */
  message?: string
  /** Token 用量统计 */
  usage?: ChatTokenUsage
}

// ─── 工具调用生成 ──────────────────────────────────────

/** 工具调用正在生成中（LLM 正在输出 tool_use 块，尚未开始执行） */
export interface ChatToolCallGeneratingEvent extends ChatEventBase {
  type: 'toolcall_generating'
  toolName: string
  /** 参数 JSON 增量文本（与 text_delta 类似，前端累积拼接） */
  argsDelta?: string
}

// ─── 工具执行 ──────────────────────────────────────────

/** 工具开始执行 */
export interface ChatToolStartEvent extends ChatEventBase {
  type: 'tool_start'
  toolCallId: string
  toolName: string
  toolArgs?: Record<string, unknown>
  /** 持久化的 tool_use 消息 ID */
  messageId?: string
  /** 当前 turn 编号（UI 分组用） */
  turnIndex?: number
  /** 是否需要用户审批（bash 沙箱模式） */
  approvalRequired?: boolean
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
  /** 持久化的 tool_use 消息 ID（与 tool_start 相同） */
  messageId?: string
  /** 工具特定的结构化详情（edit diff 等），按 type 判别 */
  details?: ToolResultDetails
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
    detail?: string
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

/** 运行时资源状态信息（前端直接渲染，不理解具体资源类型） */
export interface RuntimeStatus {
  label: string
  icon?: LucideIconName
  color?: ThemeColor
  description?: string
}

/** 运行时资源生命周期事件（status 非 null → 激活/更新，null → 销毁） */
export interface ChatRuntimeEvent extends ChatEventBase {
  type: 'runtime_event'
  runtimeId: string
  status: RuntimeStatus | null
}

/** 预览面板生命周期事件（轻量通知，不持久化为消息；泛化了原 ChatDesignEvent） */
export interface ChatPreviewEvent extends ChatEventBase {
  type: 'preview_event'
  action: 'open' | 'close' | 'server_started' | 'server_stopped'
  url?: string
  title?: string
}

// ─── 子智能体 ──────────────────────────────────────────────

/** 子智能体开始执行 */
export interface ChatSubAgentStartEvent extends ChatEventBase {
  type: 'subagent_start'
  subAgentId: string
  subAgentType: string
  description: string
  parentToolCallId?: string
}

/** 子智能体执行完成 */
export interface ChatSubAgentEndEvent extends ChatEventBase {
  type: 'subagent_end'
  subAgentId: string
  subAgentType: string
  result?: string
  usage?: ChatTokenUsage
}

/** 子智能体内部工具开始 */
export interface ChatSubAgentToolStartEvent extends ChatEventBase {
  type: 'subagent_tool_start'
  subAgentId: string
  subAgentType: string
  toolCallId: string
  toolName: string
  /** 工具参数摘要（后端统一生成，前端直接展示） */
  summary?: string
}

/** 子智能体内部工具更新/完成 */
export interface ChatSubAgentToolEndEvent extends ChatEventBase {
  type: 'subagent_tool_end'
  subAgentId: string
  subAgentType: string
  toolCallId: string
  /** 工具显示名（可选，仅有值时才覆盖已有名称） */
  toolName?: string
  result?: string
  isError?: boolean
}

/** 子智能体文本增量 */
export interface ChatSubAgentTextDeltaEvent extends ChatEventBase {
  type: 'subagent_text_delta'
  subAgentId: string
  subAgentType: string
  delta: string
}

/** 子智能体思考增量 */
export interface ChatSubAgentThinkingDeltaEvent extends ChatEventBase {
  type: 'subagent_thinking_delta'
  subAgentId: string
  subAgentType: string
  delta: string
}

// ─── 错误 ──────────────────────────────────────────────

/** 错误事件 */
export interface ChatErrorEvent extends ChatEventBase {
  type: 'error'
  error: string
}

// ─── 用户消息 ──────────────────────────────────────────

/** 用户消息已持久化事件（外部前端提交 prompt 时通知其他前端） */
export interface ChatUserMessageEvent extends ChatEventBase {
  type: 'user_message'
  /** 持久化的 user 消息 (JSON string) */
  message: string
}

// ─── 联合类型 ──────────────────────────────────────────

export type ChatEvent =
  | ChatAgentStartEvent
  | ChatTextDeltaEvent
  | ChatThinkingDeltaEvent
  | ChatTextEndEvent
  | ChatStepEndEvent
  | ChatAgentEndEvent
  | ChatToolCallGeneratingEvent
  | ChatToolStartEvent
  | ChatToolEndEvent
  | ChatApprovalRequestEvent
  | ChatInputRequestEvent
  | ChatCredentialRequestEvent
  | ChatImageDataEvent
  | ChatRuntimeEvent
  | ChatPreviewEvent
  | ChatSubAgentStartEvent
  | ChatSubAgentEndEvent
  | ChatSubAgentToolStartEvent
  | ChatSubAgentToolEndEvent
  | ChatSubAgentTextDeltaEvent
  | ChatSubAgentThinkingDeltaEvent
  | ChatErrorEvent
  | ChatUserMessageEvent

// ─── 辅助类型 ──────────────────────────────────────────

/** Token 用量统计 */
export interface ChatTokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  details: Array<{
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
    stopReason: string
  }>
}
