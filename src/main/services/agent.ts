import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core'
import { type AssistantMessage, type Model, type Api, getModel, streamSimple, completeSimple } from '@mariozechner/pi-ai'
import type { BrowserWindow } from 'electron'
import { httpLogService } from './httpLogService'
import { messageService } from './messageService'
import { providerDao } from '../dao/providerDao'
import { createCodingTools } from '../tools'
import { dockerManager, CONTAINER_WORKSPACE } from './dockerManager'
import { createDockerOperations } from '../tools/dockerOperations'
import type { ModelCapabilities, ThinkingLevel } from '../types'
import { buildCustomProviderCompat } from './providerCompat'

// Agent 事件类型（用于 IPC 通信，每个事件都携带 sessionId）
export interface AgentStreamEvent {
  type: 'text_delta' | 'text_end' | 'thinking_delta' | 'agent_start' | 'agent_end' | 'error' | 'tool_start' | 'tool_end' | 'docker_event'
  sessionId: string
  data?: string
  error?: string
  // 工具调用相关字段
  toolCallId?: string
  toolName?: string
  toolArgs?: any
  toolResult?: any
  toolIsError?: boolean
}

/**
 * Agent 服务 — 管理多个独立的 Agent 实例，按 sessionId 隔离
 * 每个 session 拥有自己的 Agent，互不影响
 */
/** 记录 Agent 创建时的关键配置，用于变更检测 */
interface AgentConfig {
  workingDirectory: string
  dockerEnabled: boolean
  dockerImage: string
}

export class AgentService {
  private agents = new Map<string, Agent>()
  private agentConfigs = new Map<string, AgentConfig>()
  private pendingLogIds = new Map<string, string[]>()
  private mainWindow: BrowserWindow | null = null

  /** 绑定主窗口，用于发送 IPC 事件 */
  setWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /** 为指定 session 创建 Agent 实例（已存在则跳过） */
  createAgent(
    sessionId: string,
    provider: string,
    model: string,
    systemPrompt: string,
    workingDirectory?: string,
    dockerEnabled?: boolean,
    dockerImage?: string,
    apiKey?: string,
    baseUrl?: string,
    apiProtocol?: string
  ): boolean {
    // 检测关键配置是否变化，变化则销毁旧 agent 重建
    const newConfig: AgentConfig = {
      workingDirectory: workingDirectory || '',
      dockerEnabled: dockerEnabled || false,
      dockerImage: dockerImage || 'ubuntu:latest'
    }
    const oldConfig = this.agentConfigs.get(sessionId)
    if (this.agents.has(sessionId)) {
      if (
        oldConfig &&
        oldConfig.workingDirectory === newConfig.workingDirectory &&
        oldConfig.dockerEnabled === newConfig.dockerEnabled &&
        oldConfig.dockerImage === newConfig.dockerImage
      ) {
        return false
      }
      // 配置变更，销毁旧 agent
      console.log(`[Agent] 配置变更，重建 session=${sessionId}`)
      this.removeAgent(sessionId)
    }
    console.log(`[Agent] 创建 model=${model} session=${sessionId}`)

    // 查询提供商信息，判断是否内置
    const providerInfo = providerDao.findById(provider)
    const isBuiltin = providerInfo?.isBuiltin ?? false
    let resolvedModel: Model<Api>

    // 从 DB 读取模型能力信息
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const caps: ModelCapabilities = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}

    if (!isBuiltin) {
      // 自定义提供商：手动构造 Model 对象，用 capabilities 填充
      const inputModalities: string[] = ['text']
      if (caps.vision) inputModalities.push('image')
      const resolvedApi = (apiProtocol || providerInfo?.apiProtocol || 'openai-completions') as Api
      resolvedModel = {
        id: model,
        name: model,
        api: resolvedApi,
        provider,
        baseUrl: baseUrl || providerInfo?.baseUrl || '',
        reasoning: caps.reasoning ?? false,
        input: inputModalities as any,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: caps.maxInputTokens ?? 128000,
        maxTokens: caps.maxOutputTokens ?? 16384,
        ...(buildCustomProviderCompat(resolvedApi) ? { compat: buildCustomProviderCompat(resolvedApi) } : {})
      }
    } else {
      // 内置提供商：通过 SDK 解析（用 name 小写作为 pi-ai 的 provider slug）
      const slug = (providerInfo?.name || '').toLowerCase()
      if (apiKey) {
        const envMap: Record<string, string> = {
          openai: 'OPENAI_API_KEY',
          anthropic: 'ANTHROPIC_API_KEY',
          google: 'GOOGLE_API_KEY'
        }
        const envKey = envMap[slug]
        if (envKey) {
          process.env[envKey] = apiKey
        }
      }
      resolvedModel = getModel(slug as any, model as any)
      if (baseUrl) {
        resolvedModel.baseUrl = baseUrl
      }
    }

