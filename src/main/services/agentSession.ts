import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core'
import {
  type TextContent,
  type ThinkingContent,
  type ImageContent,
  completeSimple
} from '@mariozechner/pi-ai'
import { messageService } from './messageService'
import { providerDao } from '../dao/providerDao'
import { sessionDao } from '../dao/sessionDao'
import { buildTools, type SubAgentBuildContext } from './agentToolBuilder'
import { resolveModel } from './agentModelResolver'
import { clearSession as clearFileTimeSession } from '../utils/toolUtils/fileTime'
import { dockerManager } from './dockerManager'
import { sshManager } from './sshManager'
import type {
  ModelCapabilities,
  ThinkingLevel,
  Message,
  MessageMetadata,
  ProjectSettings,
  ProjectPromptSection
} from '../types'
import type { SessionModelMetadata } from '../dao/types'
import { t } from '../i18n'
import {
  forwardAgentEvent,
  type SessionEventState,
  type SessionEventHandlerContext
} from './agentEventHandler'
import { isAssistantMessage } from '../utils/messageGuards'
import { chatFrontendRegistry } from '../frontend/core'
import type { ChatEvent, RuntimeStatus } from '../frontend/core/types'
import type { ToolContext } from './toolContext'
import type { InputRequest, InputResponse } from '../../shared/types/inputRequest'
import { httpLogService } from './httpLogService'
import { settingsDao } from '../dao/settingsDao'
import { getTempWorkspace } from '../utils/paths'
import { dbMessagesToAgentMessages } from '../utils/agentMessageConverter'
import { injectInstructionMessages } from './instruction'
import { createLogger } from '../logger'

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

/** 合并系统提示词：全局 + 项目级 + 参考目录 + 工作目录 */
function buildSystemPrompt(
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
  const globalPrompt = settingsDao.findByKey('systemPrompt') || ''
  let prompt = globalPrompt
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

  return prompt
}

/**
 * AgentSession — 封装单个 session 的所有 Agent 状态和操作
 * 通过 AgentSession.create() 工厂方法创建
 */
export class AgentSession {
  readonly sessionId: string

  // 核心
  private agent: Agent
  private toolContext: ToolContext
  private subAgentCtx: SubAgentBuildContext | undefined
  private projectPath?: string
  private workingDirectory: string

  /**
   * 统一的"等待用户输入"挂起表(keyed by request.id == toolCallId)
   * - 命令审批 / 选择题 / SSH 凭证全部走这一张表
   * - 永不超时,只能由 respondToInput / abort 触发 resolve
   */
  private pendingInputs = new Map<
    string,
    { request: InputRequest; resolve: (response: InputResponse) => void }
  >()

  // 事件状态（可变引用，传给 event handler）
  private eventState: SessionEventState = {
    streamBuffer: { content: '', thinking: '', images: [] },
    turnCounter: 0,
    pendingLogIds: [],
    preEmittedToolCalls: new Set(),
    toolUseMessageIds: new Map(),
    generatingToolCall: null
  }

  // 缓存的事件处理器上下文
  private eventCtx: SessionEventHandlerContext | null = null

