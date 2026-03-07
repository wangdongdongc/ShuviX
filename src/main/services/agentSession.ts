import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core'
import {
  type TextContent,
  type ThinkingContent,
  type ImageContent,
  completeSimple,
  streamSimple
} from '@mariozechner/pi-ai'
import { parallelCoordinator } from './parallelExecution'
import { messageService } from './messageService'
import { providerDao } from '../dao/providerDao'
import { sessionDao } from '../dao/sessionDao'
import { buildTools, type SubAgentBuildContext } from './agentToolBuilder'
import { subAgentManager } from './subAgent'
import { resolveModel } from './agentModelResolver'
import { clearSession as clearFileTimeSession } from '../tools/utils/fileTime'
import { dockerManager } from './dockerManager'
import { sshManager } from './sshManager'
import { pythonWorkerManager } from './pythonWorkerManager'
import type { ModelCapabilities, ThinkingLevel, Message, MessageMetadata, ProjectSettings } from '../types'
import type { SessionModelMetadata } from '../dao/types'
import { t } from '../i18n'
import {
  forwardAgentEvent,
  readProjectAgentMd,
  type ProjectInstructionLoadState,
  type SessionEventState,
  type SessionEventHandlerContext
} from './agentEventHandler'
import { isAssistantMessage } from '../utils/messageGuards'
import { chatFrontendRegistry, INTERACTION_TIMEOUT_MS } from '../frontend'
import type { ToolContext, SshCredentialPayload } from '../tools/types'
import { streamSimpleGoogleWithImages } from './googleImageStream'
import { httpLogService } from './httpLogService'
import { settingsDao } from '../dao/settingsDao'
import { getTempWorkspace } from '../utils/paths'
import { createTransformContext } from './contextManager'
import { dbMessagesToAgentMessages } from '../utils/agentMessageConverter'
import { createLogger } from '../logger'

const log = createLogger('AgentSession')

/** AgentSession.create 工厂参数 */
export interface AgentSessionCreateParams {
  sessionId: string
  provider: string
  model: string
  capabilities: ModelCapabilities
  project?: { path: string; systemPrompt?: string | null; settings?: ProjectSettings | null }
  workingDirectory: string
  enabledTools: string[]
  modelMetadata?: SessionModelMetadata
}

