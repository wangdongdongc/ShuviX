/**
 * @shuvix/agent-runtime 注入接口 —— 让宿主无关的编排核心脱离 Node / Electron 运行。
 *
 * 四个注入面：
 *  - RuntimePersistence  消息读写（替代 Electron 的 messageService / *Dao）
 *  - RuntimeConfig       配置读取（替代 settingsDao / sessionDao / providerDao）— 仅在宿主 wrapper 用
 *  - RuntimeEventSink     事件广播（替代 chatFrontendRegistry.broadcast）
 *  - RuntimeEnv           环境变量注入（替代 process.env；浏览器宿主 no-op）
 *
 * 持久化写入必须**同步返回**已创建的消息对象（含 id）：桌面端 better-sqlite3 天然同步；
 * 浏览器端 IndexedDB 适配器需「同步生成 id + 写入内存 + 异步落盘（write-behind）」。
 * listMessages（仅会话创建时读历史）允许异步。
 */
import type { ChatEvent, RuntimeStatus } from '@shuvix/chat-protocol/events'
import type {
  ChatMessage,
  MessageMetadata,
  ImageMeta,
  ToolResultDetails
} from '@shuvix/chat-protocol/types/chatMessage'

export type { ChatEvent, RuntimeStatus, ChatMessage, MessageMetadata, ToolResultDetails }

/** 简单日志接口（默认 no-op；宿主可注入 electron-log / console） */
export interface RuntimeLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

// ─────────────────────────── RuntimePersistence ───────────────────────────

export interface RuntimePersistence {
  /** 读取会话历史（仅会话创建时调用，可异步） */
  listMessages: (sessionId: string) => ChatMessage[] | Promise<ChatMessage[]>
  /** 通用新增（steer / 其他类型）。同步返回带 id 的消息。 */
  add: (p: {
    sessionId: string
    role: 'user' | 'assistant' | 'tool' | 'system' | 'system_notify'
    type?: 'text' | 'tool_use' | 'step_text' | 'step_thinking' | 'steer' | 'error_event'
    content: string
    metadata?: MessageMetadata | null
    model?: string
  }) => ChatMessage
  addAssistantText: (p: {
    sessionId: string
    content: string
    metadata?: MessageMetadata | null
    model: string
  }) => ChatMessage
  addToolUse: (p: {
    sessionId: string
    toolCallId: string
    toolName: string
    args?: Record<string, unknown>
    turnIndex?: number
    model: string
  }) => ChatMessage
  completeToolUse: (p: {
    messageId: string
    content: string
    isError?: boolean
    details?: ToolResultDetails
  }) => void
  addStepThinking: (p: {
    sessionId: string
    content: string
    turnIndex?: number
    model: string
  }) => ChatMessage
  addStepText: (p: {
    sessionId: string
    content: string
    turnIndex?: number
    images?: ImageMeta[]
    model: string
  }) => ChatMessage
}

// ─────────────────────────── RuntimeEventSink ───────────────────────────

export interface RuntimeEventSink {
  /** 向前端广播一个 ChatEvent */
  broadcast: (event: ChatEvent) => void
  /** 是否有任一前端声明了「能展示用户输入面板」的能力（无则 requestUserInput 立即 cancel） */
  hasUserInputCapability: (sessionId: string) => boolean
}

// ─────────────────────────── RuntimeEnv ───────────────────────────

export interface RuntimeEnv {
  /** 把内置 provider 的 apiKey 注入环境变量（桌面端写 process.env；浏览器端 no-op，凭证走 getApiKey） */
  setApiKey: (envKey: string, value: string) => void
}

// ─────────────────────────── 工具结果转换 ───────────────────────────

export interface ToolResultTransformInput {
  toolName: string
  toolCallId: string
  sessionId: string
  isError: boolean
  content: Array<{ type: string; text?: string; [k: string]: unknown }>
  details?: ToolResultDetails
}

export interface ToolResultTransformOutput {
  content: string
  details?: ToolResultDetails
}

/** 工具结果入库前的瘦身转换（如图片 → 路径提示）。浏览器宿主可用 defaultToolResultTransform。 */
export type ToolResultTransform = (input: ToolResultTransformInput) => ToolResultTransformOutput

/** 默认 passthrough：拼接文本内容，非文本块 JSON 序列化。 */
export const defaultToolResultTransform: ToolResultTransform = (input) => ({
  content:
    input.content.map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c))).join('\n') ||
    '',
  details: input.details
})

// ─────────────────────────── 事件处理依赖 ───────────────────────────

/** 可选 HTTP 请求日志（桌面端记录 LLM 请求/用量；浏览器宿主不实现） */
export interface RuntimeHttpLog {
  updateUsage: (
    logId: string,
    input: number,
    output: number,
    total: number,
    responseJson?: string
  ) => void
}

/** 事件处理所需的注入依赖（由 RuntimeSession 组装并传入 forwardAgentEvent） */
export interface RuntimeEventDeps {
  persistence: RuntimePersistence
  /** 当前会话使用的模型 id（落库标记用），随 setModel 变化 */
  getModelId: () => string
  /**
   * 并行 batch 预展示阶段是否跳过该工具。
   * 需要用户交互的工具（ask / 待审批 bash / ssh 凭证）返回 true，等真正执行流程再展示。
   */
  shouldDeferToolDisplay: (toolName: string, args: Record<string, unknown>) => boolean
  /** 工具结果入库前转换（默认 defaultToolResultTransform） */
  transformToolResult: ToolResultTransform
  /** 可选 HTTP 日志 */
  httpLog?: RuntimeHttpLog
  logger: RuntimeLogger
}
