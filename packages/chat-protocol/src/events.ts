/**
 * ChatEvent — 后端 → 前端通信协议
 *
 * 判别联合类型，每个变体只包含该事件所需字段。
 * 零外部依赖，作为前后端通信的唯一契约。
 */

import type { ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { LucideIconName, ThemeColor } from '@shuvix/chat-protocol/theme'

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

/** 单步 token 用量上报（每个 LLM step 完成后即时下发，用于实时刷新上下文用量指示器） */
export interface ChatTokenUsageEvent extends ChatEventBase {
  type: 'token_usage'
  /** 当前 prompt 占用的 token 数（= total - output，含 cacheRead/cacheWrite） */
  promptTokens: number
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

// ─── 交互请求(统一) ────────────────────────────────────

/**
 * 一个新的"用户输入请求"挂起。前端按 request.kind 渲染对应表单。
 * 命令审批 / 选择题 / SSH 凭证全部走这一个事件,扩展新 kind 不再加新事件类型。
 */
export interface ChatInputRequestEvent extends ChatEventBase {
  type: 'input_request'
  request: import('@shuvix/chat-protocol/types/inputRequest').InputRequest
}

/**
 * 某个用户输入请求已被解决(用户响应 / 取消 / abort 都会发出),
 * 前端用于把对应 request 从 pending 列表移除并清理草稿。
 */
export interface ChatInputRequestResolvedEvent extends ChatEventBase {
  type: 'input_request_resolved'
  requestId: string
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

/** 浏览器面板生命周期事件（轻量通知，不持久化为消息；泛化了原 ChatDesignEvent） */
export interface ChatBrowserEvent extends ChatEventBase {
  type: 'browser_event'
  action: 'open' | 'close'
  url?: string
  title?: string
}

// ─── 子智能体 ──────────────────────────────────────────────

/**
 * 子智能体会话注册（在主会话中启动一个临时子会话）。
 * 子智能体运行期间的 ChatEvent（agent_start / text_delta / tool_start / ...）
 * 统一以 subSessionId 作为 event.sessionId 下发；renderer 通过 register 事件
 * 知晓该 sessionId 属于哪个父会话 + 名称。
 */
export interface ChatSubSessionRegisterEvent extends ChatEventBase {
  type: 'sub_session_register'
  /** 父会话 sessionId */
  parentSessionId: string
  /** 子智能体类型名（如 'explore'） */
  subAgentName: string
  /** UI 展示名 */
  displayName: string
  /** 用户给出的任务简述（父工具 args.description） */
  description: string
  /** 子智能体的系统提示词（UI 以卡片形式展示） */
  systemPrompt: string
  /** 父 Agent 发给子智能体的初始 user prompt（UI 以卡片形式展示） */
  prompt: string
}

/** 子会话终结（在 agent_end 之后发出，携带最终结果摘要） */
export interface ChatSubSessionEndEvent extends ChatEventBase {
  type: 'sub_session_end'
  parentSessionId: string
  /** 子会话最终 result 文本（父的 tool_result） */
  result: string
  /** 是否以异常结束 */
  isError?: boolean
}

// ─── 压缩归档 ────────────────────────────────────────────

/** 压缩开始 */
export interface ChatCompactionStartEvent extends ChatEventBase {
  type: 'compaction_start'
}

/** 压缩完成 */
export interface ChatCompactionEndEvent extends ChatEventBase {
  type: 'compaction_end'
  /** 新摘要消息 (JSON string) */
  message: string
  /** 紧跟摘要的项目指令注入消息 (每个文件一条 JSON string) */
  instructionMessages?: string[]
}

/** 压缩失败 */
export interface ChatCompactionErrorEvent extends ChatEventBase {
  type: 'compaction_error'
  error: string
}

/** 项目指令文件懒注入完成（首次 prompt 前由 AgentSession 触发） */
export interface ChatInstructionsInjectedEvent extends ChatEventBase {
  type: 'instructions_injected'
  /** 已写入的指令消息列表（每条 JSON string） */
  messages: string[]
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
  | ChatTokenUsageEvent
  | ChatToolCallGeneratingEvent
  | ChatToolStartEvent
  | ChatToolEndEvent
  | ChatInputRequestEvent
  | ChatInputRequestResolvedEvent
  | ChatImageDataEvent
  | ChatRuntimeEvent
  | ChatBrowserEvent
  | ChatSubSessionRegisterEvent
  | ChatSubSessionEndEvent
  | ChatCompactionStartEvent
  | ChatCompactionEndEvent
  | ChatCompactionErrorEvent
  | ChatInstructionsInjectedEvent
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