/** 合并系统提示词：全局 + 项目级 + 参考目录 + 工作目录 */
function buildSystemPrompt(
  project: { path: string; systemPrompt?: string | null; settings?: ProjectSettings | null } | undefined,
  workingDirectory: string,
  sessionId: string
): string {
  const globalPrompt = settingsDao.findByKey('systemPrompt') || ''
  let prompt = globalPrompt
  if (project?.systemPrompt) {
    prompt = `${globalPrompt}\n\n${project.systemPrompt}`
  }
  if (project) {
    const workDir = workingDirectory || project.path
    prompt += `\n\nProject working directory: ${workDir}. All file tool paths are relative to this directory.`

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
  } else {
    prompt += `\n\nWorking directory: ${getTempWorkspace(sessionId)}`
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
  private instructionLoadState: ProjectInstructionLoadState

  // 交互回调 pending Map（keyed by toolCallId）
  private pendingApprovals = new Map<
    string,
    { resolve: (result: { approved: boolean; reason?: string }) => void }
  >()
  private pendingUserInputs = new Map<string, { resolve: (selections: string[]) => void }>()
  private pendingSshCredentials = new Map<
    string,
    { resolve: (credentials: SshCredentialPayload | null) => void }
  >()

  // 事件状态（可变引用，传给 event handler）
  private eventState: SessionEventState = {
    streamBuffer: { content: '', thinking: '', images: [] },
    turnCounter: 0,
    pendingLogIds: [],
    preEmittedToolCalls: new Set(),
    toolUseMessageIds: new Map()
  }

  // 缓存的事件处理器上下文
  private eventCtx: SessionEventHandlerContext | null = null

  private constructor(
    sessionId: string,
    agent: Agent,
    toolContext: ToolContext,
    subAgentCtx: SubAgentBuildContext | undefined,
    instructionLoadState: ProjectInstructionLoadState
  ) {
    this.sessionId = sessionId
    this.agent = agent
    this.toolContext = toolContext
    this.subAgentCtx = subAgentCtx
    this.instructionLoadState = instructionLoadState

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
      onContainerCreated: (containerId, image) => {
        session.emitDockerEvent('container_created', {
          containerId: containerId.slice(0, 12),
          image
        })
      },
      requestApproval: (toolCallId, command) => session.requestApproval(toolCallId, command),
      requestUserInput: (toolCallId, payload) => session.requestUserInput(toolCallId, payload),
      requestSshCredentials: (toolCallId) => session.requestSshCredential(toolCallId),
      onSshConnected: (host, port, username) => {
        session.emitSshEvent('ssh_connected', { host, port, username })
      },
      onSshDisconnected: (host, port, username) => {
        session.emitSshEvent('ssh_disconnected', { host, port, username })
      },
      onPythonReady: () => {
        session.emitPythonEvent('runtime_ready')
      },
      onPythonDestroyed: () => {
        session.emitPythonEvent('runtime_destroyed')
      }
    }

    const systemPrompt = buildSystemPrompt(project, workingDirectory, sessionId)
    const resolvedModel = resolveModel({ provider, model, capabilities })


    // 构建 streamFn（回调通过闭包引用 session）
    const streamFn = (
      streamModel: Parameters<typeof streamSimple>[0],
      context: Parameters<typeof streamSimple>[1],
      options?: Parameters<typeof streamSimple>[2]
    ): ReturnType<typeof streamSimple> => {
      const currentProvider = providerDao.pick(String(streamModel.provider), [
        'apiKey',
        'isBuiltin',
        'name'
      ])
      const resolvedApiKey = currentProvider?.apiKey
      try {
        const streamOpts = {
          ...(options || {}),
          ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
          onPayload: (payload: unknown) => {
            const logId = httpLogService.logRequest({
              sessionId,
              provider: String(streamModel.provider || provider),
              model: String(streamModel.id || model),
              payload
            })
            session.addPendingLogId(logId)
          }
        }
        // 内置提供商：还原 SDK 可识别的 provider slug（如 "openrouter"、"anthropic"）
        // ShuviX 用内部 ID 覆盖了 model.provider，需要还原以使 SDK 内部逻辑正常工作
        const effectiveModel =
          currentProvider?.isBuiltin && currentProvider.name
            ? { ...streamModel, provider: currentProvider.name.toLowerCase() }
            : streamModel

        if (effectiveModel.api === 'google-generative-ai') {
          return streamSimpleGoogleWithImages(effectiveModel, context, streamOpts)
        }
        return streamSimple(effectiveModel, context, streamOpts)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        log.error(`streamFn 错误: ${message}`)
        chatFrontendRegistry.broadcast({ type: 'error', sessionId, error: message })
        throw err
      }
    }

    // 构建子智能体上下文（使 explore 等子智能体工具可用）
    const subAgentCtx: SubAgentBuildContext = {
      parentModel: resolvedModel,
      parentStreamFn: streamFn,
      broadcastEvent: (e) => chatFrontendRegistry.broadcast(e)
    }
    const tools = buildTools(toolContext, enabledTools, subAgentCtx)

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
      transformContext: createTransformContext(resolvedModel),
      streamFn
    })

    // 注入项目 AGENTS.MD / AGENT.md
    const agentMd = project ? readProjectAgentMd(project.path) : null
    if (agentMd) {
      agent.state.messages.push({
        role: 'user',
        content: `Project AGENTS.MD instructions:\n${agentMd}`,
        timestamp: Date.now()
      })
    }

    session = new AgentSession(sessionId, agent, toolContext, subAgentCtx, { agentMdLoaded: !!agentMd })

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

  /** 中止生成；若已有部分内容则持久化并返回 */
  abort(): Message | null {
    log.info(`中止 session=${this.sessionId}`)
    parallelCoordinator.cancelBatch(this.sessionId)
    subAgentManager.abortAll(this.sessionId)
    this.agent.abort()
    // 只取消本 session 的 pending 项
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve({ approved: false })
    }
    this.pendingApprovals.clear()
    for (const [, pending] of this.pendingUserInputs) {
      pending.resolve([])
    }
    this.pendingUserInputs.clear()
    for (const [, pending] of this.pendingSshCredentials) {
      pending.resolve(null)
    }
    this.pendingSshCredentials.clear()
    // 检查是否有未完成的工具调用
    const lastMsg = messageService.findLastBySession(this.sessionId)
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.type === 'tool_use') {
      log.info(`中止时有未完成的工具调用，跳过 buffer 持久化 session=${this.sessionId}`)
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
    const tools = buildTools(this.toolContext, enabledTools, this.subAgentCtx)
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

  /** 获取项目指令文件加载状态 */
  getInstructionLoadState(): ProjectInstructionLoadState {
    return this.instructionLoadState
  }

  /** 获取底层 Agent 实例（用于外部恢复历史消息等） */
  getAgent(): Agent {
    return this.agent
  }

  /** AI 生成简短标题 */
  async generateTitle(userMessage: string, assistantMessage: string): Promise<string | null> {
    try {
      const currentProvider = providerDao.pick(String(this.agent.state.model.provider), ['apiKey'])
      const resolvedApiKey = currentProvider?.apiKey
      const result = await completeSimple(
        this.agent.state.model,
        {
          systemPrompt: t('agent.titleGenPrompt'),
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `用户: ${userMessage.slice(0, 500)}\n助手: ${assistantMessage.slice(0, 500)}`
                }
              ],
              timestamp: Date.now()
            }
          ]
        },
        resolvedApiKey ? { apiKey: resolvedApiKey } : {}
      )
      const text = result.content
        ?.filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim()
      if (text && text.length > 0) {
        return text.slice(0, 30)
      }
    } catch (err) {
      log.error(`生成标题失败: ${err}`)
    }
    return null
  }

  // ─── 交互响应（返回 boolean 表示是否命中本 session） ──────

  /** 响应工具审批请求 */
  approveToolCall(toolCallId: string, approved: boolean, reason?: string): boolean {
    const pending = this.pendingApprovals.get(toolCallId)
    if (pending) {
      pending.resolve({ approved, reason })
      this.pendingApprovals.delete(toolCallId)
      return true
    }
    return false
  }

  /** 响应 ask 工具的用户选择 */
  respondToAsk(toolCallId: string, selections: string[]): boolean {
    const pending = this.pendingUserInputs.get(toolCallId)
    if (pending) {
      pending.resolve(selections)
      this.pendingUserInputs.delete(toolCallId)
      return true
    }
    return false
  }

  /** 响应 SSH 凭据输入 */
  respondToSshCredentials(toolCallId: string, credentials: SshCredentialPayload | null): boolean {
    const pending = this.pendingSshCredentials.get(toolCallId)
    if (pending) {
      pending.resolve(credentials)
      this.pendingSshCredentials.delete(toolCallId)
      return true
    }
    return false
  }

  // ─── ToolContext 回调（供 AgentService 构建 ToolContext 时引用） ──

  /** 创建审批 Promise（ToolContext.requestApproval 的实现） */
  requestApproval(
    toolCallId: string,
    command: string
  ): Promise<{ approved: boolean; reason?: string }> {
    if (!chatFrontendRegistry.hasCapability(this.sessionId, 'toolApproval')) {
      return Promise.resolve({ approved: false, reason: 'no frontend supports approval' })
    }
    return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
      this.pendingApprovals.set(toolCallId, { resolve })
      const timer = setTimeout(() => {
        if (this.pendingApprovals.delete(toolCallId)) {
          resolve({ approved: false, reason: 'approval timeout' })
        }
      }, INTERACTION_TIMEOUT_MS)
      const origResolve = resolve
      this.pendingApprovals.set(toolCallId, {
        resolve: (result) => {
          clearTimeout(timer)
          origResolve(result)
        }
      })
      chatFrontendRegistry.broadcast({
        type: 'tool_approval_request',
        sessionId: this.sessionId,
        toolCallId,
        toolName: 'bash',
        toolArgs: { command }
      })
    })
  }

  /** 创建用户输入 Promise（ToolContext.requestUserInput 的实现） */
  requestUserInput(
    toolCallId: string,
    payload: {
      question: string
      options: Array<{ label: string; description: string }>
      allowMultiple: boolean
    }
  ): Promise<string[]> {
    if (!chatFrontendRegistry.hasCapability(this.sessionId, 'userInput')) {
      return Promise.resolve([])
    }
    return new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingUserInputs.delete(toolCallId)) {
          resolve([])
        }
      }, INTERACTION_TIMEOUT_MS)
      this.pendingUserInputs.set(toolCallId, {
        resolve: (selections) => {
          clearTimeout(timer)
          resolve(selections)
        }
      })
      chatFrontendRegistry.broadcast({
        type: 'user_input_request',
        sessionId: this.sessionId,
        toolCallId,
        toolName: 'ask',
        payload
      })
    })
  }

  /** 创建 SSH 凭据 Promise（ToolContext.requestSshCredentials 的实现） */
  requestSshCredential(toolCallId: string): Promise<SshCredentialPayload | null> {
    if (!chatFrontendRegistry.hasCapability(this.sessionId, 'sshCredentials')) {
      return Promise.resolve(null)
    }
    return new Promise<SshCredentialPayload | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingSshCredentials.delete(toolCallId)) {
          resolve(null)
        }
      }, INTERACTION_TIMEOUT_MS)
      this.pendingSshCredentials.set(toolCallId, {
        resolve: (credentials) => {
          clearTimeout(timer)
          resolve(credentials)
        }
      })
      chatFrontendRegistry.broadcast({
        type: 'ssh_credential_request',
        sessionId: this.sessionId,
        toolCallId,
        toolName: 'ssh'
      })
    })
  }

  // ─── 生命周期 ──────────────────────────────────────

  /** 使 Agent 失效（回退时使用，不销毁 Docker，下次 init 会重建） */
  invalidate(): void {
    this.agent.abort()
    subAgentManager.destroyAll(this.sessionId)
    parallelCoordinator.clearSession(this.sessionId)
    clearFileTimeSession(this.sessionId)
    sshManager.disconnect(this.sessionId).catch(() => {})
    log.info(`invalidate session=${this.sessionId}`)
  }

  /** 完全销毁（删除会话时调用，含 Docker 清理） */
  destroy(): void {
    this.agent.abort()
    subAgentManager.destroyAll(this.sessionId)
    parallelCoordinator.clearSession(this.sessionId)
    clearFileTimeSession(this.sessionId)
    dockerManager
      .destroyContainer(this.sessionId)
      .then((containerId) => {
        if (containerId) {
          this.emitDockerEvent('container_destroyed', {
            containerId: containerId.slice(0, 12),
            reason: 'session_deleted'
          })
        }
      })
      .catch(() => {})
    sshManager.disconnect(this.sessionId).catch(() => {})
    pythonWorkerManager.terminate(this.sessionId)
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
        emitDockerEvent: (action, extra) => this.emitDockerEvent(action, extra)
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

  /** 通知前端 Docker 容器生命周期事件（不持久化为消息） */
  emitDockerEvent(
    action: 'container_created' | 'container_destroyed',
    extra?: { containerId?: string; image?: string; reason?: string }
  ): void {
    chatFrontendRegistry.broadcast({
      type: 'docker_event',
      sessionId: this.sessionId,
      action,
      containerId: extra?.containerId,
      image: extra?.image,
      reason: extra?.reason
    })
  }

  /** 通知前端 SSH 连接生命周期事件（不持久化为消息） */
  emitSshEvent(
    action: 'ssh_connected' | 'ssh_disconnected',
    extra?: { host?: string; port?: number; username?: string }
  ): void {
    chatFrontendRegistry.broadcast({
      type: 'ssh_event',
      sessionId: this.sessionId,
      action,
      host: extra?.host,
      port: extra?.port,
      username: extra?.username
    })
  }

  /** 通知前端 Python 运行时生命周期事件（不持久化为消息） */
  emitPythonEvent(action: 'runtime_ready' | 'runtime_destroyed'): void {
    chatFrontendRegistry.broadcast({
      type: 'python_event',
      sessionId: this.sessionId,
      action
    })
  }
}
