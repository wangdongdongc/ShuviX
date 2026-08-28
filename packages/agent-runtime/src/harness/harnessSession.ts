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
  AgentMessage,
  AgentTool,
  ExecutionEnv,
  Session,
  SessionTreeEntry
} from '@earendil-works/pi-agent-core'
import type { Api, ImageContent, Model, Models } from '@earendil-works/pi-ai'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { elideHistoricalThinking, type ThinkingElisionState } from './thinkingElision'
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

/**
 * 一轮上下文净增的经验余量（按窗口比例）。
 *
 * pi 的 `reserveTokens` 默认 16k，恰好等于我们给模型的默认 maxTokens（见 modelResolver）——
 * 也就是阈值只够模型把自己那条回复写完，**留给本轮工具结果的余量是 0**。实测一轮
 * browser/bash 结果净增 24k，于是出现「判定时没超阈值，这一轮却在轮内冲破窗口」。
 * 轮内补救不了（pi 的 `compact()` 要求 harness 空闲），所以阈值必须提前把这部分让出来。
 * 取比例而非定值：小窗口模型不至于被一刀切掉四分之一的可用上下文。
 */
const TURN_GROWTH_RESERVE_RATIO = 0.1

/**
 * 「零内容 assistant 消息」—— provider 偶发返回的空回复（`text: ''`，output 只有 1 个 token）。
 *
 * 它有两重危害，这里只处理第二重：
 *  1. agent-loop 看它没有 toolCall，判定为终答并静默结束整轮（"continue 只跑一轮"）；
 *  2. 它带回来的 usage **不可信** —— 实测 `cacheRead` 归零、`prompt_tokens` 比真实少约 24k
 *     （系统提示词 + 工具 schema 没计进去）。而 pi 的 `estimateContextTokens` 锚定
 *     「最后一条有效 assistant 的 usage」，`stopReason` 又恰好是 'stop'（pi 只排除
 *     error/aborted），于是这条坏数据会把估算硬拽回阈值以下，压缩永不触发。
 *
 * 估算前把它剔掉，锚点自然回落到前一条真实调用上。它本身内容为空，不参与估算也不丢信息。
 */