  private constructor(
    sessionId: string,
    agent: Agent,
    toolContext: ToolContext,
    subAgentCtx: SubAgentBuildContext | undefined,
    workingDirectory: string,
    projectPath?: string
  ) {
    this.sessionId = sessionId
    this.agent = agent
    this.toolContext = toolContext
    this.subAgentCtx = subAgentCtx
    this.projectPath = projectPath
    this.workingDirectory = workingDirectory

    // 订阅 Agent 事件，转发到 Renderer
    this.agent.subscribe((event: AgentEvent) => {
      this.forwardEvent(event)
    })
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
    let session: AgentSession

    // 构建 ToolContext（回调通过闭包引用 session）
    const toolContext: ToolContext = {
      sessionId,
      requestUserInput: (request) => session.requestUserInput(request),
      emitChatEvent: (event) => chatFrontendRegistry.broadcast({ ...event, sessionId } as ChatEvent)
    }

    const systemPrompt = buildSystemPrompt(project, workingDirectory, sessionId)
    const resolvedModel = resolveModel({ provider, model, capabilities })

    // 构建子智能体上下文（使 explore 等子智能体工具可用）
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
      onPayload: (payload) => {
        const logId = httpLogService.logRequest({ sessionId, provider, model, payload })
        session.addPendingLogId(logId)
      }
    })

    session = new AgentSession(
      sessionId,
      agent,
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

  /** 向 Agent 发送消息（支持附带图片） */
  async prompt(
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  ): Promise<void> {
    log.info(
      `prompt session=${this.sessionId} text=${text.slice(0, 50)}... images=${images?.length || 0}`
    )
    try {
      if (images && images.length > 0) {
        await this.agent.prompt(text, images)
      } else {
        await this.agent.prompt(text)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      chatFrontendRegistry.broadcast({ type: 'error', sessionId: this.sessionId, error: message })
    }
  }

  /**
   * 首次 prompt 前的指令懒注入。
   * 由调用方（DefaultChatGateway）在写入用户消息**之前**调用，
   * 确保指令消息在持久化顺序和广播顺序上都早于用户消息。
   */
  ensureInstructionsInjected(): void {
    if (this.agent.state.messages.length > 0) return
    const inserted = injectInstructionMessages(this.sessionId, this.workingDirectory)
    if (inserted.length === 0) return
    // 同步进 agent 内存上下文
    for (const msg of dbMessagesToAgentMessages(inserted)) {
      this.agent.state.messages.push(msg)
    }
    // 通知前端追加这些消息（UI 通过 InstructionBubble 渲染）
    chatFrontendRegistry.broadcast({
      type: 'instructions_injected',
      sessionId: this.sessionId,
      messages: inserted.map((m) => JSON.stringify(m))
    })
  }

  /** 向运行中的 Agent 注入 steer 消息（同步入队，下次 LLM 调用前生效） */
  steer(text: string): void {
    log.info(`steer session=${this.sessionId} text=${text.slice(0, 50)}...`)
    // _isSteer 标记用于 agentEventHandler 区分 steer 消息与初始 prompt
    // pi-agent-core 会透传完整对象到 message_start/message_end 事件
    const msg = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      timestamp: Date.now(),
      _isSteer: true
    }
    this.agent.steer(msg as Parameters<typeof this.agent.steer>[0])
  }

  /** 中止生成；若已有部分内容则持久化并返回
   *
   *  注：不 cascade 到子智能体。子智能体视为独立的临时会话，
   *  父会话的中止/销毁不影响已启动的子 agent —— 只有用户在右侧
   *  Sub-agent 面板上手动关闭，或 IPC subSession:destroy 才会销毁它们。
   */
  abort(): Message | null {
    log.info(`中止 session=${this.sessionId}`)
    this.agent.abort()
    // 只取消本 session 的 pending 项 — 全部 resolve 为 cancel(reason=aborted)
    for (const [id, pending] of this.pendingInputs) {
      pending.resolve({ kind: 'cancel', reason: 'aborted' })
      chatFrontendRegistry.broadcast({
        type: 'input_request_resolved',
        sessionId: this.sessionId,
        requestId: id
      })
    }
    this.pendingInputs.clear()
    // 标记所有未完成的工具调用为已中止
    if (this.eventState.toolUseMessageIds.size > 0) {
      const abortedContent = t('agent.toolAborted')
      for (const [toolCallId, msgId] of this.eventState.toolUseMessageIds) {
        messageService.completeToolUse({
          messageId: msgId,
          content: abortedContent,
          isError: true
        })
        chatFrontendRegistry.broadcast({
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
    // 中止时将 thinking 独立落库为 step_thinking
    const buf = this.eventState.streamBuffer
    if (buf.thinking) {
      const session = sessionDao.pick(this.sessionId, ['model'])
      messageService.addStepThinking({
        sessionId: this.sessionId,
        content: buf.thinking,
        turnIndex: this.eventState.turnCounter,
        model: session?.model || ''
      })
      buf.thinking = ''
    }
    return this.persistStreamBuffer()
  }

  /** 切换模型 */
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
    this.agent.setModel(resolvedModel)
    this.agent.setThinkingLevel(caps.reasoning ? 'medium' : 'off')
    log.info(
      `切换模型 session=${this.sessionId} provider=${provider} model=${model} reasoning=${caps.reasoning ? 'medium' : 'off'}`
    )
  }

  /** 设置思考深度 */
  setThinkingLevel(level: ThinkingLevel): void {
    this.agent.setThinkingLevel(level)
    log.info(`setThinkingLevel=${level}`)
  }

  /** 动态更新启用工具集 */
  setEnabledTools(enabledTools: string[]): void {
    const tools = buildTools(this.toolContext, enabledTools, this.subAgentCtx, this.projectPath)
    this.agent.setTools(tools)
    log.info(`setEnabledTools session=${this.sessionId} tools=[${enabledTools.join(',')}]`)
  }

  /** 获取消息列表 */
  getMessages(): AgentMessage[] {
    return this.agent.state.messages
  }

  /** 清除消息历史 */
  clearMessages(): void {
    this.agent.state.messages = []
  }

  /** 获取底层 Agent 实例（用于外部恢复历史消息等） */
  getAgent(): Agent {
    return this.agent
  }

  /**
   * AI 生成简短标题。
   *
   * - 使用 settings 中用户配置的 titleProvider / titleModel(而非当前会话模型),
   *   未配置时返回 null(不生成)
   * - Prompt 参考 Claude Code:JSON 输出 + good/bad 示例 + 语言自适应
   * - conversationText 是全部消息的最后 1000 字符(由调用方拼接传入)
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

      // 三层 fallback 提取 title:
      // 1. 直接 JSON.parse(strip code fence 后)
      // 2. 正则匹配 {"title":"..."} 片段(应对模型在 JSON 前后加了多余文字)
      // 3. 直接用原始文本(去掉引号/句号等杂物)
      //
      // Claude Code 通过 API output_config.json_schema 强制 JSON 输出,
      // pi-ai 不支持该参数,所以必须在应用层清洗
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

      // L3: 最后兜底 — 去掉引号/句号等杂物,取前 30 字
      const fallback = stripped.replace(/^["'`]+|["'`.,。！!]+$/g, '').trim()
      return fallback.slice(0, 30) || null
    } catch (err) {
      log.error(`生成标题失败: ${err}`)
    }
    return null
  }

  // ─── 用户输入挂起 / 响应 ─────────────────────────────

  /**
   * 统一的"请求用户输入"入口(ToolContext.requestUserInput 的实现)。
   * 永不超时;只能由 respondToInput 或 abort 触发 resolve。
   *
   * 若没有任何前端声明 'userInput' 能力(罕见,如纯自动化场景),
   * 立即返回 cancel,工具据此报错或降级。
   */
  requestUserInput(request: InputRequest): Promise<InputResponse> {
    if (!chatFrontendRegistry.hasCapability(this.sessionId, 'userInput')) {
      // 没有任何前端能展示输入面板 → 复用 abort 路径,工具按"中断"处理
      return Promise.resolve({
        kind: 'cancel',
        reason: 'aborted'
      })
    }
    return new Promise<InputResponse>((resolve) => {
      this.pendingInputs.set(request.id, { request, resolve })
      chatFrontendRegistry.broadcast({
        type: 'input_request',
        sessionId: this.sessionId,
        request
      })
    })
  }

  /**
   * 响应一个挂起的用户输入请求。
   * @returns 是否命中本 session 的 pending 项
   */
  respondToInput(requestId: string, response: InputResponse): boolean {
    const pending = this.pendingInputs.get(requestId)
    if (!pending) return false
    this.pendingInputs.delete(requestId)
    pending.resolve(response)
    chatFrontendRegistry.broadcast({
      type: 'input_request_resolved',
      sessionId: this.sessionId,
      requestId
    })
    return true
  }

  // ─── 生命周期 ──────────────────────────────────────

  /** 使 Agent 失效（回退时使用，不销毁 Docker，下次 init 会重建） */
  invalidate(): void {
    this.agent.abort()
    clearFileTimeSession(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`invalidate session=${this.sessionId}`)
  }

  /** 完全销毁（删除会话时调用，含 Docker 清理）。不 cascade 到子智能体（由用户 / IPC 控制）。 */
  destroy(): void {
    this.agent.abort()
    clearFileTimeSession(this.sessionId)
    dockerManager
      .destroyContainer(this.sessionId)
      .then((containerId) => {
        if (containerId) {
          this.emitRuntimeEvent('docker', null)
        }
      })
      .catch(() => {})
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`destroy session=${this.sessionId}`)
  }

  // ─── 事件处理内部 ──────────────────────────────────

  /** 追加 pending log ID（供 streamFn 的 onPayload 回调使用） */
  addPendingLogId(logId: string): void {
    this.eventState.pendingLogIds.push(logId)
  }

  /** 构建 per-session 事件处理器上下文 */
  private getEventContext(): SessionEventHandlerContext {
    if (!this.eventCtx) {
      this.eventCtx = {
        sessionId: this.sessionId,
        state: this.eventState,
        broadcastEvent: (e) => chatFrontendRegistry.broadcast(e),
        persistStreamBuffer: (meta) => this.persistStreamBuffer(meta),
        emitRuntimeEvent: (runtimeId, status) => this.emitRuntimeEvent(runtimeId, status)
      }
    }
    return this.eventCtx
  }

  /** 转发 Agent 事件到 Renderer */
  private forwardEvent(event: AgentEvent): void {
    forwardAgentEvent(this.getEventContext(), event)
  }

  /** 将流式缓冲区内容持久化为 assistant 消息 */
  private persistStreamBuffer(extraMeta?: MessageMetadata): Message | null {
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
    const session = sessionDao.pick(this.sessionId, ['model'])

    const msg = messageService.addAssistantText({
      sessionId: this.sessionId,
      content: buf.content,
      metadata: Object.keys(meta).length > 0 ? meta : undefined,
      model: session?.model || ''
    })

    // 同步到 Agent 内存上下文（含图片）
    this.appendAssistantToAgent(buf.content, buf.thinking, buf.images)
    this.eventState.streamBuffer = { content: '', thinking: '', images: [] }
    return msg
  }

  /** 将 AI 生成的图片同步到 Agent 内存上下文中的 assistant 消息 */
  private appendAssistantToAgent(
    _content: string,
    _thinking?: string,
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

  /** 通知前端运行时资源状态变更（不持久化为消息） */
  emitRuntimeEvent(runtimeId: string, status: RuntimeStatus | null): void {
    chatFrontendRegistry.broadcast({
      type: 'runtime_event',
      sessionId: this.sessionId,
      runtimeId,
      status
    })
  }
}
