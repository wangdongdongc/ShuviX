/**
 * HarnessSession —— 宿主无关的会话运行时，取代 RuntimeAgent。
 *
 * 相对 RuntimeAgent 的核心差异：
 *  1. **不再持有 `agent.state.messages`**。上下文的真理源是 `Session` entry 树，
 *     harness 每轮从 `session.buildContext()` 取消息；「开会话时把 DB 行重建成
 *     AgentMessage」那条有损路径彻底消失。
 *  2. **不再持久化**。message/toolResult entry 由 harness 自己 append，
 *     本类只负责事件翻译和用户输入挂起。
 *  3. 新增 harness 白拿的能力：自动压缩 / `followUp()` / `nextTurn()` / `navigateTree()`。
 *
 * 询问下沉：路径/命令询问改挂 harness 的 `tool_call` 钩子（返回 `{block, reason}`），
 * 工具实现不再需要自己调 assertReadAllowed —— 见 `askHook`。
 */
import {
  AgentHarness,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact
} from '@earendil-works/pi-agent-core'
import type {
  AgentTool,
  ExecutionEnv,
  Session,
  SessionTreeEntry
} from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, Model, Models } from '@earendil-works/pi-ai'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import {
  INLINE_TOKENS_CUSTOM_TYPE,
  entriesToChatMessages,
  type InlineTokensSidecar
} from './projection'
import {
  createHarnessEventState,
  forwardHarnessEvent,
  type HarnessEventContext,
  type HarnessEventState
} from './eventHandler'
import {
  defaultToolResultTransform,
  type ChatEvent,
  type ChatMessage,
  type RuntimeEventSink,
  type RuntimeHttpLog,
  type RuntimeLogger,
  type RuntimeStatus,
  type ToolResultTransform
} from '../types'

const noopLogger: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} }

/** 工具调用拦截结果：block=true 时 harness 不执行该工具，改回一条错误 tool result */
export type ToolCallGate = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<{ block?: boolean; reason?: string } | undefined>

export interface HarnessSessionDeps {
  sessionId: string
  /** entry 树存储（桌面 = SqliteSessionStorage，扩展 = IndexedDB 实现） */
  session: Session
  /** 文件/命令执行环境（桌面 = NodeExecutionEnv） */
  env: ExecutionEnv
  models: Models
  model: Model<Api>
  thinkingLevel?: ThinkingLevel
  systemPrompt: string
  tools: AgentTool[]
  eventSink: RuntimeEventSink
  logger?: RuntimeLogger
  httpLog?: RuntimeHttpLog
  transformToolResult?: ToolResultTransform
  /** 工具执行前拦截（询问）。不注入 = 全部放行。 */
  toolCallGate?: ToolCallGate
  onPromptAccepted?: (text: string) => void
  /** onPayload 记录 HTTP 日志后回传 logId */
  onPayload?: (payload: unknown, model: Model<Api>) => string | undefined
  /** user 消息落盘后是否自动广播 user_message（默认 true；派生 agent 关掉，见 HarnessEventDeps） */
  broadcastUserMessages?: boolean
  /**
   * 自动压缩：turn 成功结束后，若上下文超过 pi 的压缩阈值
   * （contextWindow - reserveTokens），自动执行一次滚动压缩。
   * 默认关（根会话开启；派生 agent 生命周期短且面板为纯事件驱动，暂不开）。
   */
  autoCompact?: boolean
}

export class HarnessSession {
  readonly sessionId: string
  readonly session: Session
  private readonly harness: AgentHarness
  private readonly eventSink: RuntimeEventSink
  private readonly logger: RuntimeLogger
  private readonly onPromptAccepted?: (text: string) => void
  private systemPrompt: string
  private streaming = false
  private readonly autoCompactEnabled: boolean
  /**
   * turn 后台维护（自动压缩）的串行栅栏：压缩期间 harness 相位为 'compaction'，
   * 此时新 prompt 会被 pi 拒 busy —— prompt 入口先等它完成。永不 reject。
   */
  private maintenance: Promise<void> = Promise.resolve()
  private readonly eventState: HarnessEventState = createHarnessEventState()

  private pendingInputs = new Map<
    string,
    { request: InputRequest; resolve: (response: InputResponse) => void }
  >()