    // 创建工具集（基于会话工作目录，可选 Docker 隔离）
    const hostCwd = workingDirectory || process.cwd()
    const useDocker = dockerEnabled && !!dockerImage
    let toolOps: import('../tools').CreateToolsOptions | undefined
    console.log(`[Agent] useDocker=${useDocker}`)
    if (useDocker) {
      // Docker 隔离：在容器中执行bash命令
      const dockerOps = createDockerOperations(dockerManager, sessionId, dockerImage!, hostCwd, (containerId) => {
        // 容器创建时写入 docker_event 消息
        this.emitDockerEvent(sessionId, 'container_created', { containerId: containerId.slice(0, 12), image: dockerImage! })
      })
      toolOps = {
        bashOperations: dockerOps.bash,
        bashCwd: CONTAINER_WORKSPACE
      }
    }
    // hostCwd 用于 read/write/edit（本地 fs），bashCwd 用于 bash（Docker 模式下为容器路径）
    const tools = createCodingTools(hostCwd, toolOps)

    // 在 system prompt 中附加工作目录信息
    let enhancedPrompt = systemPrompt
    if (workingDirectory) {
      if (useDocker) {
        // Docker 模式：bash 在容器中运行，路径是 CONTAINER_WORKSPACE；read/write/edit 在本地运行，路径是宿主机路径
        enhancedPrompt += `\n\n你可以使用 bash, read, write, edit 工具来操作文件系统。\n当前工作目录：${hostCwd}`
        enhancedPrompt += `\n但但意：bash 命令运行在 Docker 容器中（镜像: ${dockerImage}），工作目录将挂载到 ${CONTAINER_WORKSPACE}。`
        enhancedPrompt += `\n因此 bash 命令中请使用 ${CONTAINER_WORKSPACE} 作为工作路径，而 read/write/edit 工具中请使用 ${hostCwd}。`
      } else {
        enhancedPrompt += `\n\n当前工作目录：${hostCwd}\n你可以使用 bash, read, write, edit 工具来操作文件系统。所有相对路径都基于上述工作目录。`
      }
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: enhancedPrompt,
        model: resolvedModel,
        thinkingLevel: caps.reasoning ? 'medium' : 'off',
        messages: [],
        tools
      },
      streamFn: (streamModel, context, options) => {
        // 动态查找当前模型对应提供商的 apiKey（支持运行时切换提供商）
        const currentProvider = providerDao.findById(String(streamModel.provider))
        const resolvedApiKey = currentProvider?.apiKey || apiKey
        try {
          return streamSimple(streamModel, context, {
            ...(options || {}),
            ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
            onPayload: (payload) => {
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
          })
        } catch (err: any) {
          // streamFn 抛出同步错误时，立即通知渲染进程
          console.error(`[Agent] streamFn 错误: ${err.message}`)
          this.sendToRenderer({ type: 'error', sessionId, error: err.message || String(err) })
          throw err
        }
      }
    })

    this.agents.set(sessionId, agent)
    this.agentConfigs.set(sessionId, newConfig)

    // 订阅 Agent 事件，转发到 Renderer（携带 sessionId）
    agent.subscribe((event: AgentEvent) => {
      this.forwardEvent(sessionId, event)
    })
    return true
  }

  /** 向指定 session 的 Agent 发送消息（支持附带图片） */
  async prompt(sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>): Promise<void> {
    const agent = this.agents.get(sessionId)
    if (!agent) {
      console.log(`[Agent] prompt 失败，未找到 session=${sessionId}`)
      this.sendToRenderer({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }

    console.log(`[Agent] prompt session=${sessionId} text=${text.slice(0, 50)}... images=${images?.length || 0}`)
    try {
      if (images && images.length > 0) {
        await agent.prompt(text, images)
      } else {
        await agent.prompt(text)
      }
    } catch (err: any) {
      this.sendToRenderer({ type: 'error', sessionId, error: err.message || String(err) })
    }
  }

  /** 中止指定 session 的生成 */
  abort(sessionId: string): void {
    console.log(`[Agent] 中止 session=${sessionId}`)
    this.agents.get(sessionId)?.abort()
  }

  /** 切换指定 session 的模型 */
  setModel(sessionId: string, provider: string, model: string, baseUrl?: string, apiProtocol?: string): void {
    const agent = this.agents.get(sessionId)
    if (!agent) return

    const providerInfo = providerDao.findById(provider)
    const isBuiltin = providerInfo?.isBuiltin ?? false
    let resolvedModel: Model<Api>

    // 从 DB 读取模型能力信息
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const caps: ModelCapabilities = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}

    if (!isBuiltin) {
      const inputModalities: string[] = ['text']
      if (caps.vision) inputModalities.push('image')
      const resolvedApi = (apiProtocol || providerInfo?.apiProtocol || 'openai-completions') as Api
      resolvedModel = {
        id: model,
        name: model,
        api: resolvedApi,
        provider,
        baseUrl: baseUrl || providerInfo?.baseUrl || '',
        reasoning: caps.reasoning ?? false,
        input: inputModalities as any,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: caps.maxInputTokens ?? 128000,
        maxTokens: caps.maxOutputTokens ?? 16384,
        ...(buildCustomProviderCompat(resolvedApi) ? { compat: buildCustomProviderCompat(resolvedApi) } : {})
      }
    } else {
      const slug = (providerInfo?.name || '').toLowerCase()
      resolvedModel = getModel(slug as any, model as any)
      if (baseUrl) {
        resolvedModel.baseUrl = baseUrl
      }
    }

    agent.setModel(resolvedModel)
    agent.setThinkingLevel(caps.reasoning ? 'medium' : 'off')
    console.log(`[Agent] 切换模型 session=${sessionId} provider=${provider} model=${model} reasoning=${caps.reasoning ? 'medium' : 'off'}`)
  }

  /** 获取指定 session 的消息列表 */
  getMessages(sessionId: string): any[] {
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
      console.warn(`[Agent] setThinkingLevel: session=${sessionId} agent不存在`)
      return
    }
    agent.setThinkingLevel(level)
    console.log(`[Agent] setThinkingLevel=${level}`)
  }

  /**
   * 让 AI 根据对话内容生成简短标题（后台静默调用，对用户透明）
   * 复用该 session 已有的模型配置
   */
  async generateTitle(sessionId: string, userMessage: string, assistantMessage: string): Promise<string | null> {
    const agent = this.agents.get(sessionId)
    if (!agent) return null

    try {
      // 查找当前模型对应提供商的 apiKey
      const currentProvider = providerDao.findById(String(agent.state.model.provider))
      const resolvedApiKey = currentProvider?.apiKey
      const result = await completeSimple(agent.state.model, {
        systemPrompt: '你是一个标题生成助手。根据用户和助手的首轮对话，生成一个简洁的中文标题（不超过20个字，不要加引号和标点符号）。只输出标题本身，不要有任何额外内容。',
        messages: [
          { role: 'user', content: [{ type: 'text', text: `用户: ${userMessage.slice(0, 500)}\n助手: ${assistantMessage.slice(0, 500)}` }], timestamp: Date.now() }
        ]
      }, resolvedApiKey ? { apiKey: resolvedApiKey } : {})
      // 从 AssistantMessage 中提取文本
      const text = result.content
        ?.filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')
        .trim()
      if (text && text.length > 0) {
        return text.slice(0, 30)
      }
    } catch (err) {
      console.error(`[Agent] 生成标题失败: ${err}`)
    }
    return null
  }

  /** 移除指定 session 的 Agent（删除会话时调用） */
  removeAgent(sessionId: string): void {
    const agent = this.agents.get(sessionId)
    if (agent) {
      agent.abort()
      this.agents.delete(sessionId)
      this.agentConfigs.delete(sessionId)
      this.pendingLogIds.delete(sessionId)
      // 清理 Docker 容器
      dockerManager.destroyContainer(sessionId).catch(() => {})
      console.log(`[Agent] 移除 session=${sessionId} 剩余=${this.agents.size}`)
    }
  }

  /** 判断 AgentMessage 是否为 AssistantMessage */
  private isAssistantMessage(message: AgentMessage): message is AssistantMessage {
    return message !== null && 'role' in message && message.role === 'assistant'
  }

  /** 将 pi-agent-core 事件转换并发送到 Renderer */
  private forwardEvent(sessionId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        console.log(`[Prompt] 开始 session=${sessionId}`)
        this.sendToRenderer({ type: 'agent_start', sessionId })
        break
      case 'agent_end': {
        console.log(`[Prompt] 结束 session=${sessionId}`)
        // Docker 模式下，回复完成后销毁容器
        dockerManager.destroyContainer(sessionId).catch((err) =>
            console.error(`[Docker] 销毁容器失败: ${err}`)
          ).then((destroyed) => {
            if (destroyed) this.emitDockerEvent(sessionId, 'container_destroyed')
          })
        // 检查 agent_end 中的消息是否携带错误信息
        const endMessages = (event as any).messages as any[] | undefined
        if (endMessages) {
          for (const m of endMessages) {
            if (m.errorMessage) {
              console.error(`[Agent] 流式错误: ${m.errorMessage}`)
              this.sendToRenderer({ type: 'error', sessionId, error: m.errorMessage })
            }
          }
        }
        this.sendToRenderer({ type: 'agent_end', sessionId })
        break
      }
      case 'message_update': {
        const msgEvent = event.assistantMessageEvent
        if (msgEvent.type === 'text_delta') {
          this.sendToRenderer({ type: 'text_delta', sessionId, data: msgEvent.delta })
        } else if (msgEvent.type === 'thinking_delta') {
          this.sendToRenderer({ type: 'thinking_delta', sessionId, data: msgEvent.delta })
        }
        break
      }
      case 'message_end': {
        // 如果是 assistant 消息，将 token 用量回填到对应的 HTTP 日志
        const msg = event.message
        if (this.isAssistantMessage(msg)) {
          // 检查流式响应中的错误（如 API 返回的错误）
          if (msg.stopReason === 'error' && msg.errorMessage) {
            console.error(`[Agent] API 错误: ${msg.errorMessage}`)
            this.sendToRenderer({ type: 'error', sessionId, error: msg.errorMessage })
          }
          const logId = this.pendingLogIds.get(sessionId)?.shift()
          if (logId) {
            const usage = msg.usage
            httpLogService.updateUsage(logId, usage.input, usage.output, usage.totalTokens)
          }
        }
        this.sendToRenderer({ type: 'text_end', sessionId })
        break
      }
      case 'tool_execution_start': {
        // 持久化工具调用消息
        const toolCallMsg = messageService.add({
          sessionId,
          role: 'assistant',
          type: 'tool_call',
          content: '',
          metadata: JSON.stringify({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args
          })
        })
        this.sendToRenderer({
          type: 'tool_start',
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolArgs: event.args,
          data: toolCallMsg.id
        })
        break
      }
      case 'tool_execution_end': {
        // 持久化工具结果消息
        const resultContent = event.result?.content
          ?.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
          .join('\n') || ''
        const toolResultMsg = messageService.add({
          sessionId,
          role: 'tool',
          type: 'tool_result',
          content: resultContent,
          metadata: JSON.stringify({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError || false
          })
        })
        this.sendToRenderer({
          type: 'tool_end',
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolResult: resultContent,
          toolIsError: event.isError || false,
          data: toolResultMsg.id
        })
        break
      }
      default:
        break
    }
  }

  /** 持久化 docker_event 消息并通知前端 */
  private emitDockerEvent(sessionId: string, action: string, extra?: Record<string, string>): void {
    const msg = messageService.add({
      sessionId,
      role: 'shirobot_notify',
      type: 'docker_event',
      content: action,
      metadata: extra ? JSON.stringify(extra) : null
    })
    this.sendToRenderer({ type: 'docker_event', sessionId, data: msg.id })
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
