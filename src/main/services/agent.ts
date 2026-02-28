import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core'
import {
  type AssistantMessage,
  type TextContent,
  type ThinkingContent,
  type ImageContent,
  streamSimple,
  completeSimple
} from '@mariozechner/pi-ai'
import { streamSimpleGoogleWithImages } from './googleImageStream'
import { parallelCoordinator } from './parallelExecution'
import type { BrowserWindow } from 'electron'
import { httpLogService } from './httpLogService'
import { messageService } from './messageService'
import { providerDao } from '../dao/providerDao'
import { sessionDao } from '../dao/sessionDao'
import { projectDao } from '../dao/projectDao'
import { settingsDao } from '../dao/settingsDao'
import { getTempWorkspace } from '../utils/paths'
import { messageDao } from '../dao/messageDao'
import { type ToolContext } from '../tools/types'
import { clearSession as clearFileTimeSession } from '../tools/utils/fileTime'
import { dockerManager } from './dockerManager'
import { sshManager } from './sshManager'
import type { AgentInitResult, ModelCapabilities, ThinkingLevel, Message } from '../types'
import { t } from '../i18n'
import { resolveEnabledTools, buildToolPrompts } from '../utils/tools'
import { createTransformContext } from './contextManager'
import { createLogger } from '../logger'

// 提取的子模块
import { dbMessagesToAgentMessages } from './agentMessageConverter'
import { buildTools } from './agentToolBuilder'
import { resolveModel } from './agentModelResolver'
import {
  forwardAgentEvent,
  readProjectAgentMd,
  type AgentStreamEvent,
  type ProjectInstructionLoadState,
  type EventHandlerContext
} from './agentEventHandler'

const log = createLogger('Agent')

// Re-exports（保持外部导入兼容）
export { ALL_TOOL_NAMES } from '../utils/tools'
export type { ToolName } from '../utils/tools'
export { dbMessagesToAgentMessages } from './agentMessageConverter'
export type { AgentStreamEvent } from './agentEventHandler'

/**
 * Agent 服务 — 管理多个独立的 Agent 实例，按 sessionId 隔离
 * 每个 session 拥有自己的 Agent，互不影响
 */
export class AgentService {
  private agents = new Map<string, Agent>()
  /** 每个 session 的 AGENT.md 加载状态 */
  private instructionLoadStates = new Map<string, ProjectInstructionLoadState>()
  /** 每个 session 的 ToolContext，用于动态重建工具 */
  private toolContexts = new Map<string, ToolContext>()
  private pendingLogIds = new Map<string, string[]>()
  /** 待审批的 bash 命令 Promise resolver，key = toolCallId */
  private pendingApprovals = new Map<
    string,
    { resolve: (result: { approved: boolean; reason?: string }) => void }
  >()
  /** 待用户选择的 ask 工具 Promise resolver，key = toolCallId */
  private pendingUserInputs = new Map<string, { resolve: (selections: string[]) => void }>()
  /** 待用户输入 SSH 凭据的 Promise resolver，key = toolCallId */
  private pendingSshCredentials = new Map<
    string,
    { resolve: (credentials: import('../tools/types').SshCredentialPayload | null) => void }
  >()
  /** 每个 session 的流式内容缓冲区（后端累积 delta，用于 agent_end / abort 时统一落库） */
  private streamBuffers = new Map<
    string,
    {
      content: string
      thinking: string
      images: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
    }
  >()
  /** 每个 session 的 turn 计数器（用于在 UI 中标记工具调用所属 turn） */
  private turnCounters = new Map<string, number>()
  private mainWindow: BrowserWindow | null = null
  /** 缓存的事件处理器上下文 */
  private eventCtx: EventHandlerContext | null = null

  /** 绑定主窗口，用于发送 IPC 事件 */
  setWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /** 构建事件处理器上下文（延迟初始化） */
  private getEventContext(): EventHandlerContext {
    if (!this.eventCtx) {
      this.eventCtx = {
        streamBuffers: this.streamBuffers,
        turnCounters: this.turnCounters,
        pendingLogIds: this.pendingLogIds,
        sendToRenderer: (e) => this.sendToRenderer(e),
        persistStreamBuffer: (sid, meta) => this.persistStreamBuffer(sid, meta),
        isAssistantMessage: (msg) => this.isAssistantMessage(msg),
        emitDockerEvent: (sid, action, extra) => this.emitDockerEvent(sid, action, extra)
      }
    }
    return this.eventCtx
  }