  constructor(deps: HarnessSessionDeps) {
    this.sessionId = deps.sessionId
    this.session = deps.session
    this.eventSink = deps.eventSink
    this.logger = deps.logger ?? noopLogger
    this.onPromptAccepted = deps.onPromptAccepted
    this.systemPrompt = deps.systemPrompt
    this.autoCompactEnabled = deps.autoCompact ?? false

    this.harness = new AgentHarness({
      env: deps.env,
      session: deps.session,
      models: deps.models,
      model: deps.model,
      thinkingLevel: deps.thinkingLevel,
      systemPrompt: () => this.systemPrompt,
      tools: deps.tools
    })

    const eventCtx: HarnessEventContext = {
      sessionId: this.sessionId,
      session: deps.session,
      state: this.eventState,
      broadcast: (e) => this.eventSink.broadcast(e),
      deps: {
        logger: this.logger,
        httpLog: deps.httpLog,
        getModelId: () => this.harness.getModel().id,
        transformToolResult: deps.transformToolResult ?? defaultToolResultTransform,
        broadcastUserMessages: deps.broadcastUserMessages
      }
    }

    this.harness.subscribe(async (event) => {
      if (event.type === 'agent_start') this.streaming = true
      if (event.type === 'agent_end') this.streaming = false
      await forwardHarnessEvent(eventCtx, event)
    })

    // 询问：工具执行前统一拦截。工具实现不再感知询问的存在。
    if (deps.toolCallGate) {
      const gate = deps.toolCallGate
      this.harness.on('tool_call', async (event) => {
        return await gate(event.toolName, event.input || {})
      })
    }

    // HTTP 日志：payload 发出前记录，用量在 message_end 回填
    if (deps.onPayload) {
      const record = deps.onPayload
      this.harness.on('before_provider_payload', async (event) => {
        const logId = record(event.payload, event.model as Model<Api>)
        if (logId) this.eventState.pendingLogIds.push(logId)
        return { payload: event.payload }
      })
    }
  }

  // ─── 核心 API ──────────────────────────────────────

  /**
   * 发送一轮 prompt。
   *
   * `display`：内联 Token 显示侧车（标记态原文 + tokens 字典）。harness 落盘的
   * user 消息是展开后的全文（LLM 真理源）；侧车以纯 custom entry 落在它之前，
   * 只供投影层把气泡还原成芯片形态 —— 见 INLINE_TOKENS_CUSTOM_TYPE。
   *
   * 错误不抛出（已广播 error 事件），但经返回值回报 —— 派生 agent 协调器需要它
   * 判定本轮成败；会话根调用方可忽略返回值。
   */
  async prompt(
    text: string,
    images?: ImageContent[],
    display?: InlineTokensSidecar
  ): Promise<{ error?: string }> {
    this.logger.info(`prompt session=${this.sessionId} images=${images?.length || 0}`)
    // 上一轮的自动压缩可能还在跑（harness 相位 'compaction' 会拒 prompt）—— 等它收尾
    await this.maintenance

    this.onPromptAccepted?.(text)

    try {
      // 显示侧车先于 user 消息落盘
      if (display) {
        await this.session.appendCustomEntry(INLINE_TOKENS_CUSTOM_TYPE, display)
      }
      await this.harness.prompt(text, images ? { images } : undefined)
    } catch (err) {
      const error = errText(err)
      this.eventSink.broadcast({ type: 'error', sessionId: this.sessionId, error })
      return { error }
    }

    // turn 成功收尾后判定自动压缩。放在 prompt 内 await（而非 fire-and-forget）：
    // 调用方（IPC/派生协调器）本就等待整轮完成，这里多等几秒不改变语义；
    // 期间到达的新 prompt 由入口的 maintenance 栅栏排队。
    if (this.autoCompactEnabled) {
      this.maintenance = this.maybeAutoCompact()
      await this.maintenance
    }
    return {}
  }

  /**
   * 阈值判定 + 自动压缩（绝不抛出）。
   *
   * 判定输入：`session.buildContext()`（已应用压缩过滤 = 模型真实所见）；
   * token 数优先取最近一条 assistant 的 provider 真实 usage（pi 的
   * `estimateContextTokens`），其后的尾部才用字符启发式补估。
   * 阈值即 pi 的 `shouldCompact`：tokens > contextWindow - reserveTokens(16k)。
   *
   * 压缩成功后广播 messages_reloaded 让前端重拉 —— 被压缩掉的历史随之从
   * 消息列表消失（`buildContextEntries` 自带压缩过滤），原地换成摘要卡片。
   */
  private async maybeAutoCompact(): Promise<void> {
    try {
      const contextWindow = this.harness.getModel().contextWindow
      if (!contextWindow || contextWindow <= 0) return
      const context = await this.session.buildContext()
      const estimate = estimateContextTokens(context.messages)
      if (!shouldCompact(estimate.tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)) return

      this.logger.info(
        `自动压缩 session=${this.sessionId} tokens≈${estimate.tokens} window=${contextWindow}`
      )
      if (!(await this.compact())) return
      this.eventSink.broadcast({ type: 'messages_reloaded', sessionId: this.sessionId })
    } catch (err) {
      // 自动压缩失败不影响已成功的 turn：记日志，下轮阈值仍超会再试
      this.logger.warn(`自动压缩失败 session=${this.sessionId}: ${errText(err)}`)
    }
  }

