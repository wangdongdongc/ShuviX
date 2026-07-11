import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import {
  RuntimeSession,
  generateSessionTitle,
  resolveInitialThinkingLevel
} from '@shuvix/agent-runtime'
import { messageService } from './messageService'
import { providerDao } from '../dao/providerDao'
import { sessionDao } from '../dao/sessionDao'
import { t } from '../i18n'
import { broadcastSessionTitleChanged } from '../utils/sessionConfigBroadcast'
import { buildTools, type SubAgentBuildContext } from './agentToolBuilder'
import { resolveModel } from './agentModelResolver'
import { clearSession as clearFileTimeSession } from '../utils/toolUtils/fileTime'
import { sshManager } from './sshManager'
import type {
  ModelCapabilities,
  ThinkingLevel,
  ChatMessage,
  ProjectSettings,
  ProjectPromptSection
} from '../types'
import type { SessionModelMetadata } from '../dao/types'
import { chatFrontendRegistry } from '../frontend/core'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { ToolContext } from './toolContext'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { httpLogService } from './httpLogService'
import { settingsDao } from '../dao/settingsDao'
import { renderForPrompt as renderSystemPromptSections } from './systemPrompt/systemPromptService'
import { getTempWorkspace } from '../utils/paths'
import { dbMessagesToAgentMessages } from '../utils/agentMessageConverter'
import { injectInstructionMessages } from './instruction'
import { hookService } from './hooks'
import { createLogger } from '../logger'
import {
  electronPersistence,
  electronEventSink,
  electronHttpLog,
  electronToolResultTransform,
  createShouldDeferToolDisplay,
  runtimeLogger,
  localize
} from './agentRuntimeAdapters'

const log = createLogger('AgentSession')

/** AgentSession.create 工厂参数 */
export interface AgentSessionCreateParams {
  sessionId: string
  provider: string
  model: string
  capabilities: ModelCapabilities
  project?: {
    path: string
    promptSections?: ProjectPromptSection[] | null
    settings?: ProjectSettings | null
  }
  workingDirectory: string
  enabledTools: string[]
  modelMetadata?: SessionModelMetadata
}

/** 合并系统提示词：全局自由文本 + 系统级卡片（内置 + 自定义）+ 项目段 + 项目卡片 */
export function buildSystemPrompt(
  project:
    | {
        path: string
        promptSections?: ProjectPromptSection[] | null
        settings?: ProjectSettings | null
      }
    | undefined,
  workingDirectory: string,
  sessionId: string
): string {
  const segments: string[] = []
  // 系统提示词总开关 — 关闭时跳过全局自由文本 + 内置/自定义卡片；项目级提示仍生效
  const systemPromptEnabled = settingsDao.findByKey('general.systemPromptEnabled') !== 'false'
  if (systemPromptEnabled) {
    const globalPrompt = (settingsDao.findByKey('general.systemPrompt') || '').trim()
    if (globalPrompt) segments.push(globalPrompt)

    // 系统级提示词卡片（内置 + 自定义），按代码顺序连续
    const cardsBlock = renderSystemPromptSections({
      workingDirectory: workingDirectory || project?.path
    })
    if (cardsBlock) segments.push(cardsBlock)
  }

  let prompt = segments.join('\n\n')
  if (project) {
    const workDir = workingDirectory || project.path
    prompt += `\n\nProject working directory: ${workDir}. All file tool paths are relative to this directory. Always prioritize working within this directory to complete tasks.`

    const referenceDirs = project.settings?.referenceDirs || []
    if (referenceDirs.length > 0) {
      const readonlyDirs = referenceDirs.filter((d) => (d.access ?? 'readonly') === 'readonly')
      const readwriteDirs = referenceDirs.filter((d) => d.access === 'readwrite')
      if (readonlyDirs.length > 0) {
        const lines = readonlyDirs.map((d) => (d.note ? `- ${d.path} — ${d.note}` : `- ${d.path}`))
        prompt += `\n\nReference directories (read-only, you can read files from these directories but CANNOT write or edit):\n${lines.join('\n')}`
      }
      if (readwriteDirs.length > 0) {
        const lines = readwriteDirs.map((d) => (d.note ? `- ${d.path} — ${d.note}` : `- ${d.path}`))
        prompt += `\n\nReference directories (read-write, you can read AND write files in these directories):\n${lines.join('\n')}`
      }
    }
    const envVars = project.settings?.tool?.envVars || []
    if (envVars.length > 0) {
      const names = envVars
        .filter((v) => v.key)
        .map((v) => `- ${v.key}`)
        .join('\n')
      if (names) {
        prompt += `\n\nProject environment variables (auto-injected in bash tool, do not export manually):\n${names}`
      }
    }
    if (project.promptSections && project.promptSections.length > 0) {
      for (const sec of project.promptSections) {
        const title = sec.title.trim()
        const content = sec.content.trim()
        if (!title && !content) continue
        if (title) prompt += `\n\n## ${title}\n${content}`
        else prompt += `\n\n${content}`
      }
    }
  } else {
    prompt += `\n\nWorking directory: ${getTempWorkspace(sessionId)}. Always prioritize working within this directory to complete tasks.`
  }

  // 去掉前导空行（当 globalPrompt 为空、卡片也都禁用时拼接结果可能以 \n\n 开头）
  return prompt.replace(/^\n+/, '')
}

