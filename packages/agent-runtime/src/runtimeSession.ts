/**
 * RuntimeSession —— 宿主无关的 Agent 会话引擎。
 *
 * 封装单个 session 的 pi-agent-core Agent 生命周期、事件转发、流式落库与用户输入挂起。
 * 宿主（Electron / 扩展）负责：构造 Agent（initialState / tools / getApiKey / onPayload）、
 * 解析模型、组装工具、系统提示词、hooks 等，然后用本类驱动核心循环。
 *
 * 从桌面版 agentSession.ts 抽取，去掉了 hooks / 指令注入 / systemPrompt / ssh / fileTime /
 * generateTitle 等宿主特定逻辑（留在宿主 wrapper）。
 */
import { Agent, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { TextContent, ThinkingContent, ImageContent, Model, Api } from '@earendil-works/pi-ai'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { isAssistantMessage } from './messageGuards'
import {
  forwardAgentEvent,
  type SessionEventState,
  type SessionEventHandlerContext
} from './eventHandler'
import {
  defaultToolResultTransform,
  type ChatEvent,
  type ChatMessage,
  type MessageMetadata,
  type RuntimeStatus,
  type RuntimeEventSink,
  type RuntimePersistence,
  type RuntimeHttpLog,
  type RuntimeLogger,
  type ToolResultTransform,
  type RuntimeEventDeps
} from './types'

const noopLogger: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** 任意 Agent 工具数组（pi-agent-core 的 AgentState['tools']） */
type AgentTools = Agent['state']['tools']

export interface RuntimeSessionDeps {
  sessionId: string
  /** 宿主已构造好的 Agent（含 initialState / tools / getApiKey / onPayload） */
  agent: Agent
  eventSink: RuntimeEventSink
  persistence: RuntimePersistence
  /** 当前模型 id（落库标记）。默认读 agent.state.model.id */
  getModelId?: () => string
  /** batch 预展示阶段是否跳过该工具（需用户交互的工具返回 true） */
  shouldDeferToolDisplay: (toolName: string, args: Record<string, unknown>) => boolean
  /** 工具结果入库前转换。默认 defaultToolResultTransform */
  transformToolResult?: ToolResultTransform
  httpLog?: RuntimeHttpLog
  logger?: RuntimeLogger
  /** 本地化（abort 时的「工具已中止」文案）。默认返回 key */
  localize?: (key: string) => string
}

export class RuntimeSession {
  readonly sessionId: string
  protected agent: Agent
  private readonly eventSink: RuntimeEventSink
  private readonly persistence: RuntimePersistence
  private readonly logger: RuntimeLogger
  private readonly localize: (key: string) => string
  private readonly eventDeps: RuntimeEventDeps

  private pendingInputs = new Map<
    string,
    { request: InputRequest; resolve: (response: InputResponse) => void }
  >()

  private eventState: SessionEventState = {
    streamBuffer: { content: '', thinking: '', images: [] },
    turnCounter: 0,
    pendingLogIds: [],
    preEmittedToolCalls: new Set(),
    toolUseMessageIds: new Map(),
    generatingToolCall: null
  }

  private eventCtx: SessionEventHandlerContext | null = null

  constructor(deps: RuntimeSessionDeps) {
    this.sessionId = deps.sessionId
    this.agent = deps.agent
    this.eventSink = deps.eventSink
    this.persistence = deps.persistence
    this.logger = deps.logger ?? noopLogger
    this.localize = deps.localize ?? ((k) => k)
    const getModelId = deps.getModelId ?? (() => this.agent.state.model.id)
    this.eventDeps = {
      persistence: deps.persistence,
      getModelId,
      shouldDeferToolDisplay: deps.shouldDeferToolDisplay,
      transformToolResult: deps.transformToolResult ?? defaultToolResultTransform,
      httpLog: deps.httpLog,
      logger: this.logger
    }

    this.agent.subscribe((event: AgentEvent) => {
      this.forwardEvent(event)
    })
  }

  // ─── 核心 API ──────────────────────────────────────

  /** 向 Agent 发送消息（宿主特定的 hooks 由 wrapper 在调用前/后处理） */
  async prompt(
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  ): Promise<void> {
    this.logger.info(`prompt session=${this.sessionId} images=${images?.length || 0}`)
    try {
      if (images && images.length > 0) {
        await this.agent.prompt(text, images)
      } else {
        await this.agent.prompt(text)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.eventSink.broadcast({ type: 'error', sessionId: this.sessionId, error: message })
    }
  }

  /** 向运行中的 Agent 注入 steer 消息 */
  steer(text: string): void {
    this.logger.info(`steer session=${this.sessionId}`)
    const msg = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      timestamp: Date.now(),
      _isSteer: true
    }
    this.agent.steer(msg as Parameters<typeof this.agent.steer>[0])
  }

  /** 中止生成；若已有部分内容则持久化并返回 */
  abort(): ChatMessage | null {
    this.logger.info(`中止 session=${this.sessionId}`)
    this.agent.abort()
    for (const [id, pending] of this.pendingInputs) {
      pending.resolve({ kind: 'cancel', reason: 'aborted' })
      this.eventSink.broadcast({
        type: 'input_request_resolved',
        sessionId: this.sessionId,
        requestId: id
      })
    }
    this.pendingInputs.clear()
    if (this.eventState.toolUseMessageIds.size > 0) {
      const abortedContent = this.localize('agent.toolAborted')
      for (const [toolCallId, msgId] of this.eventState.toolUseMessageIds) {
        this.persistence.completeToolUse({
          messageId: msgId,
          content: abortedContent,
          isError: true
        })
        this.eventSink.broadcast({
          type: 'tool_end',
          sessionId: this.sessionId,
          toolCallId,
          toolName: '',
          result: abortedContent,
          isError: true,
          messageId: msgId
        })
      }
      this.eventState.toolUseMessageIds.clear()
      this.eventState.streamBuffer = { content: '', thinking: '', images: [] }
      return null
    }
    const buf = this.eventState.streamBuffer
    if (buf.thinking) {
      this.persistence.addStepThinking({
        sessionId: this.sessionId,
        content: buf.thinking,
        turnIndex: this.eventState.turnCounter,
        model: this.eventDeps.getModelId()
      })
      buf.thinking = ''
    }
    return this.persistStreamBuffer()
  }

  /**
   * 应用已解析的模型对象（宿主负责 provider/模型 查找与 resolveModel）。
   * thinkingLevel 省略时保留当前思考深度——切模型不重置（思考与能力点解绑）。
   */
  applyModel(model: Model<Api>, thinkingLevel?: ThinkingLevel): void {
    this.agent.state.model = model
    if (thinkingLevel !== undefined) this.agent.state.thinkingLevel = thinkingLevel
    this.logger.info(
      `切换模型 session=${this.sessionId} model=${model.id} thinking=${this.agent.state.thinkingLevel}`
    )
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.agent.state.thinkingLevel = level
    this.logger.info(`setThinkingLevel=${level}`)
  }

  /** 应用宿主重新组装的工具集 */
  applyTools(tools: AgentTools): void {
    this.agent.state.tools = tools
    this.logger.info(`applyTools session=${this.sessionId} count=${tools.length}`)
  }

  getMessages(): AgentMessage[] {
    return this.agent.state.messages
  }

  clearMessages(): void {
    this.agent.state.messages = []
  }

  getAgent(): Agent {
    return this.agent
  }

  // ─── 用户输入挂起 / 响应 ─────────────────────────────

  /** ToolContext.requestUserInput 的实现：永不超时，只由 respondToInput / abort resolve */
  requestUserInput(request: InputRequest): Promise<InputResponse> {
    if (!this.eventSink.hasUserInputCapability(this.sessionId)) {
      return Promise.resolve({ kind: 'cancel', reason: 'aborted' })
    }
    return new Promise<InputResponse>((resolve) => {
      this.pendingInputs.set(request.id, { request, resolve })
      this.eventSink.broadcast({ type: 'input_request', sessionId: this.sessionId, request })
    })
  }

  /** 响应一个挂起的用户输入请求。返回是否命中本 session 的 pending 项 */
  respondToInput(requestId: string, response: InputResponse): boolean {
    const pending = this.pendingInputs.get(requestId)
    if (!pending) return false
    this.pendingInputs.delete(requestId)
    pending.resolve(response)
    this.eventSink.broadcast({
      type: 'input_request_resolved',
      sessionId: this.sessionId,
      requestId
    })
    return true
  }

  // ─── 事件处理内部 ──────────────────────────────────

  /** 追加 pending log ID（供 onPayload 回调使用） */
  addPendingLogId(logId: string): void {
    this.eventState.pendingLogIds.push(logId)
  }

  /** 广播一个会话事件（供宿主 wrapper 复用，如注入指令、错误） */
  broadcast(event: ChatEvent): void {
    this.eventSink.broadcast(event)
  }

  emitRuntimeEvent(runtimeId: string, status: RuntimeStatus | null): void {
    this.eventSink.broadcast({
      type: 'runtime_event',
      sessionId: this.sessionId,
      runtimeId,
      status
    })
  }

  private getEventContext(): SessionEventHandlerContext {
    if (!this.eventCtx) {
      this.eventCtx = {
        sessionId: this.sessionId,
        state: this.eventState,
        broadcastEvent: (e) => this.eventSink.broadcast(e),
        persistStreamBuffer: (meta) => this.persistStreamBuffer(meta),
        emitRuntimeEvent: (runtimeId, status) => this.emitRuntimeEvent(runtimeId, status),
        deps: this.eventDeps
      }
    }
    return this.eventCtx
  }

  private forwardEvent(event: AgentEvent): void {
    forwardAgentEvent(this.getEventContext(), event)
  }

  /** 将流式缓冲区内容持久化为 assistant 消息 */
  protected persistStreamBuffer(extraMeta?: MessageMetadata): ChatMessage | null {
    const buf = this.eventState.streamBuffer
    if (!buf.content && !buf.images?.length) {
      this.eventState.streamBuffer = { content: '', thinking: '', images: [] }
      return null
    }

    const meta: MessageMetadata = { ...extraMeta }
    if (buf.images?.length) {
      meta.images = buf.images.map((img) => ({
        data: `data:${img.mimeType};base64,${img.data}`,
        mimeType: img.mimeType,
        ...(img.thoughtSignature && { thoughtSignature: img.thoughtSignature })
      }))
    }

    const msg = this.persistence.addAssistantText({
      sessionId: this.sessionId,
      content: buf.content,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
      model: this.eventDeps.getModelId()
    })

    this.appendAssistantToAgent(buf.images)
    this.eventState.streamBuffer = { content: '', thinking: '', images: [] }
    return msg
  }

  /** 将 AI 生成的图片同步到 Agent 内存上下文中的 assistant 消息 */
  private appendAssistantToAgent(
    images?: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
  ): void {
    if (!images?.length) return
    const messages = this.agent.state.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (isAssistantMessage(msg)) {
        const contentArr = msg.content as unknown as (
          | TextContent
          | ThinkingContent
          | ImageContent
        )[]
        for (const img of images) {
          contentArr.push({
            type: 'image',
            data: img.data,
            mimeType: img.mimeType,
            ...(img.thoughtSignature && { thoughtSignature: img.thoughtSignature })
          } as ImageContent)
        }
        break
      }
    }
  }
}
