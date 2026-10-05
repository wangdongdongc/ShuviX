/**
 * @shuvix/agent-runtime 注入接口 —— 让宿主无关的编排核心脱离 Node / Electron 运行。
 *
 * 注入面：
 *  - RuntimeEventSink  事件广播（替代 chatFrontendRegistry.broadcast）
 *  - RuntimeNetwork    LLM 请求的网络侧钩子（可选）
 *  - RuntimeLogger     日志（可选）
 *
 * 会话存储由宿主经 SessionHostDeps 打开（durable 自己落盘），宿主不提供消息写入口。旧运行时的
 * 工具结果变换（ToolResultTransform）与请求日志（RuntimeHttpLog）两个 seam 随 HarnessSession 退场。
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

// ─────────────────────────── RuntimeNetwork ───────────────────────────

/**
 * LLM 请求的网络侧钩子（宿主可选实现；不实现 = 完全维持原状）。
 *
 * 存在的理由是**成因在到达我们之前就被抹平了**：fetch 失败后 SDK 一律包成
 * `APIConnectionError`（文案固定 "Connection error."）或 `APIConnectionTimeoutError`
 * （"Request timed out."），真正的 `cause`（`ECONNRESET` / `UND_ERR_HEADERS_TIMEOUT` /
 * TLS / DNS…）挂在 `error.cause` 上；而 pi-ai 的 stream 在自己的 catch 里只留
 * `error.message`（anthropic-messages.js 的 `errorMessage = error.message`），
 * 到 Models 包装层（`models/networkModels.ts`）时链子已经没了。所以只能在 fetch 那一层记下来，再在这一层贴回去。
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