function isZeroContentAssistant(message: AgentMessage): boolean {
  if ((message as { role?: string }).role !== 'assistant') return false
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  return content.every((block) => {
    const b = block as { type?: string; text?: string; thinking?: string }
    if (b.type === 'text') return !b.text?.trim()
    if (b.type === 'thinking') return !b.thinking?.trim()
    // toolCall / image / 其它任何块都算「有内容」
    return false
  })
}

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
   * 自动压缩：**每次 prompt 发送前 + turn 结束后**各判定一次，超过阈值
   * （contextWindow - reserveTokens，见 thresholdSettings）就执行一次滚动压缩。
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
  /** thinking 剥离边界：只增不减（压缩后由 elide 内部夹回），见 thinkingElision.ts */
  private readonly thinkingElision: ThinkingElisionState = { boundary: 0 }

  private pendingInputs = new Map<
    string,
    { request: InputRequest; resolve: (response: InputResponse) => void }
  >()
  /**
   * 中止后是否拒收新的用户输入请求（下一次 prompt 复位）。
   *
   * `abort()` 只能解掉**它看到的那一批**挂起。若某个工具恰好在这之后才发起询问，
   * 那条挂起就没人会应答了 —— 宿主的输入路由是按「当前绑定的运行时」找的，而
   * 正在关停的运行时已经不在绑定表里（见 SessionManager）。`abort()` 又要等 run 跑完，
   * 于是双方互等，会话永远停在「正在停止」。中止后直接把新请求当作已取消，堵住这个窗口。
   */
  private inputsClosed = false

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
      tools: deps.tools,
      // 队列对用户可见（输入框里的队列面板），看到几条就该一起走。
      // pi 默认的 'one-at-a-time' 会一个轮次边界只放一条，面板看着像卡住了。
      steeringMode: 'all',
      followUpMode: 'all'
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

    // payload 发出前：先剥历史 thinking，再记 HTTP 日志。
    //
    // 顺序是有意的 —— 日志该反映**实际发出去的那一份**，否则排查时会对着一份
    // 并不存在的请求找问题；顺带日志本身也小了（它按整份快照写，本来就是 O(N²)）。
    //
    // 钩子无条件注册（不再挂在 onPayload 上）：剥离与是否开日志无关。pi 的
    // emitBeforeProviderPayload 是变换链，返回值会替换 payload，这是它支持的用法。
    const record = deps.onPayload
    this.harness.on('before_provider_payload', async (event) => {
      const payload = this.applyThinkingElision(event.payload)
      if (record) {
        const logId = record(payload, event.model as Model<Api>)
        if (logId) this.eventState.pendingLogIds.push(logId)
      }
      return { payload }
    })
  }

  /**
   * 剥掉已完成轮次的 thinking（见 thinkingElision.ts）。
   *
   * 边界跨调用持有在 this.thinkingElision 上，只在累计 thinking 越过上沿时跳一次；
   * 两次跳跃之间输出逐字节稳定，缓存前缀不受影响。形状对不上就原样放行 —— 这是
   * 省钱的优化，不该有能力让一个请求发不出去。
   */
  private applyThinkingElision(payload: unknown): unknown {
    const p = payload as { messages?: unknown } | null
    if (!p || !Array.isArray(p.messages)) return payload
    try {
      const r = elideHistoricalThinking(p.messages, this.thinkingElision)
      this.thinkingElision.boundary = r.boundary
      if (!r.advanced && r.elidedBlocks === 0) return payload
      this.logger.info(
        `thinkingElision session=${this.sessionId} boundary=${r.boundary} ` +
          `elided=${r.elidedBlocks} blocks ~${r.elidedTokens} tok`
      )
      return { ...p, messages: r.messages }
    } catch (err) {
      this.logger.warn(
        `thinkingElision skipped — ${err instanceof Error ? err.message : String(err)}`
      )
      return payload
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
    // 新一轮开始：恢复受理用户输入（上一次 abort 关掉的）
    this.inputsClosed = false

    // 发送前判定。轮后那次判定救不了两种情况：
    //  a. 上一轮在**轮内**就把上下文顶爆了（轮内无法压缩，pi 的 compact() 要求 harness 空闲），
    //     而轮末那条消息未必反映真实体量；
    //  b. 重启/重新打开恢复出的会话，第一发请求从未过秤。
    // 两种都会让这一发请求直接撞窗口，所以出门前必须再称一次。
    if (this.autoCompactEnabled) {
      this.maintenance = this.maybeAutoCompact('发送前')
      await this.maintenance
    }

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
      this.maintenance = this.maybeAutoCompact('轮结束')
      await this.maintenance
    }
    return {}
  }

  /**
   * 本次判定用的阈值设置：在 pi 默认值之上，把「模型输出 + 一轮工具结果」的余量让出来。
   *
   * **只影响「何时压」，不影响「怎么压」** —— `harness.compact()` 内部写死用 pi 的
   * `DEFAULT_COMPACTION_SETTINGS`（保留最近 keepRecentTokens=20k），我们改不了，
   * 所以 `compact()` 里的前置判定也必须继续用 pi 的默认值，否则两边会不一致。
   */
  private thresholdSettings(contextWindow: number): typeof DEFAULT_COMPACTION_SETTINGS {
    const maxTokens = this.harness.getModel().maxTokens || 0
    return {
      ...DEFAULT_COMPACTION_SETTINGS,
      reserveTokens: Math.max(
        DEFAULT_COMPACTION_SETTINGS.reserveTokens,
        maxTokens + Math.round(contextWindow * TURN_GROWTH_RESERVE_RATIO)
      )
    }
  }

  /**
   * 阈值判定 + 自动压缩（绝不抛出）。
   *
   * 判定输入：`session.buildContext()`（已应用压缩过滤 = 模型真实所见），**剔除零内容
   * assistant 消息**后交给 pi 的 `estimateContextTokens` —— 它锚定最近一条 assistant 的
   * provider 真实 usage、其后的尾部才用字符启发式补估，而空回复带回来的 usage 是坏数据
   * （见 isZeroContentAssistant）。阈值是 pi 的 `shouldCompact`，reserve 见 thresholdSettings。
   *
   * 压缩成功后广播 messages_reloaded 让前端重拉 —— 被压缩掉的历史随之从
   * 消息列表消失（`buildContextEntries` 自带压缩过滤），原地换成摘要卡片。
   */
  private async maybeAutoCompact(stage: '发送前' | '轮结束'): Promise<void> {
    try {
      const contextWindow = this.harness.getModel().contextWindow
      if (!contextWindow || contextWindow <= 0) return
      const context = await this.session.buildContext()
      const estimate = estimateContextTokens(
        context.messages.filter((m) => !isZeroContentAssistant(m))
      )
      const settings = this.thresholdSettings(contextWindow)
      if (!shouldCompact(estimate.tokens, contextWindow, settings)) return

      this.logger.info(
        `自动压缩(${stage}) session=${this.sessionId} tokens≈${estimate.tokens} ` +
          `window=${contextWindow} reserve=${settings.reserveTokens}`
      )
      if (!(await this.compact())) return
      this.eventSink.broadcast({ type: 'messages_reloaded', sessionId: this.sessionId })
    } catch (err) {
      // 自动压缩失败不影响已成功的 turn：记日志，下轮阈值仍超会再试
      this.logger.warn(`自动压缩失败 session=${this.sessionId}: ${errText(err)}`)
    }
  }

  /**
   * 送达一条系统侧通知（后台任务完成等）——「运行中就即刻插话，空闲就搭下一条消息的便车」。
   *
   * pi 的两条队列刚好覆盖这两种情形，无需自建队列：
   *   - `steer`：运行中把消息注入当前 run；**空闲时抛 `invalid_state`**。
   *   - `nextTurn`：无 idle 守卫，排队等下一轮 —— `executeTurn` 会把它前置到用户消息之前。
   *
   * harness 的 phase 是私有的，判不了状态，所以只能先试 steer、失败再退到 nextTurn。
   */
  async notify(text: string): Promise<void> {
    try {
      await this.harness.steer(text)
      this.logger.info(`notify(steer) session=${this.sessionId}`)
    } catch {
      // 空闲（invalid_state）—— 也可能是 steer 的 hook 出错；两种都退到下一轮送达，
      // 通知丢了比把它硬塞进一个不接受插话的状态要好
      await this.harness.nextTurn(text)
      this.logger.info(`notify(nextTurn) session=${this.sessionId}`)
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
    this.inputsClosed = true
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

  /**
   * pi 原生的 `AgentHarness`。
   *
   * 给运行时注册中心（`runtimeRegistry.ts`）用 —— 监控数据一律从 pi 自己的读取面与
   * 事件流取，本类不再为监控增设手工快照字段。命名点出"这是 pi 的对象"，提醒调用方
   * 它是**可变**的：读可以，改运行时配置请走本类的 applyModel/applyTools 等入口，
   * 否则绕过日志与事件翻译。
   */
  get piHarness(): AgentHarness {
    return this.harness
  }

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
    // 中止之后到下一次 prompt 之前：不再受理新的询问（见 inputsClosed）
    if (this.inputsClosed || !this.eventSink.hasUserInputCapability(this.sessionId)) {
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
