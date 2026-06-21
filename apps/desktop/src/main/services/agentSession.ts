import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import { type TextContent, completeSimple } from '@earendil-works/pi-ai'
import { RuntimeSession } from '@shuvix/agent-runtime'
import { messageService } from './messageService'
import { providerDao } from '../dao/providerDao'
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

/**
 * 标题生成 system prompt — 参考 Claude Code sessionTitle.ts 的结构化设计。
 * 不走 i18n(这是工程指令,不是用户界面文案)。
 */
const TITLE_GEN_SYSTEM_PROMPT = `Generate a concise title (3-7 words) that captures the main topic or goal of this conversation.
The title should be clear enough that the user recognizes the session in a list.

Rules:
- Use the same language as the user's message
- Use sentence case (capitalize only the first word and proper nouns)
- Return JSON with a single "title" field

Good examples:
{"title": "Fix login button on mobile"}
{"title": "调试 CI 流水线失败问题"}
{"title": "Add OAuth authentication"}
{"title": "重构 API 客户端错误处理"}

Bad (too vague): {"title": "Code changes"} {"title": "对话记录"}
Bad (too long): {"title": "Investigate and fix the issue with the login button not working on mobile devices"}`

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
function buildSystemPrompt(
  project:
    | {
        path: string
        promptSections?: ProjectPromptSection[] | null
        settings?: ProjectSettings | null
      }
    | undefined,
  workingDirectory: string,
  sessionId: string,
  modelCtx?: { modelId?: string; modelDisplayName?: string }
): string {
  const segments: string[] = []
  // 系统提示词总开关 — 关闭时跳过全局自由文本 + 内置/自定义卡片；项目级提示仍生效
  const systemPromptEnabled = settingsDao.findByKey('general.systemPromptEnabled') !== 'false'
  if (systemPromptEnabled) {
    const globalPrompt = (settingsDao.findByKey('general.systemPrompt') || '').trim()
    if (globalPrompt) segments.push(globalPrompt)

    // 系统级提示词卡片（内置 + 自定义），按代码顺序连续
    const cardsBlock = renderSystemPromptSections({
      workingDirectory: workingDirectory || project?.path,
      modelId: modelCtx?.modelId,
      modelDisplayName: modelCtx?.modelDisplayName
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

  // SessionStart hook 是否已触发（首次 prompt 时懒触发）
  private sessionStartHookFired = false

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

    const systemPrompt = buildSystemPrompt(project, workingDirectory, sessionId, {
      modelId: model
    })
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
        thinkingLevel: capabilities.reasoning
          ? (modelMetadata?.thinkingLevel as ThinkingLevel) || 'medium'
          : 'off',
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
      localize
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

  /** 向 Agent 发送消息（支持附带图片）。桌面特有：SessionStart / UserPromptSubmit hooks。 */
  async prompt(
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  ): Promise<void> {
    log.info(
      `prompt session=${this.sessionId} text=${text.slice(0, 50)}... images=${images?.length || 0}`
    )

    // ── SessionStart hook（首次 prompt 时懒触发） ──
    if (!this.sessionStartHookFired) {
      this.sessionStartHookFired = true
      try {
        const ssOutputs = await hookService.fire('SessionStart', {
          session_id: this.sessionId,
          hook_event_name: 'SessionStart',
          cwd: this.workingDirectory
        })
        this.applyAdditionalContext(ssOutputs, 'SessionStart')
      } catch (err) {
        log.warn(`SessionStart hook error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // ── UserPromptSubmit hook ──
    try {
      const upsOutputs = await hookService.fire('UserPromptSubmit', {
        session_id: this.sessionId,
        hook_event_name: 'UserPromptSubmit',
        cwd: this.workingDirectory,
        prompt: text
      })
      // deny → 丢弃本次 prompt，前端展示原因
      const denied = upsOutputs.find((o) => o.hookSpecificOutput?.permissionDecision === 'deny')
      if (denied) {
        const reason = denied.hookSpecificOutput?.reason ?? 'prompt blocked by hook'
        this.runtime.broadcast({ type: 'error', sessionId: this.sessionId, error: reason })
        return
      }
      this.applyAdditionalContext(upsOutputs, 'UserPromptSubmit')
    } catch (err) {
      log.warn(`UserPromptSubmit hook error: ${err instanceof Error ? err.message : String(err)}`)
    }

    await this.runtime.prompt(text, images)
  }

  /**
   * 把 hook 返回的 additionalContext 注入 agent 上下文。
   * 走 user-role 消息并裹 <system-reminder> 标签；不写库（会话级临时上下文）。
   * 超过 10000 字会截断。
   */
  private applyAdditionalContext(
    outputs: ReadonlyArray<{ additionalContext?: string }>,
    eventLabel: string
  ): void {
    const MAX_LEN = 10000
    const messages = this.runtime.getAgent().state.messages
    for (const out of outputs) {
      let ctx = out.additionalContext
      if (typeof ctx !== 'string' || !ctx) continue
      if (ctx.length > MAX_LEN) {
        log.warn(`${eventLabel} hook additionalContext 超过 ${MAX_LEN} 字，已截断`)
        ctx = ctx.slice(0, MAX_LEN)
      }
      const wrapped = `<system-reminder source="hook:${eventLabel}">\n${ctx}\n</system-reminder>`
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: wrapped }],
        timestamp: Date.now()
      } as AgentMessage)
    }
  }

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

  /** 中止生成；桌面特有：触发 Stop hook */
  abort(): ChatMessage | null {
    this.fireStopHook('aborted')
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
    this.runtime.applyModel(resolvedModel, caps.reasoning ? 'medium' : 'off')
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

      const result = await completeSimple(
        model,
        {
          systemPrompt: TITLE_GEN_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: conversationText }],
              timestamp: Date.now()
            }
          ]
        },
        { apiKey: providerRow.apiKey }
      )

      const raw = result.content
        ?.filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim()

      if (!raw) return null

      const stripped = raw
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/, '')
        .trim()

      // L1: 直接 parse
      try {
        const parsed = JSON.parse(stripped)
        if (typeof parsed.title === 'string' && parsed.title.trim()) {
          return parsed.title.trim().slice(0, 30)
        }
      } catch {
        /* continue to L2 */
      }

      // L2: 正则提取 {"title":"..."}
      const match = stripped.match(/\{\s*"title"\s*:\s*"([^"]*)"\s*\}/)
      if (match?.[1]?.trim()) {
        return match[1].trim().slice(0, 30)
      }

      // L3: 兜底 — 去掉引号/句号等杂物
      const fallback = stripped.replace(/^["'`]+|["'`.,。！!]+$/g, '').trim()
      return fallback.slice(0, 30) || null
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

  /** 使 Agent 失效（回退时使用，下次 init 会重建） */
  invalidate(): void {
    this.fireStopHook('invalidated')
    this.runtime.getAgent().abort()
    clearFileTimeSession(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`invalidate session=${this.sessionId}`)
  }

  /** 完全销毁（删除会话时调用）。不 cascade 到子智能体。 */
  destroy(): void {
    this.fireStopHook('destroyed')
    this.runtime.getAgent().abort()
    clearFileTimeSession(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`destroy session=${this.sessionId}`)
  }

  /** Stop hook 触发：fire-and-forget，不阻塞调用方的同步路径 */
  private fireStopHook(reason: string): void {
    void hookService
      .fire('Stop', {
        session_id: this.sessionId,
        hook_event_name: 'Stop',
        cwd: this.workingDirectory,
        reason
      })
      .catch((err) =>
        log.warn(`Stop hook error: ${err instanceof Error ? err.message : String(err)}`)
      )
  }
}