  /** 运行中注入引导消息（harness 的 steer 队列） */
  async steer(text: string): Promise<void> {
    this.logger.info(`steer session=${this.sessionId}`)
    await this.harness.steer(text)
  }

  /** 本轮结束前追加消息，继续同一次 run（harness 新增能力） */
  async followUp(text: string): Promise<void> {
    await this.harness.followUp(text)
  }

  /** 排队到下一轮 prompt 前置（harness 新增能力） */
  async nextTurn(text: string): Promise<void> {
    await this.harness.nextTurn(text)
  }

  /**
   * 中止生成。
   *
   * 旧实现要在这里手工把 streamBuffer 落库、把未完成的 tool_use 打成「已中止」；
   * 现在 harness 会把带 stopReason='aborted' 的部分消息正常 append 进 entry 树，
   * 所以这里只剩「解挂起的用户输入」这一件事。
   */
  async abort(): Promise<void> {
    this.logger.info(`中止 session=${this.sessionId}`)
    for (const [id, pending] of this.pendingInputs) {
      pending.resolve({ kind: 'cancel', reason: 'aborted' })
      this.eventSink.broadcast({
        type: 'input_request_resolved',
        sessionId: this.sessionId,
        requestId: id
      })
    }
    this.pendingInputs.clear()
    await this.harness.abort()
  }

  /**
   * 压缩会话历史（harness 内建的滚动式部分压缩：保留最近 keepRecentTokens 的原始
   * 消息，只把更早的历史换成摘要）。仅 `maybeAutoCompact` 调用 —— 手动压缩入口已移除。
   *
   * 前置判定：上下文小于保留窗口时切点落在第一条消息上、待摘要区间为空 ——
   * pi 的 `harness.compact()` 会照样调一次 LLM 对空对话生成摘要并追加一条无意义的
   * compaction entry（且下一次 compact 会因"最后一条已是 compaction"抛
   * "Nothing to compact"）。这里提前用同一套 `prepareCompaction` 判定，
   * 无实质可压缩内容时返回 false，不触碰 LLM 也不动会话树。
   */
  private async compact(): Promise<boolean> {
    const branch = await this.session.getBranch()
    const prepared = prepareCompaction(branch, DEFAULT_COMPACTION_SETTINGS)
    const preparation = prepared.ok ? prepared.value : undefined
    if (
      !preparation ||
      (preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0)
    ) {
      return false
    }
    await this.harness.compact()
    return true
  }

  // ─── 运行时配置 ────────────────────────────────────

  async applyModel(model: Model<Api>, thinkingLevel?: ThinkingLevel): Promise<void> {
    await this.harness.setModel(model)
    if (thinkingLevel !== undefined) await this.harness.setThinkingLevel(thinkingLevel)
    this.logger.info(`切换模型 session=${this.sessionId} model=${model.id}`)
  }

  /** 当前思考深度（派发工具的惰性模型配置读取用） */
  getThinkingLevel(): ThinkingLevel {
    return this.harness.getThinkingLevel() as ThinkingLevel
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.harness.setThinkingLevel(level)
  }

  async applyTools(tools: AgentTool[]): Promise<void> {
    await this.harness.setTools(tools)
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
  }

  // ─── 读取 ──────────────────────────────────────────

  /** 会话当前上下文对应的 UI 消息列表（替代旧的 messageService.listBySession） */
  async listChatMessages(): Promise<ChatMessage[]> {
    const entries = await this.session.buildContextEntries()
    return entriesToChatMessages(entries, this.sessionId, this.harness.getModel().id)
  }

  /** 全部 entry（含被压缩掉的历史）—— 归档查看用 */
  async listAllEntries(): Promise<SessionTreeEntry[]> {
    return await this.session.getEntries()
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const model = this.harness.getModel()
    const context = await this.session.buildContext()
    return {
      systemPrompt: this.systemPrompt,
      model: {
        provider: model.provider,
        id: model.id,
        name: model.name,
        api: model.api,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        input: [...model.input]
      },
      thinkingLevel: this.harness.getThinkingLevel() as ThinkingLevel,
      tools: this.harness.getTools().map((tool) => ({
        name: tool.name,
        label: (tool as { label?: string }).label ?? tool.name,
        description: tool.description,
        parameters: Object.keys(
          (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ??
            {}
        )
      })),
      messageCount: context.messages.length,
      isStreaming: this.streaming
    }
  }

  // ─── 用户输入挂起 ──────────────────────────────────

  requestUserInput(request: InputRequest): Promise<InputResponse> {
    if (!this.eventSink.hasUserInputCapability(this.sessionId)) {
      return Promise.resolve({ kind: 'cancel', reason: 'aborted' })
    }
    return new Promise<InputResponse>((resolve) => {
      this.pendingInputs.set(request.id, { request, resolve })
      this.eventSink.broadcast({ type: 'input_request', sessionId: this.sessionId, request })
    })
  }

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
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
