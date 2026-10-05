/**
 * 会话视图（phase 3，UI 模型）—— 一条会话「现在长什么样」的完整描述，经复制状态（chord
 * `replicatedState`）同步给每个前端。**纯 JSON**（`utils/jsonOnly` 守卫），不含任何 durable 形状：
 * 前端不认识条目、文档、任务，只认识消息、正在流式的那张卡、工具进度、运行状态、队列与询问。
 *
 * 生产者：agent-runtime 的投影（`durable/projection/project.ts`，durable 会话）、冻结的旧投影
 * （`legacy` 会话，只读）与「还没有存储」的空视图（`emptySessionView`）。
 */
import type { AssistantMessage, ChatMessage, ToolResultDetails } from './chatMessage'
import type { InputRequest } from './inputRequest'

/** 视图从哪来：durable 存储 / 旧格式存储（只读）/ 还没有存储（新会话） */
export type SessionViewSource = 'durable' | 'legacy' | 'none'

/** 这条会话能做什么（按存储种类定，见决策 #10） */
export interface SessionViewCapabilities {
  send: boolean
  rollback: boolean
  continue: boolean
}

/** 运行状态：空闲 / 在跑 / 上次进程退出时在跑（等待 Continue） */
export type RunViewState = 'idle' | 'busy' | 'interrupted'

/** 重试退避（只在 busy 时给出）：第几次尝试、下一次何时发出、上一次的错误 */
export interface RunRetryView {
  attempt: number
  at: number
  error: string
}

/** 正在压缩（只在 busy 时给出）：原因、生成是否在等它、第几次尝试、退避到何时 */
export interface RunCompactingView {
  reason: string
  blocking: boolean
  attempt: number
  retryAt?: number
}

export interface RunView {
  state: RunViewState
  retry?: RunRetryView
  compacting?: RunCompactingView
}

/** 一次工具调用的实时进度（按 toolCallId 索引）；结果本身回填在消息的工具块上 */
export interface ToolRunView {
  status: 'pending' | 'running' | 'done'
  /** 运行中保留的输出（有上限） */
  output?: string
  details?: ToolResultDetails
}

/** 排队等边界的一条用户输入（系统写的通知不在其中） */
export interface QueuedInputView {
  submissionId: number
  mode: 'steer' | 'followUp'
  /** 显示文本（内联 Token 渲染成芯片文字；图片不计入） */
  text: string
  imageCount: number
}

/** 上下文占用：最后一次成功调用的 `total - output`；未知 → null */
export interface SessionContextView {
  usedTokens: number | null
}

/**
 * 正在流式的那张卡（`pi.live` 的节流中间态）。`id` = `message.id` = `'live:<taskId>'` —— 落盘之后
 * 换成条目 id；`argsText` 是还没解析完的工具参数原文（toolCallId → 片段），给协作编辑的预览用。
 */
export interface LiveCard {
  id: string
  message: AssistantMessage
  argsText?: Record<string, string>
}

export interface SessionView {
  v: 1
  sessionId: string
  source: SessionViewSource
  capabilities: SessionViewCapabilities
  /** 当前分支的对话 id；还没有存储 / 旧格式 → null */
  conversationId: number | null
  /** 已落盘的消息，旧 → 新；durable 的 id = `String(entryId)` */
  messages: ChatMessage[]
  live: LiveCard | null
  toolRuns: Record<string, ToolRunView>
  run: RunView
  queue: QueuedInputView[]
  /** 挂着的询问（任何一个前端都能答） */
  asks: InputRequest[]
  context: SessionContextView
}

/**
 * 派生 agent 的视图（子 agent 面板）：与 SessionView 同一套消息 / 实时卡 / 工具进度 / 运行状态，
 * 没有队列与询问（它们属于根会话）。`sessionId` 是根会话 id，`conversationId` 是派生 agent 的对话。
 */
export interface AgentView {
  v: 1
  agentId: string
  sessionId: string
  conversationId: number
  messages: ChatMessage[]
  live: LiveCard | null
  toolRuns: Record<string, ToolRunView>
  run: RunView
  context: SessionContextView
}

/**
 * 还没有存储的新会话的视图（`source: 'none'`）：能发第一条消息，不能回退、没有可继续的运行。
 * 每次调用都给一份新对象。
 */
export function emptySessionView(sessionId: string): SessionView {
  return {
    v: 1,
    sessionId,
    source: 'none',
    capabilities: { send: true, rollback: false, continue: false },
    conversationId: null,
    messages: [],
    live: null,
    toolRuns: {},
    run: { state: 'idle' },
    queue: [],
    asks: [],
    context: { usedTokens: null }
  }
}
