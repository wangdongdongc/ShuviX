/**
 * @shuvix/agent-runtime 注入接口 —— 让宿主无关的编排核心脱离 Node / Electron 运行。
 *
 * 注入面：
 *  - RuntimeEventSink  事件广播（替代 chatFrontendRegistry.broadcast）
 *  - RuntimeEnv        环境变量注入（替代 process.env；浏览器宿主 no-op）
 *  - RuntimeHttpLog    LLM 请求日志（可选）
 *
 * 注：消息持久化接口（RuntimePersistence）已随 AgentHarness 迁移删除 ——
 * 落盘由 harness 经 SessionStorage 完成，宿主不再提供消息写入口。
 */
import type { ChatEvent, RuntimeStatus } from '@shuvix/chat-protocol/events'
import type {
  ChatMessage,
  MessageMetadata,
  ToolResultDetails
} from '@shuvix/chat-protocol/types/chatMessage'

export type { ChatEvent, RuntimeStatus, ChatMessage, MessageMetadata, ToolResultDetails }

/** 简单日志接口（默认 no-op；宿主可注入 electron-log / console） */
export interface RuntimeLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
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

// ─────────────────────────── RuntimeNetwork ───────────────────────────

/**
 * LLM 请求的网络侧钩子（宿主可选实现；不实现 = 完全维持原状）。
 *
 * 存在的理由是**成因在到达我们之前就被抹平了**：fetch 失败后 SDK 一律包成
 * `APIConnectionError`（文案固定 "Connection error."）或 `APIConnectionTimeoutError`
 * （"Request timed out."），真正的 `cause`（`ECONNRESET` / `UND_ERR_HEADERS_TIMEOUT` /
 * TLS / DNS…）挂在 `error.cause` 上；而 pi-ai 的 stream 在自己的 catch 里只留
 * `error.message`（anthropic-messages.js 的 `errorMessage = error.message`），
 * 到 `modelsAdapter` 时链子已经没了。所以只能在 fetch 那一层记下来，再在这一层贴回去。
 *
 * 同一个作用域还兼作「这次请求用哪套传输参数」的落点：Node 内置 fetch 的 undici
 * 默认 `headersTimeout` / `bodyTimeout` 都是 300s，对冷缓存的长上下文首字节等待
 * 明显偏紧 —— 宿主可以只对 LLM 请求换一个放宽的 dispatcher，而不动全局。
 */
export interface RuntimeNetwork {
  /** 在一次 LLM 请求的作用域内执行 fn（宿主据此换 dispatcher / 归集失败详情） */
  runInRequestScope: <T>(fn: () => T) => T
  /** 当前作用域里最近一次 fetch 失败的成因链；没失败过返回 undefined */
  describeLastFailure: () => string | undefined
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

/** 工具结果**广播前**的瘦身转换（如图片 → 占位文本）；不影响落盘与发给模型的内容。浏览器宿主可用 defaultToolResultTransform。 */
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
