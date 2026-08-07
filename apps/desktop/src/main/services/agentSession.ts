import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import {
  HarnessSession,
  createModelsAdapter,
  generateSessionTitle,
  SessionTitler,
  resolveInitialThinkingLevel
} from '@shuvix/agent-runtime'
import { messageService } from './messageService'
import { ensureSessionTree } from './sessionStorage'
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
  ProjectPromptSection,
  AgentRuntimeInfo
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
import { resolveInstructionContent } from './instruction'
import { hookService } from './hooks'
import { createLogger } from '../logger'
import {
  electronEventSink,
  electronHttpLog,
  electronToolResultTransform,
  createShouldDeferToolDisplay,
  runtimeLogger
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
 * @shuvix/agent-runtime 的 RuntimeAgent；本类保留桌面特有逻辑：systemPrompt 组装、
 * 工具集（buildTools）、hooks、指令注入、generateTitle、ssh / fileTime 清理。
 *
 * 通过 AgentSession.create() 工厂方法创建。
 */
export class AgentSession {
  readonly sessionId: string

  private runtime: HarnessSession
  private toolContext: ToolContext
  private subAgentCtx: SubAgentBuildContext | undefined
  private projectPath?: string
  private workingDirectory: string
  /** 指令文件是否已注入当前上下文（压缩后会重新变为 false） */
  private instructionsInjected = false

  // 标题自动生成（两阶段：首轮快速 + 精修一次）—— 策略在 @shuvix/agent-runtime 与扩展端共用
  private readonly titler: SessionTitler

  private constructor(
    sessionId: string,
    runtime: HarnessSession,
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
    this.titler = new SessionTitler({
      getCurrentTitle: () => sessionDao.pick(sessionId, ['title'])?.title ?? null,
      getDefaultTitle: () => t('agent.defaultTitle'),
      listMessages: () => messageService.listBySession(sessionId),
      generate: (conversationText) => this.generateTitle(conversationText),
      // 落库 + 广播 AppEvent，各端统一刷新会话列表标题
      applyTitle: (title) => {
        sessionDao.updateTitle(sessionId, title)
        broadcastSessionTitleChanged(sessionId, title)
      },
      warn: (message) => log.warn(message)
    })
  }

  /** 工厂方法：构建完整的 AgentSession（打开会话转写文件 → 建 harness → 装工具） */
  static async create(params: AgentSessionCreateParams): Promise<AgentSession> {
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
    let runtime: HarnessSession

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

    // 会话树：pi 的 JSONL 转写文件 —— 这就是上下文的真理源，
    // 不再需要「开会话时把 DB 行重建成 AgentMessage」那一步。
    // 取的是进程内共享实例：message.list / 回滚 moveTo 等读写与 harness 同一棵树。
    const piSession = await ensureSessionTree(sessionId, workingDirectory)

    runtime = new HarnessSession({
      sessionId,
      session: piSession,
      env: new NodeExecutionEnv({ cwd: workingDirectory }),
      models: createModelsAdapter({
        getApiKey: (p) => providerDao.pick(p, ['apiKey'])?.apiKey || undefined
      }),
      model: resolvedModel,
      thinkingLevel: resolveInitialThinkingLevel({
        persisted: modelMetadata?.thinkingLevel,
        reasoning: capabilities.reasoning
      }),
      systemPrompt,
      tools,
      eventSink: electronEventSink,
      // 根会话开启自动压缩：turn 结束后上下文超阈值（窗口 - 16k）时自动滚动压缩
      autoCompact: true,
      shouldDeferToolDisplay: createShouldDeferToolDisplay(sessionId),
      transformToolResult: electronToolResultTransform,
      httpLog: electronHttpLog,
      logger: runtimeLogger,
      // 用本次请求真正使用的模型对象记录日志（中途 setModel 后闭包里的 provider/model 已过期）
      onPayload: (payload, requestModel) =>
        httpLogService.logRequest({
          sessionId,
          provider: requestModel.provider,
          model: requestModel.id,
          payload
        }),
      // 统一生命周期 hook：注入完整 HookService（builtin + global/project command）；
      // SessionStart/UserPromptSubmit/Stop 由 HarnessSession 触发（各端一致）
      hooks: hookService,
      getCwd: () => workingDirectory,
      // UserPromptSubmit 通过、正式派发前触发首轮快速标题（保持与旧行为一致的并发时序）
      onPromptAccepted: (text) => void session.titler.quick(text)
    })

    const session = new AgentSession(
      sessionId,
      runtime,
      toolContext,
      subAgentCtx,
      workingDirectory,
      project?.path
    )

    // 无需恢复历史：harness 每轮从 session.buildContext() 取上下文，
    // entry 树本身就是 AgentMessage，不存在「重建」这一步。

    return session
  }

  // ─── Public API ──────────────────────────────────────

  /**
   * 向 Agent 发送消息（支持附带图片）。
   *
   * SessionStart / UserPromptSubmit hook 已下沉到 RuntimeAgent（各端一致）：
   * - 首轮快速标题经注入的 `onPromptAccepted` 在 UserPromptSubmit 通过后触发；
   * - hook `deny` 时 RuntimeAgent 内部广播原因并跳过派发，此处 refine 因 titler 的
   *   quick 尚未完成而自然跳过。
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
    void this.titler.refine()
  }

  // 注：hook 的 additionalContext 注入已下沉到 HarnessSession（各端一致）。

  /**
   * 首次 prompt 前的指令懒注入。
   *
   * 落一条 `custom_message` entry（display=true）：既进模型上下文，又能被投影成
   * 带 isInstructionInjection 标记的 UI 消息。幂等判断改看当前上下文是否为空 ——
   * 压缩把历史滚走后上下文重新变空，指令会自动再注入一次。
   */
  async ensureInstructionsInjected(): Promise<void> {
    if (this.instructionsInjected) return
    const entries = await this.runtime.session.buildContextEntries()
    if (entries.length > 0) {
      this.instructionsInjected = true
      return
    }
    const resolved = resolveInstructionContent(this.sessionId, this.workingDirectory)
    if (!resolved) {
      this.instructionsInjected = true
      return
    }
    const msg = await this.runtime.injectInstruction(resolved.content, resolved.filename)
    this.instructionsInjected = true
    if (!msg) return
    this.runtime.broadcast({
      type: 'instructions_injected',
      sessionId: this.sessionId,
      messages: [JSON.stringify(msg)]
    })
  }

  /** 向运行中的 Agent 注入 steer 消息 */
  async steer(text: string): Promise<void> {
    await this.runtime.steer(text)
  }

  /** 本轮结束前追加消息，继续同一次运行（harness 新增能力） */
  async followUp(text: string): Promise<void> {
    await this.runtime.followUp(text)
  }

  /** 中止生成；Stop hook 由 HarnessSession.abort 统一触发 */
  async abort(): Promise<void> {
    await this.runtime.abort()
  }

  /**
   * 压缩会话历史 —— 直接调 harness 内建实现。
   *
   * 与旧的 full compaction 的差别：这是**滚动式部分压缩**，保留最近约 20k tokens 的
   * 原始消息，只把更早的历史换成摘要；且摘要由一次独立的 completeSimple 调用产出，
   * 不再需要一个持 `session` 工具的 compact 子代理。
   */
  async compact(
    customInstructions?: string
  ): Promise<{ compacted: boolean; summary?: string; tokensBefore?: number }> {
    const result = await this.runtime.compact(customInstructions)
    // 压缩后上下文被换掉，指令需要重新注入（无实质压缩时不触发）
    if (result.compacted) this.instructionsInjected = false
    return result
  }

  /** 切换模型（桌面：查 provider 模型能力 → resolveModel → applyModel） */
  async setModel(
    provider: string,
    model: string,
    baseUrl?: string,
    apiProtocol?: string
  ): Promise<void> {
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const caps: ModelCapabilities = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}
    const resolvedModel = resolveModel({
      provider,
      model,
      capabilities: caps,
      baseUrl,
      apiProtocol
    })
    // 切模型保留当前思考深度（省略第二参 → HarnessSession 内保持不变，思考与能力点解绑）
    await this.runtime.applyModel(resolvedModel)
  }

  /** 设置思考深度 */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.runtime.setThinkingLevel(level)
  }

  /** 动态更新启用工具集（桌面：重新 buildTools → applyTools） */
  async setEnabledTools(enabledTools: string[]): Promise<void> {
    const tools = buildTools(this.toolContext, enabledTools, this.subAgentCtx, this.projectPath)
    await this.runtime.applyTools(tools)
    log.info(`setEnabledTools session=${this.sessionId} tools=[${enabledTools.join(',')}]`)
  }

  /** 当前上下文对应的 UI 消息列表 */
  async listChatMessages(): Promise<ChatMessage[]> {
    return await this.runtime.listChatMessages()
  }

  /** 运行时信息快照（读 harness 状态 + session 上下文，供前端「Agent 信息」弹窗展示） */
  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return await this.runtime.getRuntimeInfo()
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

  /** 使 Agent 失效（回退时使用，下次 init 会重建）。Stop hook 经 HarnessSession 触发。 */
  invalidate(): void {
    this.runtime.fireStopHook('invalidated')
    void this.runtime.abort()
    clearFileTimeSession(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`invalidate session=${this.sessionId}`)
  }

  /** 完全销毁（删除会话时调用）。不 cascade 到子智能体。Stop hook 经 HarnessSession 触发。 */
  destroy(): void {
    this.runtime.fireStopHook('destroyed')
    void this.runtime.abort()
    clearFileTimeSession(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`destroy session=${this.sessionId}`)
  }
}