/**
 * AgentSession — 封装单个 session 的所有 Agent 状态和操作（桌面宿主）。
 *
 * 核心循环（事件转发、流式落库、用户输入挂起、abort/steer/applyModel）委托给
 * @shuvix/agent-runtime 的 RuntimeSession；本类保留桌面特有逻辑：systemPrompt 组装、
 * 工具集（buildTools）、hooks、指令注入、generateTitle、ssh / fileTime 清理。
 *
 * 通过 AgentSession.create() 工厂方法创建。
 */
export class AgentSession {
  readonly sessionId: string

  private runtime: RuntimeSession
  private toolContext: ToolContext
  private subAgentCtx: SubAgentBuildContext | undefined
  private projectPath?: string
  private workingDirectory: string

  // ── 标题自动生成状态（两阶段：首轮快速 + 精修一次） ──
  private titleQuickDone = false // 首轮快速标题是否已生成
  private titleRefined = false // 精修是否已完成
  private lastAutoTitle: string | null = null // 最近一次自动生成的标题（用于判断用户是否手动改名）

  private constructor(
    sessionId: string,
    runtime: RuntimeSession,
    toolContext: ToolContext,
    subAgentCtx: SubAgentBuildContext | undefined,
    workingDirectory: string,
    projectPath?: string
  ) {
    this.sessionId = sessionId
    this.runtime = runtime
    this.toolContext = toolContext
    this.subAgentCtx = subAgentCtx
    this.projectPath = projectPath
    this.workingDirectory = workingDirectory
  }