  /** 为指定 session 创建 Agent 实例（已存在则跳过）；返回会话元信息供前端同步 */
  createAgent(sessionId: string): AgentInitResult {
    // 查询会话信息
    const session = sessionDao.findById(sessionId)
    if (!session) {
      log.error(`创建失败，未找到 session=${sessionId}`)
      return {
        success: false,
        created: false,
        provider: '',
        model: '',
        capabilities: {},
        modelMetadata: '',
        workingDirectory: '',
        enabledTools: [],
        agentMdLoaded: false
      }
    }

    const provider = session.provider || ''
    const model = session.model || ''
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const capabilities: ModelCapabilities = modelRow?.capabilities
      ? JSON.parse(modelRow.capabilities)
      : {}
    const project = session.projectId ? projectDao.findById(session.projectId) : undefined
    const workingDirectory = project?.path || getTempWorkspace(sessionId)
    const enabledTools = resolveEnabledTools(session.modelMetadata, project?.settings)
    const meta = {
      provider,
      model,
      capabilities,
      modelMetadata: session.modelMetadata || '',
      workingDirectory,
      enabledTools
    }

    // 已存在则跳过（工具通过 resolveProjectConfig 动态获取配置，无需重建）
    if (this.agents.has(sessionId)) {
      const instrState = this.instructionLoadStates.get(sessionId) || { agentMdLoaded: false }
      return { success: true, created: false, ...meta, ...instrState }
    }

    log.info(`创建 model=${model} session=${sessionId}`)

    let agentMdLoaded = false

    // 合并 system prompt：全局 + 项目级 + 参考目录
    const globalPrompt = settingsDao.findByKey('systemPrompt') || ''
    let systemPrompt = globalPrompt
    if (project?.systemPrompt) {
      systemPrompt = `${globalPrompt}\n\n${project.systemPrompt}`
    }
    // 注入工作目录 + 参考目录信息
    if (project) {
      const workDir = session.workingDirectory || project.path
      systemPrompt += `\n\nProject working directory: ${workDir}`

      let referenceDirs: Array<{ path: string; note?: string; access?: string }> = []
      try {
        const settings = JSON.parse(project.settings || '{}')
        if (Array.isArray(settings.referenceDirs)) referenceDirs = settings.referenceDirs
      } catch {
        /* 忽略 */
      }
      if (referenceDirs.length > 0) {
        const readonlyDirs = referenceDirs.filter((d) => (d.access ?? 'readonly') === 'readonly')
        const readwriteDirs = referenceDirs.filter((d) => d.access === 'readwrite')
        if (readonlyDirs.length > 0) {
          const lines = readonlyDirs.map((d) =>
            d.note ? `- ${d.path} — ${d.note}` : `- ${d.path}`
          )
          systemPrompt += `\n\nReference directories (read-only, you can read files from these directories but CANNOT write or edit):\n${lines.join('\n')}`
        }
        if (readwriteDirs.length > 0) {
          const lines = readwriteDirs.map((d) =>
            d.note ? `- ${d.path} — ${d.note}` : `- ${d.path}`
          )
          systemPrompt += `\n\nReference directories (read-write, you can read AND write files in these directories):\n${lines.join('\n')}`
        }
      }
    } else {
      // 临时对话：注入临时工作目录
      systemPrompt += `\n\nWorking directory: ${getTempWorkspace(sessionId)}`
    }

    // 统一模型解析
    const resolvedModel = resolveModel({ provider, model, capabilities })

    // 创建工具集（通过 sessionId 动态查询项目配置）
    const ctx: ToolContext = {
      sessionId,
      onContainerCreated: (containerId, image) => {
        this.emitDockerEvent(sessionId, 'container_created', {
          containerId: containerId.slice(0, 12),
          image
        })
      },
      requestApproval: (toolCallId: string, command: string) => {
        return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
          this.pendingApprovals.set(toolCallId, { resolve })
          this.sendToRenderer({
            type: 'tool_approval_request',
            sessionId,
            toolCallId,
            toolName: 'bash',
            toolArgs: { command }
          })
        })
      },
      requestUserInput: (
        toolCallId: string,
        payload: {
          question: string
          options: Array<{ label: string; description: string }>
          allowMultiple: boolean
        }
      ) => {
        return new Promise<string[]>((resolve) => {
          this.pendingUserInputs.set(toolCallId, { resolve })
          this.sendToRenderer({
            type: 'user_input_request',
            sessionId,
            toolCallId,
            toolName: 'ask',
            userInputPayload: payload
          })
        })
      },
      requestSshCredentials: (toolCallId: string) => {
        return new Promise<import('../tools/types').SshCredentialPayload | null>((resolve) => {
          this.pendingSshCredentials.set(toolCallId, { resolve })
          this.sendToRenderer({
            type: 'ssh_credential_request',
            sessionId,
            toolCallId,
            toolName: 'ssh'
          })
        })
      },
      onSshConnected: (host, port, username) => {
        this.emitSshEvent(sessionId, 'ssh_connected', {
          host,
          port: String(port),
          username
        })
      },
      onSshDisconnected: (host, port, username) => {
        this.emitSshEvent(sessionId, 'ssh_disconnected', {
          host,
          port: String(port),
          username
        })
      }
    }
    this.toolContexts.set(sessionId, ctx)
    const tools = buildTools(ctx, enabledTools)

    // 在 system prompt 中附加工具引导（根据启用工具自动拼接）
    const toolPrompts = buildToolPrompts(enabledTools, { hasProjectPath: !!project?.path })
    const enhancedPrompt = toolPrompts ? `${systemPrompt}\n\n${toolPrompts}` : systemPrompt

    const agent = new Agent({
      initialState: {
        systemPrompt: enhancedPrompt,
        model: resolvedModel,
        thinkingLevel: capabilities.reasoning ? 'medium' : 'off',
        messages: [],
        tools
      },
      transformContext: createTransformContext(resolvedModel),
      streamFn: (streamModel, context, options) => {
        // 动态查找当前模型对应提供商的 apiKey（支持运行时切换提供商）
        const currentProvider = providerDao.findById(String(streamModel.provider))
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
              const ids = this.pendingLogIds.get(sessionId) || []
              ids.push(logId)
              this.pendingLogIds.set(sessionId, ids)
            }
          }
          // Google API 使用支持图片输出的自定义流函数
          if (streamModel.api === 'google-generative-ai') {
            return streamSimpleGoogleWithImages(streamModel, context, streamOpts)
          }
          return streamSimple(streamModel, context, streamOpts)
        } catch (err: unknown) {
          // streamFn 抛出同步错误时，立即通知渲染进程
          const message = err instanceof Error ? err.message : String(err)
          log.error(`streamFn 错误: ${message}`)
          this.sendToRenderer({ type: 'error', sessionId, error: message })
          throw err
        }
      }
    })

    // 将项目 AGENTS.MD / AGENT.md 作为独立的用户消息注入
    if (project) {
      const agentMd = readProjectAgentMd(project.path)
      if (agentMd) {
        agentMdLoaded = true
        agent.state.messages.push({
          role: 'user',
          content: `Project AGENTS.MD instructions:\n${agentMd}`,
          timestamp: Date.now()
        })
      }
    }

    this.instructionLoadStates.set(sessionId, { agentMdLoaded })

    this.agents.set(sessionId, agent)

    // 订阅 Agent 事件，转发到 Renderer（携带 sessionId）
    agent.subscribe((event: AgentEvent) => {
      this.forwardEvent(sessionId, event)
    })

    // 恢复历史消息到 Agent 上下文（正确处理 tool_call / tool_result / 图片等类型）
    const dbMsgs = messageDao.findBySessionId(sessionId)
    if (dbMsgs.length > 0) {
      const agentMessages = dbMessagesToAgentMessages(dbMsgs)
      for (const msg of agentMessages) {
        agent.state.messages.push(msg)
      }
    }

    return { success: true, created: true, ...meta, agentMdLoaded }
  }

  /** 向指定 session 的 Agent 发送消息（支持附带图片） */
  async prompt(
    sessionId: string,
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  ): Promise<void> {
    const agent = this.agents.get(sessionId)
    if (!agent) {
      log.warn(`prompt 失败，未找到 session=${sessionId}`)
      this.sendToRenderer({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }

    log.info(
      `prompt session=${sessionId} text=${text.slice(0, 50)}... images=${images?.length || 0}`
    )
    try {
      if (images && images.length > 0) {
        await agent.prompt(text, images)
      } else {
        await agent.prompt(text)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.sendToRenderer({ type: 'error', sessionId, error: message })
    }
  }

  /** 响应工具审批请求（前端用户点击允许/拒绝后调用） */
  approveToolCall(toolCallId: string, approved: boolean, reason?: string): void {
    const pending = this.pendingApprovals.get(toolCallId)
    if (pending) {
      pending.resolve({ approved, reason })
      this.pendingApprovals.delete(toolCallId)
    }
  }

  /** 响应 ask 工具的用户选择 */
  respondToAsk(toolCallId: string, selections: string[]): void {
    const pending = this.pendingUserInputs.get(toolCallId)
    if (pending) {
      pending.resolve(selections)
      this.pendingUserInputs.delete(toolCallId)
    }
  }

  /** 响应 SSH 凭据输入（凭据不经过大模型，直接传给 sshManager） */
  respondToSshCredentials(
    toolCallId: string,
    credentials: import('../tools/types').SshCredentialPayload | null
  ): void {
    const pending = this.pendingSshCredentials.get(toolCallId)
    if (pending) {
      pending.resolve(credentials)
      this.pendingSshCredentials.delete(toolCallId)
    }
  }

  /** 中止指定 session 的生成；若已有部分内容则持久化并返回 */
  abort(sessionId: string): Message | null {
    log.info(`中止 session=${sessionId}`)
    parallelCoordinator.cancelBatch(sessionId)
    this.agents.get(sessionId)?.abort()
    // 取消所有待审批的 Promise
    for (const [id, pending] of this.pendingApprovals) {
      pending.resolve({ approved: false })
      this.pendingApprovals.delete(id)
    }
    // 取消所有待用户选择的 Promise
    for (const [id, pending] of this.pendingUserInputs) {
      pending.resolve([])
      this.pendingUserInputs.delete(id)
    }
    // 取消所有待 SSH 凭据输入的 Promise
    for (const [id, pending] of this.pendingSshCredentials) {
      pending.resolve(null)
      this.pendingSshCredentials.delete(id)
    }
    // 检查是否有正在进行的工具调用（DB 中有 tool_call 但还没有对应的 tool_result）
    // 如果有，不持久化 stream buffer，因为 buffer 中的文本是同一条 LLM 回复中工具调用之前的内容，
    // 单独保存会插入到 tool_call 和 tool_result 之间，破坏消息配对导致 API 400 错误
    const dbMsgs = messageDao.findBySessionId(sessionId)
    if (dbMsgs.length > 0) {
      const lastMsg = dbMsgs[dbMsgs.length - 1]
      if (lastMsg.role === 'assistant' && lastMsg.type === 'tool_call') {
        log.info(`中止时有未完成的工具调用，跳过 buffer 持久化 session=${sessionId}`)
        this.streamBuffers.delete(sessionId)
        return null
      }
    }
    // 持久化已生成的部分内容（与 agent_end 共用落库逻辑）
    return this.persistStreamBuffer(sessionId)
  }

  /** 切换指定 session 的模型 */
  setModel(
    sessionId: string,
    provider: string,
    model: string,
    baseUrl?: string,
    apiProtocol?: string
  ): void {
    const agent = this.agents.get(sessionId)
    if (!agent) return

    // 从 DB 读取模型能力信息
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const caps: ModelCapabilities = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}

    // 统一模型解析
    const resolvedModel = resolveModel({
      provider,
      model,
      capabilities: caps,
      baseUrl,
      apiProtocol
    })

    agent.setModel(resolvedModel)
    agent.setThinkingLevel(caps.reasoning ? 'medium' : 'off')
    log.info(
      `切换模型 session=${sessionId} provider=${provider} model=${model} reasoning=${caps.reasoning ? 'medium' : 'off'}`
    )
  }

  /** 动态更新指定 session 的启用工具集 */
  setEnabledTools(sessionId: string, enabledTools: string[]): void {
    const agent = this.agents.get(sessionId)
    const ctx = this.toolContexts.get(sessionId)
    if (!agent || !ctx) {
      log.warn(`setEnabledTools: session=${sessionId} agent/ctx不存在`)
      return
    }
    const tools = buildTools(ctx, enabledTools)
    agent.setTools(tools)
    log.info(`setEnabledTools session=${sessionId} tools=[${enabledTools.join(',')}]`)
  }

  /** 获取会话的项目指令文件加载状态（由 AgentService 维护） */
  getInstructionLoadState(sessionId: string): ProjectInstructionLoadState {
    return this.instructionLoadStates.get(sessionId) || { agentMdLoaded: false }
  }

  /** 获取指定 session 的消息列表 */
  getMessages(sessionId: string): AgentMessage[] {
    return this.agents.get(sessionId)?.state.messages ?? []
  }

  /** 清除指定 session 的消息历史 */
  clearMessages(sessionId: string): void {
    const agent = this.agents.get(sessionId)
    if (agent) {
      agent.state.messages = []
    }
  }

  /** 设置指定 session 的思考深度 */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const agent = this.agents.get(sessionId)
    if (!agent) {
      log.warn(`setThinkingLevel: session=${sessionId} agent不存在`)
      return
    }
    agent.setThinkingLevel(level)
    log.info(`setThinkingLevel=${level}`)
  }

  /**
   * 让 AI 根据对话内容生成简短标题（后台静默调用，对用户透明）
   * 复用该 session 已有的模型配置
   */
  async generateTitle(
    sessionId: string,
    userMessage: string,
    assistantMessage: string
  ): Promise<string | null> {
    const agent = this.agents.get(sessionId)
    if (!agent) return null

    try {
      // 查找当前模型对应提供商的 apiKey
      const currentProvider = providerDao.findById(String(agent.state.model.provider))
      const resolvedApiKey = currentProvider?.apiKey
      const result = await completeSimple(
        agent.state.model,
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
      // 从 AssistantMessage 中提取文本
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

  /** 使指定 session 的 Agent 失效（回退时使用，不销毁 Docker，下次 init 会重建） */
  invalidateAgent(sessionId: string): void {
    const agent = this.agents.get(sessionId)
    if (agent) {
      agent.abort()
      parallelCoordinator.clearSession(sessionId)
      this.agents.delete(sessionId)
      this.instructionLoadStates.delete(sessionId)
      clearFileTimeSession(sessionId)
      // 断开 SSH 连接（回退时不保留）
      sshManager.disconnect(sessionId).catch(() => {})
      // 保留 pendingLogIds / Docker 容器，下次 createAgent 会自动复用
      log.info(`invalidate session=${sessionId}`)
    }
  }

  /** 移除指定 session 的 Agent（删除会话时调用） */
  removeAgent(sessionId: string): void {
    const agent = this.agents.get(sessionId)
    if (agent) {
      agent.abort()
      parallelCoordinator.clearSession(sessionId)
      this.agents.delete(sessionId)
      this.instructionLoadStates.delete(sessionId)
      this.pendingLogIds.delete(sessionId)
      clearFileTimeSession(sessionId)
      // 立刻清理 Docker 容器（会话删除）
      dockerManager
        .destroyContainer(sessionId)
        .then((containerId) => {
          if (containerId) {
            this.emitDockerEvent(sessionId, 'container_destroyed', {
              containerId: containerId.slice(0, 12),
              reason: 'session_deleted'
            })
          }
        })
        .catch(() => {})
      // 断开 SSH 连接
      sshManager.disconnect(sessionId).catch(() => {})
      log.info(`移除 session=${sessionId} 剩余=${this.agents.size}`)
    }
  }

  /**
   * 将流式缓冲区内容持久化为 assistant 消息（agent_end / abort 共用）
   * 同时同步到 Agent 内存上下文，确保后续 prompt 包含该消息
   * @returns 已保存的消息，如果缓冲区为空则返回 null
   */
  private persistStreamBuffer(
    sessionId: string,
    extraMeta?: Record<string, unknown>
  ): Message | null {
    const buf = this.streamBuffers.get(sessionId)
    if (!buf?.content && !buf?.images?.length) {
      this.streamBuffers.delete(sessionId)
      return null
    }

    const meta: Record<string, unknown> = { ...extraMeta }
    if (buf!.thinking) meta.thinking = buf!.thinking
    // 将图片数据转换为与用户图片一致的 data URL 格式（保留 thoughtSignature 用于会话恢复）
    if (buf!.images?.length) {
      meta.images = buf!.images.map((img) => ({
        data: `data:${img.mimeType};base64,${img.data}`,
        mimeType: img.mimeType,
        ...(img.thoughtSignature && { thoughtSignature: img.thoughtSignature })
      }))
    }
    const session = sessionDao.findById(sessionId)

    const msg = messageService.add({
      sessionId,
      role: 'assistant',
      content: buf!.content,
      metadata: Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined,
      model: session?.model || ''
    })

    // 同步到 Agent 内存上下文（含图片）
    this.appendAssistantToAgent(sessionId, buf!.content, buf!.thinking, buf!.images)
    this.streamBuffers.delete(sessionId)
    return msg
  }

  /**
   * 将 AI 生成的图片同步到 Agent 内存上下文中的 assistant 消息。
   *
   * pi-agent-core 框架在流式响应期间已自动将 AssistantMessage 写入
   * agent.state.messages，但其 content 不包含 ImageContent（图片存储在
   * 非标准 _images 字段）。此方法在最后一条 assistant 消息的 content 中
   * 补充 ImageContent 块，确保后续 injectModelImages 能正确注入图片。
   *
   * 注意：不再 push 新消息，避免产生重复的 assistant 条目导致
   * injectModelImages 的顺序索引匹配失败。
   */
  private appendAssistantToAgent(
    sessionId: string,
    _content: string,
    _thinking?: string,
    images?: Array<{ data: string; mimeType: string; thoughtSignature?: string }>
  ): void {
    const agent = this.agents.get(sessionId)
    if (!agent || !images?.length) return

    // 找到框架已写入的最后一条 assistant 消息，向其 content 追加 ImageContent
    const messages = agent.state.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (this.isAssistantMessage(msg)) {
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

  /** 判断 AgentMessage 是否为 AssistantMessage */
  private isAssistantMessage(message: AgentMessage): message is AssistantMessage {
    return message !== null && 'role' in message && message.role === 'assistant'
  }

  /** 将 pi-agent-core 事件转换并发送到 Renderer（委托给 agentEventHandler） */
  private forwardEvent(sessionId: string, event: AgentEvent): void {
    forwardAgentEvent(this.getEventContext(), sessionId, event)
  }

  /** 持久化 docker_event 消息并通知前端 */
  private emitDockerEvent(sessionId: string, action: string, extra?: Record<string, string>): void {
    const msg = messageService.add({
      sessionId,
      role: 'system_notify',
      type: 'docker_event',
      content: action,
      metadata: extra ? JSON.stringify(extra) : null
    })
    this.sendToRenderer({ type: 'docker_event', sessionId, data: msg.id })
  }

  /** 持久化 ssh_event 消息并通知前端 */
  private emitSshEvent(sessionId: string, action: string, extra?: Record<string, string>): void {
    const msg = messageService.add({
      sessionId,
      role: 'system_notify',
      type: 'ssh_event',
      content: action,
      metadata: extra ? JSON.stringify(extra) : null
    })
    this.sendToRenderer({ type: 'ssh_event', sessionId, data: msg.id })
  }

  /** 发送事件到 Renderer */
  private sendToRenderer(event: AgentStreamEvent): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('agent:event', event)
    }
  }
}

// 全局单例
export const agentService = new AgentService()