  /** 工厂方法：构建完整的 AgentSession（含 Agent、工具、历史消息恢复） */
  static create(params: AgentSessionCreateParams): AgentSession {
    const {
      sessionId,
      provider,
      model,
      capabilities,
      project,
      workingDirectory,
      enabledTools,
      modelMetadata
    } = params

    // 前向引用：所有回调在 agent 执行时调用，构造期不会触发
    // eslint-disable-next-line prefer-const
    let runtime: RuntimeSession

    // 构建 ToolContext（回调通过闭包引用 runtime）
    const toolContext: ToolContext = {
      sessionId,
      requestUserInput: (request) => runtime.requestUserInput(request),
      emitChatEvent: (event) => chatFrontendRegistry.broadcast({ ...event, sessionId } as ChatEvent)
    }

    const systemPrompt = buildSystemPrompt(project, workingDirectory, sessionId)
    const resolvedModel = resolveModel({ provider, model, capabilities })

    // 子智能体上下文（使 explore 等子智能体工具可用）
    const subAgentCtx: SubAgentBuildContext = {
      modelConfig: { provider, model, capabilities }
    }
    const tools = buildTools(toolContext, enabledTools, subAgentCtx, project?.path)

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: resolvedModel,
        thinkingLevel: resolveInitialThinkingLevel({
          persisted: modelMetadata?.thinkingLevel,
          reasoning: capabilities.reasoning
        }),
        messages: [],
        tools
      },
      getApiKey: (p) => providerDao.pick(p, ['apiKey'])?.apiKey || undefined,
      onPayload: (payload, requestModel) => {
        // 用本次请求真正使用的模型对象记录日志（中途 setModel 后闭包里的 provider/model 已过期）
        const logId = httpLogService.logRequest({
          sessionId,
          provider: requestModel.provider,
          model: requestModel.id,
          payload
        })
        runtime.addPendingLogId(logId)
      }
    })

    runtime = new RuntimeSession({
      sessionId,
      agent,
      eventSink: electronEventSink,
      persistence: electronPersistence,
      shouldDeferToolDisplay: createShouldDeferToolDisplay(sessionId),
      transformToolResult: electronToolResultTransform,
      httpLog: electronHttpLog,
      logger: runtimeLogger,
      localize,
      // 统一生命周期 hook：注入完整 HookService（builtin + global/project command）；
      // SessionStart/UserPromptSubmit/Stop 由 RuntimeSession 触发（各端一致）
      hooks: hookService,
      getCwd: () => workingDirectory,
      // UserPromptSubmit 通过、正式派发前触发首轮快速标题（保持与旧行为一致的并发时序）
      onPromptAccepted: (text) => void session.maybeGenerateTitle('quick', text)
    })

    const session = new AgentSession(
      sessionId,
      runtime,
      toolContext,
      subAgentCtx,
      workingDirectory,
      project?.path
    )

    // 恢复历史消息到 Agent 上下文
    const dbMsgs = messageService.listBySession(sessionId)
    if (dbMsgs.length > 0) {
      for (const msg of dbMessagesToAgentMessages(dbMsgs)) {
        agent.state.messages.push(msg)
      }
    }

    return session
  }

  // ─── Public API ──────────────────────────────────────

  /**
   * 向 Agent 发送消息（支持附带图片）。
   *
   * SessionStart / UserPromptSubmit hook 已下沉到 RuntimeSession（各端一致）：
   * - 首轮快速标题经注入的 `onPromptAccepted` 在 UserPromptSubmit 通过后触发；
   * - hook `deny` 时 RuntimeSession 内部广播原因并跳过派发，此处 refine 因 `titleQuickDone`
   *   仍为 false 而自然跳过。
   */
  async prompt(
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  ): Promise<void> {
    log.info(
      `prompt session=${this.sessionId} text=${text.slice(0, 50)}... images=${images?.length || 0}`
    )

    await this.runtime.prompt(text, images)

    // 精修：agent 首轮回复落库后，用更完整上下文重生成一次（不 await）
    void this.maybeGenerateTitle('refine')
  }

  /**
   * 两阶段自动生成会话标题：
   *   - 'quick'  首轮：会话仍是默认标题时，用用户这条消息的意图快速生成一个粗标题
   *   - 'refine' 精修：积累到足够上下文（第 2 轮回复后）时，用整段对话重生成覆盖粗标题
   *
   * 只在标题仍是自动生成/默认值时才动手：一旦用户手动改名（title ≠ lastAutoTitle 且 ≠ 默认），
   * 或是笔记本会话（默认标题为文件名），都不覆盖。生成后落库并广播 AppEvent，各端统一刷新。
   */
  private async maybeGenerateTitle(phase: 'quick' | 'refine', userText?: string): Promise<void> {
    try {
      const session = sessionDao.pick(this.sessionId, ['title'])
      if (!session) return
      const defaultTitle = t('agent.defaultTitle')

      if (phase === 'quick') {
        if (this.titleQuickDone) return
        // 仅当标题仍是通用默认值（跳过笔记本会话的文件名标题 / 用户已改名）
        if (session.title !== defaultTitle) return
        const text = (userText ?? '').trim()
        if (!text) return
        this.titleQuickDone = true
        const title = await this.generateTitle(`User: ${text}`.slice(-1000))
        if (title) this.applyAutoTitle(title)
      } else {
        // 精修一次：需先有过快速标题，且用户未手动改名（当前标题仍是我们上次自动写入的）
        if (this.titleRefined || !this.titleQuickDone) return
        if (this.lastAutoTitle == null || session.title !== this.lastAutoTitle) return
        // 等积累到足够上下文再精修（第 2 轮回复后 user×2 + assistant×2 = 4 条文本消息）
        const msgs = messageService.listBySession(this.sessionId)
        const textMsgs = msgs.filter(
          (m) => (m.role === 'user' || m.role === 'assistant') && (m.type === 'text' || !m.type)
        )
        if (textMsgs.length < 3) return
        this.titleRefined = true
        const conversationText = textMsgs
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
          .join('\n')
          .slice(-1000)
        if (!conversationText.trim()) return
        const title = await this.generateTitle(conversationText)
        if (title) this.applyAutoTitle(title)
      }
    } catch (err) {
      log.warn(`自动标题生成失败(${phase}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 落库自动标题并广播（供各端统一刷新会话列表标题） */
  private applyAutoTitle(title: string): void {
    sessionDao.updateTitle(this.sessionId, title)
    this.lastAutoTitle = title
    broadcastSessionTitleChanged(this.sessionId, title)
  }

  // 注：hook 的 additionalContext 注入已下沉到 RuntimeSession（各端一致）。

  /**
   * 首次 prompt 前的指令懒注入。由调用方在写入用户消息**之前**调用，
   * 确保指令消息在持久化顺序和广播顺序上都早于用户消息。
   */
  ensureInstructionsInjected(): void {
    const agent = this.runtime.getAgent()
    if (agent.state.messages.length > 0) return
    const inserted = injectInstructionMessages(this.sessionId, this.workingDirectory)
    if (inserted.length === 0) return
    // 同步进 agent 内存上下文
    for (const msg of dbMessagesToAgentMessages(inserted)) {
      agent.state.messages.push(msg)
    }
    // 通知前端追加这些消息（UI 通过 InstructionBubble 渲染）
    this.runtime.broadcast({
      type: 'instructions_injected',
      sessionId: this.sessionId,
      messages: inserted.map((m) => JSON.stringify(m))
    })
  }

  /** 向运行中的 Agent 注入 steer 消息 */
  steer(text: string): void {
    this.runtime.steer(text)
  }

  /** 中止生成；Stop hook 由 RuntimeSession.abort 统一触发 */
  abort(): ChatMessage | null {
    return this.runtime.abort()
  }

  /** 切换模型（桌面：查 provider 模型能力 → resolveModel → applyModel） */
  setModel(provider: string, model: string, baseUrl?: string, apiProtocol?: string): void {
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const caps: ModelCapabilities = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}
    const resolvedModel = resolveModel({
      provider,
      model,
      capabilities: caps,
      baseUrl,
      apiProtocol
    })
    // 切模型保留当前思考深度（省略第二参 → RuntimeSession 内保持不变，思考与能力点解绑）
    this.runtime.applyModel(resolvedModel)
  }

  /** 设置思考深度 */
  setThinkingLevel(level: ThinkingLevel): void {
    this.runtime.setThinkingLevel(level)
  }

  /** 动态更新启用工具集（桌面：重新 buildTools → applyTools） */
  setEnabledTools(enabledTools: string[]): void {
    const tools = buildTools(this.toolContext, enabledTools, this.subAgentCtx, this.projectPath)
    this.runtime.applyTools(tools)
    log.info(`setEnabledTools session=${this.sessionId} tools=[${enabledTools.join(',')}]`)
  }

  /** 获取消息列表 */
  getMessages(): AgentMessage[] {
    return this.runtime.getMessages()
  }

  /** 清除消息历史 */
  clearMessages(): void {
    this.runtime.clearMessages()
  }

  /** 获取底层 Agent 实例（用于外部恢复历史消息等） */
  getAgent(): Agent {
    return this.runtime.getAgent()
  }

  /**
   * AI 生成简短标题（使用 settings 中配置的 titleProvider / titleModel）。
   */
  async generateTitle(conversationText: string): Promise<string | null> {
    const titleProvider = settingsDao.findByKey('general.titleProvider')
    const titleModelId = settingsDao.findByKey('general.titleModel')
    if (!titleProvider || !titleModelId) return null

    const providerRow = providerDao.pick(titleProvider, ['apiKey'])
    if (!providerRow?.apiKey) {
      log.warn(`标题模型 provider ${titleProvider} 无 API Key,跳过标题生成`)
      return null
    }

    try {
      const modelRow = providerDao
        .findModelsByProvider(titleProvider)
        .find((m) => m.modelId === titleModelId)
      const caps = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}
      const model = resolveModel({
        provider: titleProvider,
        model: titleModelId,
        capabilities: caps
      })
      // LLM 调用 + 解析复用共享内核（与扩展同源）
      return await generateSessionTitle({ model, apiKey: providerRow.apiKey, conversationText })
    } catch (err) {
      log.error(`生成标题失败: ${err}`)
    }
    return null
  }

  // ─── 用户输入挂起 / 响应（委托 runtime） ────────────────

  requestUserInput(request: InputRequest): Promise<InputResponse> {
    return this.runtime.requestUserInput(request)
  }

  respondToInput(requestId: string, response: InputResponse): boolean {
    return this.runtime.respondToInput(requestId, response)
  }

  // ─── 生命周期 ──────────────────────────────────────

  /** 使 Agent 失效（回退时使用，下次 init 会重建）。Stop hook 经 RuntimeSession 触发。 */
  invalidate(): void {
    this.runtime.fireStopHook('invalidated')
    this.runtime.getAgent().abort()
    clearFileTimeSession(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`invalidate session=${this.sessionId}`)
  }

  /** 完全销毁（删除会话时调用）。不 cascade 到子智能体。Stop hook 经 RuntimeSession 触发。 */
  destroy(): void {
    this.runtime.fireStopHook('destroyed')
    this.runtime.getAgent().abort()
    clearFileTimeSession(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`destroy session=${this.sessionId}`)
  }
}
