import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core'
import { type AssistantMessage, type Model, type Api, getModel, streamSimple, completeSimple } from '@mariozechner/pi-ai'
import type { BrowserWindow } from 'electron'
import { httpLogService } from './httpLogService'
import { messageService } from './messageService'
import { providerDao } from '../dao/providerDao'
import { sessionDao } from '../dao/sessionDao'
import { projectDao } from '../dao/projectDao'
import { settingsDao } from '../dao/settingsDao'
import { getTempWorkspace } from '../utils/paths'
import { messageDao } from '../dao/messageDao'
import { createBashTool } from '../tools/bash'
import { createReadTool } from '../tools/read'
import { createWriteTool } from '../tools/write'
import { createEditTool } from '../tools/edit'
import { createAskTool } from '../tools/ask'
import { createListTool } from '../tools/ls'
import { createGrepTool } from '../tools/grep'
import { createGlobTool } from '../tools/glob'
import { createShuvixProjectTool } from '../tools/shuvixProject'
import { createShuvixSettingTool } from '../tools/shuvixSetting'
import { createSkillTool } from '../tools/skill'
import { resolveProjectConfig, type ToolContext } from '../tools/types'
import { clearSession as clearFileTimeSession } from '../tools/utils/fileTime'
import { dockerManager } from './dockerManager'
import type { AgentInitResult, ModelCapabilities, ThinkingLevel, Message } from '../types'
import { buildCustomProviderCompat } from './providerCompat'
import { t } from '../i18n'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { resolveEnabledTools, buildToolPrompts } from '../utils/tools'
import { mcpService } from './mcpService'
import { createTransformContext } from './contextManager'
import { createLogger } from '../logger'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
const log = createLogger('Agent')
export { ALL_TOOL_NAMES } from '../utils/tools'
export type { ToolName } from '../utils/tools'

/**
 * 内置提供商 → 环境变量名映射
 * pi-ai SDK 通过环境变量获取 API Key，此处将用户在 DB 中配置的 key 注入 process.env
 */
const BUILTIN_ENV_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  huggingface: 'HF_TOKEN',
  opencode: 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
  zai: 'ZAI_API_KEY',
}

/** 根据启用列表构建工具子集（内置 + MCP + Skill 合并） */
function buildTools(ctx: ToolContext, enabledTools: string[]): AgentTool<any>[] {
  // 内置工具
  const builtinAll: Record<string, AgentTool<any>> = {
    bash: createBashTool(ctx),
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    ask: createAskTool(ctx),
    ls: createListTool(ctx),
    grep: createGrepTool(ctx),
    glob: createGlobTool(ctx),
    'shuvix-project': createShuvixProjectTool(ctx),
    'shuvix-setting': createShuvixSettingTool(ctx)
  }
  // MCP 工具（动态），key = "mcp__<serverName>__<toolName>"
  const mcpAll: Record<string, AgentTool<any>> = {}
  for (const tool of mcpService.getAllAgentTools()) {
    mcpAll[tool.name] = tool
  }

  // 从 enabledTools 中提取 skill 名（skill:pdf → pdf）
  const enabledSkillNames = enabledTools
    .filter((n) => n.startsWith('skill:'))
    .map((n) => n.slice(6))

  // 合并内置 + MCP
  const all: Record<string, AgentTool<any>> = { ...builtinAll, ...mcpAll }

  // 有启用的 skill 时动态注册 skill 工具
  if (enabledSkillNames.length > 0) {
    all['skill'] = createSkillTool(enabledSkillNames)
  }

  // 过滤：排除 skill: 前缀项（它们通过 skill 工具统一处理）
  const regularTools = enabledTools
    .filter((name) => !name.startsWith('skill:'))
    .filter((name) => name in all)
    .map((name) => all[name])

  // 如果有 skill 工具，追加到末尾
  if (enabledSkillNames.length > 0 && all['skill']) {
    regularTools.push(all['skill'])
  }

  return regularTools
}

/** 从图片对象中提取 raw base64：优先用 data，否则从 preview (data URL) 截取 */
function extractBase64(img: any): string {
  if (img.data) return img.data
  if (typeof img.preview === 'string' && img.preview.includes(',')) {
    return img.preview.split(',')[1]
  }
  return ''
}

/** 读取项目根目录指令文件（不存在或读取失败时返回空） */
function readProjectInstructionMd(projectPath: string, fileName: 'AGENT.md' | 'CLAUDE.md'): string {
  const filePath = join(projectPath, fileName)
  if (!existsSync(filePath)) return ''
  try {
    return readFileSync(filePath, 'utf-8').trim()
  } catch (err: any) {
    log.warn(`读取 ${fileName} 失败: ${filePath} (${err?.message || String(err)})`)
    return ''
  }
}

/** 会话级项目指令文件加载状态（由 AgentService 统一维护） */
interface ProjectInstructionLoadState {
  agentMdLoaded: boolean
  claudeMdLoaded: boolean
}

/**
 * 将数据库消息转换为 pi-agent-core 的 AgentMessage 格式
 * 处理 text / tool_call / tool_result 等类型，跳过 system_notify
 */
export function dbMessagesToAgentMessages(msgs: Message[]): AgentMessage[] {
  const result: AgentMessage[] = []
  let i = 0
  while (i < msgs.length) {
    const msg = msgs[i]

    // 跳过系统通知
    if (msg.role === 'system_notify' || msg.role === 'system') { i++; continue }

    // 用户消息（可能包含图片）
    if (msg.role === 'user') {
      let content: any = msg.content
      if (msg.metadata) {
        try {
          const meta = JSON.parse(msg.metadata)
          if (meta.images?.length) {
            content = [
              { type: 'text', text: msg.content },
              ...meta.images.map((img: any) => ({ type: 'image', data: extractBase64(img), mimeType: img.mimeType }))
            ]
          }
        } catch { /* 忽略 */ }
      }
      result.push({ role: 'user', content, timestamp: msg.createdAt } as any)
      i++; continue
    }

    // 助手文本消息
    if (msg.role === 'assistant' && msg.type === 'text') {
      const contentBlocks: any[] = []
      if (msg.metadata) {
        try {
          const meta = JSON.parse(msg.metadata)
          if (meta.thinking) contentBlocks.push({ type: 'thinking', thinking: meta.thinking })
        } catch { /* 忽略 */ }
      }
      contentBlocks.push({ type: 'text', text: msg.content })
      result.push({
        role: 'assistant', content: contentBlocks,
        api: 'openai-completions', provider: '', model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: msg.createdAt
      } as any)
      i++; continue
    }

    // 助手工具调用（连续的 tool_call 合并为一条 AssistantMessage）
    if (msg.role === 'assistant' && msg.type === 'tool_call') {
      const toolCalls: any[] = []
      const ts = msg.createdAt
      while (i < msgs.length && msgs[i].role === 'assistant' && msgs[i].type === 'tool_call') {
        const meta = msgs[i].metadata ? JSON.parse(msgs[i].metadata!) : {}
        toolCalls.push({ type: 'toolCall', id: meta.toolCallId || '', name: meta.toolName || '', arguments: meta.args || {} })
        i++
      }
      result.push({
        role: 'assistant', content: toolCalls,
        api: 'openai-completions', provider: '', model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse', timestamp: ts
      } as any)
      continue
    }

    // 工具结果消息
    if (msg.role === 'tool' && msg.type === 'tool_result') {
      const meta = msg.metadata ? JSON.parse(msg.metadata) : {}
      result.push({
        role: 'toolResult', toolCallId: meta.toolCallId || '', toolName: meta.toolName || '',
        content: [{ type: 'text', text: msg.content }], isError: meta.isError || false, timestamp: msg.createdAt
      } as any)
      i++; continue
    }

    i++ // 未知类型跳过
  }
  return result
}

// Agent 事件类型（用于 IPC 通信，每个事件都携带 sessionId）
export interface AgentStreamEvent {
  type: 'text_delta' | 'text_end' | 'thinking_delta' | 'agent_start' | 'agent_end' | 'error' | 'tool_start' | 'tool_end' | 'docker_event' | 'tool_approval_request' | 'user_input_request'
  sessionId: string
  data?: string
  error?: string
  // 工具调用相关字段
  toolCallId?: string
  toolName?: string
  toolArgs?: any
  toolResult?: any
  toolIsError?: boolean
  /** bash 工具在沙箱模式下需要用户审批 */
  approvalRequired?: boolean
  /** ask 工具始终需要用户输入 */
  userInputRequired?: boolean
  /** ask 工具：用户输入请求数据 */
  userInputPayload?: { question: string; options: Array<{ label: string; description: string }>; allowMultiple: boolean }
  // token 用量（agent_end 时携带：总计 + 各次 LLM 调用明细）
  usage?: {
    input: number; output: number; total: number
    details: Array<{ input: number; output: number; total: number; stopReason: string }>
  }
}

/**
 * Agent 服务 — 管理多个独立的 Agent 实例，按 sessionId 隔离
 * 每个 session 拥有自己的 Agent，互不影响
 */
export class AgentService {
  private agents = new Map<string, Agent>()
  /** 每个 session 的 AGENT.md / CLAUDE.md 加载状态 */
  private instructionLoadStates = new Map<string, ProjectInstructionLoadState>()
  /** 每个 session 的 ToolContext，用于动态重建工具 */
  private toolContexts = new Map<string, ToolContext>()
  private pendingLogIds = new Map<string, string[]>()
  /** 待审批的 bash 命令 Promise resolver，key = toolCallId */
  private pendingApprovals = new Map<string, { resolve: (result: { approved: boolean; reason?: string }) => void }>()
  /** 待用户选择的 ask 工具 Promise resolver，key = toolCallId */
  private pendingUserInputs = new Map<string, { resolve: (selections: string[]) => void }>()
  /** 每个 session 的流式内容缓冲区（后端累积 delta，用于 agent_end / abort 时统一落库） */
  private streamBuffers = new Map<string, { content: string; thinking: string }>()
  private mainWindow: BrowserWindow | null = null

  /** 绑定主窗口，用于发送 IPC 事件 */
  setWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /** 为指定 session 创建 Agent 实例（已存在则跳过）；返回会话元信息供前端同步 */
  createAgent(sessionId: string): AgentInitResult {
    // 查询会话信息
    const session = sessionDao.findById(sessionId)
    if (!session) {
      log.error(`创建失败，未找到 session=${sessionId}`)
      return { success: false, created: false, provider: '', model: '', capabilities: {}, modelMetadata: '', workingDirectory: '', enabledTools: [], agentMdLoaded: false, claudeMdLoaded: false }
    }

    const provider = session.provider || ''
    const model = session.model || ''
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const capabilities: ModelCapabilities = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}
    const project = session.projectId ? projectDao.findById(session.projectId) : undefined
    const workingDirectory = project?.path || getTempWorkspace(sessionId)
    const enabledTools = resolveEnabledTools(session.modelMetadata, project?.settings)
    const meta = { provider, model, capabilities, modelMetadata: session.modelMetadata || '', workingDirectory, enabledTools }

    // 已存在则跳过（工具通过 resolveProjectConfig 动态获取配置，无需重建）
    if (this.agents.has(sessionId)) {
      const instrState = this.instructionLoadStates.get(sessionId) || { agentMdLoaded: false, claudeMdLoaded: false }
      return { success: true, created: false, ...meta, ...instrState }
    }

    log.info(`创建 model=${model} session=${sessionId}`)

    let agentMdLoaded = false
    let claudeMdLoaded = false

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

      let referenceDirs: Array<{ path: string; note?: string }> = []
      try {
        const settings = JSON.parse(project.settings || '{}')
        if (Array.isArray(settings.referenceDirs)) referenceDirs = settings.referenceDirs
      } catch { /* 忽略 */ }
      if (referenceDirs.length > 0) {
        const lines = referenceDirs.map(d => d.note ? `- ${d.path} — ${d.note}` : `- ${d.path}`)
        systemPrompt += `\n\nReference directories (read-only, you can read files from these directories but CANNOT write or edit):\n${lines.join('\n')}`
      }
    } else {
      // 临时对话：注入临时工作目录
      systemPrompt += `\n\nWorking directory: ${getTempWorkspace(sessionId)}`
    }

    // 查询提供商信息，判断是否内置
    const providerInfo = providerDao.findById(provider)
    const isBuiltin = providerInfo?.isBuiltin ?? false
    let resolvedModel: Model<Api>
    const caps = capabilities

    if (!isBuiltin) {
      // 自定义提供商：手动构造 Model 对象，用 capabilities 填充
      const inputModalities: string[] = ['text']
      if (caps.vision) inputModalities.push('image')
      const resolvedApi = (providerInfo?.apiProtocol || 'openai-completions') as Api
      resolvedModel = {
        id: model,
        name: model,
        api: resolvedApi,
        provider,
        baseUrl: providerInfo?.baseUrl || '',
        reasoning: caps.reasoning ?? false,
        input: inputModalities as any,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: caps.maxInputTokens ?? 128000,
        maxTokens: caps.maxOutputTokens ?? 16384,
        ...(buildCustomProviderCompat(resolvedApi) ? { compat: buildCustomProviderCompat(resolvedApi) } : {})
      }
    } else {
      // 内置提供商：通过 SDK 解析（name 即 pi-ai 的 provider slug）
      const slug = (providerInfo?.name || '').toLowerCase()
      if (providerInfo?.apiKey) {
        const envKey = BUILTIN_ENV_MAP[slug]
        if (envKey) {
          process.env[envKey] = providerInfo.apiKey
        }
      }
      resolvedModel = getModel(slug as any, model as any)
      if (providerInfo?.baseUrl) {
        resolvedModel.baseUrl = providerInfo.baseUrl
      }
      // 为 Kimi Coding 注入 coding agent 标识（Kimi API 要求特定 User-Agent）
      if (resolvedModel.baseUrl?.includes('api.kimi.com')) {
        resolvedModel.headers = { ...resolvedModel.headers, 'User-Agent': 'Claude-Code/1.0.0' }
      }
    }

    // 创建工具集（通过 sessionId 动态查询项目配置）
    const ctx: ToolContext = {
      sessionId,
      onContainerCreated: (containerId) => {
        this.emitDockerEvent(sessionId, 'container_created', {
          containerId: containerId.slice(0, 12)
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
      requestUserInput: (toolCallId: string, payload: { question: string; options: Array<{ label: string; description: string }>; allowMultiple: boolean }) => {
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
        thinkingLevel: caps.reasoning ? 'medium' : 'off',
        messages: [],
        tools
      },
      transformContext: createTransformContext(resolvedModel),
      streamFn: (streamModel, context, options) => {
        // 动态查找当前模型对应提供商的 apiKey（支持运行时切换提供商）
        const currentProvider = providerDao.findById(String(streamModel.provider))
        const resolvedApiKey = currentProvider?.apiKey
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
          log.error(`streamFn 错误: ${err.message}`)
          this.sendToRenderer({ type: 'error', sessionId, error: err.message || String(err) })
          throw err
        }
      }
    })

    // 将项目 AGENT.md / CLAUDE.md 作为独立的用户消息注入
    if (project) {
      const agentMd = readProjectInstructionMd(project.path, 'AGENT.md')
      if (agentMd) {
        agentMdLoaded = true
        agent.state.messages.push({
          role: 'user',
          content: `Project AGENT.md instructions:\n${agentMd}`,
          timestamp: Date.now()
        } as any)
      }

      const claudeMd = readProjectInstructionMd(project.path, 'CLAUDE.md')
      if (claudeMd) {
        claudeMdLoaded = true
        agent.state.messages.push({
          role: 'user',
          content: `Project CLAUDE.md instructions:\n${claudeMd}`,
          timestamp: Date.now()
        } as any)
      }
    }

    this.instructionLoadStates.set(sessionId, { agentMdLoaded, claudeMdLoaded })

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

    return { success: true, created: true, ...meta, agentMdLoaded, claudeMdLoaded }
  }

  /** 向指定 session 的 Agent 发送消息（支持附带图片） */
  async prompt(sessionId: string, text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>): Promise<void> {
    const agent = this.agents.get(sessionId)
    if (!agent) {
      log.warn(`prompt 失败，未找到 session=${sessionId}`)
      this.sendToRenderer({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }

    log.info(`prompt session=${sessionId} text=${text.slice(0, 50)}... images=${images?.length || 0}`)
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

  /** 中止指定 session 的生成；若已有部分内容则持久化并返回 */
  abort(sessionId: string): Message | null {
    log.info(`中止 session=${sessionId}`)
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
    // 持久化已生成的部分内容（与 agent_end 共用落库逻辑）
    return this.persistStreamBuffer(sessionId)
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
      if (providerInfo?.apiKey) {
        const envKey = BUILTIN_ENV_MAP[slug]
        if (envKey) {
          process.env[envKey] = providerInfo.apiKey
        }
      }
      resolvedModel = getModel(slug as any, model as any)
      if (baseUrl) {
        resolvedModel.baseUrl = baseUrl
      }
      // 为 Kimi Coding 注入 coding agent 标识
      if (resolvedModel.baseUrl?.includes('api.kimi.com')) {
        resolvedModel.headers = { ...resolvedModel.headers, 'User-Agent': 'Claude-Code/1.0.0' }
      }
    }

    agent.setModel(resolvedModel)
    agent.setThinkingLevel(caps.reasoning ? 'medium' : 'off')
    log.info(`切换模型 session=${sessionId} provider=${provider} model=${model} reasoning=${caps.reasoning ? 'medium' : 'off'}`)
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
    return this.instructionLoadStates.get(sessionId) || { agentMdLoaded: false, claudeMdLoaded: false }
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
  async generateTitle(sessionId: string, userMessage: string, assistantMessage: string): Promise<string | null> {
    const agent = this.agents.get(sessionId)
    if (!agent) return null

    try {
      // 查找当前模型对应提供商的 apiKey
      const currentProvider = providerDao.findById(String(agent.state.model.provider))
      const resolvedApiKey = currentProvider?.apiKey
      const result = await completeSimple(agent.state.model, {
        systemPrompt: t('agent.titleGenPrompt'),
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
      log.error(`生成标题失败: ${err}`)
    }
    return null
  }

  /** 使指定 session 的 Agent 失效（回退时使用，不销毁 Docker，下次 init 会重建） */
  invalidateAgent(sessionId: string): void {
    const agent = this.agents.get(sessionId)
    if (agent) {
      agent.abort()
      this.agents.delete(sessionId)
      this.instructionLoadStates.delete(sessionId)
      clearFileTimeSession(sessionId)
      // 保留 pendingLogIds / Docker 容器，下次 createAgent 会自动复用
      log.info(`invalidate session=${sessionId}`)
    }
  }

  /** 移除指定 session 的 Agent（删除会话时调用） */
  removeAgent(sessionId: string): void {
    const agent = this.agents.get(sessionId)
    if (agent) {
      agent.abort()
      this.agents.delete(sessionId)
      this.instructionLoadStates.delete(sessionId)
      this.pendingLogIds.delete(sessionId)
      clearFileTimeSession(sessionId)
      // 立刻清理 Docker 容器（会话删除）
      dockerManager.destroyContainer(sessionId).then((containerId) => {
        if (containerId) {
          this.emitDockerEvent(sessionId, 'container_destroyed', {
            containerId: containerId.slice(0, 12),
            reason: 'session_deleted'
          })
        }
      }).catch(() => {})
      log.info(`移除 session=${sessionId} 剩余=${this.agents.size}`)
    }
  }

  /**
   * 将流式缓冲区内容持久化为 assistant 消息（agent_end / abort 共用）
   * 同时同步到 Agent 内存上下文，确保后续 prompt 包含该消息
   * @returns 已保存的消息，如果缓冲区为空则返回 null
   */
  private persistStreamBuffer(sessionId: string, extraMeta?: Record<string, any>): Message | null {
    const buf = this.streamBuffers.get(sessionId)
    if (!buf?.content) {
      this.streamBuffers.delete(sessionId)
      return null
    }

    const meta: Record<string, any> = { ...extraMeta }
    if (buf.thinking) meta.thinking = buf.thinking
    const session = sessionDao.findById(sessionId)

    const msg = messageService.add({
      sessionId,
      role: 'assistant',
      content: buf.content,
      metadata: Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined,
      model: session?.model || ''
    })

    // 同步到 Agent 内存上下文
    this.appendAssistantToAgent(sessionId, buf.content, buf.thinking)
    this.streamBuffers.delete(sessionId)
    return msg
  }

  /** 向 Agent 内存上下文追加一条 assistant 消息（结构与 dbMessagesToAgentMessages 一致） */
  private appendAssistantToAgent(sessionId: string, content: string, thinking?: string): void {
    const agent = this.agents.get(sessionId)
    if (!agent) return
    const contentBlocks: any[] = []
    if (thinking) contentBlocks.push({ type: 'thinking', thinking })
    contentBlocks.push({ type: 'text', text: content })
    agent.state.messages.push({
      role: 'assistant',
      content: contentBlocks,
      api: 'openai-completions',
      provider: '',
      model: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now()
    } as any)
  }

  /** 判断 AgentMessage 是否为 AssistantMessage */
  private isAssistantMessage(message: AgentMessage): message is AssistantMessage {
    return message !== null && 'role' in message && message.role === 'assistant'
  }

  /** 将 pi-agent-core 事件转换并发送到 Renderer */
  private forwardEvent(sessionId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        log.info(`开始 session=${sessionId}`)
        // 清空流式缓冲区（新一轮生成）
        this.streamBuffers.set(sessionId, { content: '', thinking: '' })
        this.sendToRenderer({ type: 'agent_start', sessionId })
        break
      case 'agent_end': {
        log.info(`结束 session=${sessionId}`)
        // Docker 模式下，回复完成后延迟销毁容器（空闲超时后自动清理）
        dockerManager.scheduleDestroy(sessionId, (containerId) => {
          this.emitDockerEvent(sessionId, 'container_destroyed', {
            containerId: containerId.slice(0, 12),
            reason: 'idle'
          })
        })
        // 检查 agent_end 中的消息是否携带错误信息
        const endMessages = (event as any).messages as any[] | undefined
        if (endMessages) {
          for (const m of endMessages) {
            if (m.errorMessage) {
              log.error(`流式错误: ${m.errorMessage}`)
              this.sendToRenderer({ type: 'error', sessionId, error: m.errorMessage })
            }
          }
        }
        // 从 agent_end 自带的 messages 中提取每条 AssistantMessage 的 token 用量
        const details: Array<{ input: number; output: number; cacheRead: number; total: number; stopReason: string }> = []
        const msgs = (event as any).messages as AgentMessage[] | undefined
        if (msgs) {
          for (const m of msgs) {
            if (this.isAssistantMessage(m) && m.usage) {
              details.push({
                input: m.usage.input || 0,
                output: m.usage.output || 0,
                cacheRead: m.usage.cacheRead || 0,
                total: m.usage.totalTokens || 0,
                stopReason: m.stopReason || ''
              })
            }
          }
        }
        const totalUsage = details.reduce((acc, d) => ({
          input: acc.input + d.input, output: acc.output + d.output, cacheRead: acc.cacheRead + d.cacheRead, total: acc.total + d.total
        }), { input: 0, output: 0, cacheRead: 0, total: 0 })
        // 后端统一落库：将缓冲区内容持久化为 assistant 消息（携带 usage）
        const savedMsg = this.persistStreamBuffer(sessionId, totalUsage.total > 0 ? { usage: { ...totalUsage, details } } : {})
        this.sendToRenderer({
          type: 'agent_end', sessionId,
          usage: { ...totalUsage, details },
          data: savedMsg ? JSON.stringify(savedMsg) : undefined
        })
        break
      }
      case 'message_update': {
        const msgEvent = event.assistantMessageEvent
        if (msgEvent.type === 'text_delta') {
          // 后端累积 delta（用于 agent_end / abort 时落库）
          const buf = this.streamBuffers.get(sessionId) || { content: '', thinking: '' }
          buf.content += msgEvent.delta || ''
          this.streamBuffers.set(sessionId, buf)
          // 仍转发给前端用于实时 UI 展示
          this.sendToRenderer({ type: 'text_delta', sessionId, data: msgEvent.delta })
        } else if (msgEvent.type === 'thinking_delta') {
          const buf = this.streamBuffers.get(sessionId) || { content: '', thinking: '' }
          buf.thinking += msgEvent.delta || ''
          this.streamBuffers.set(sessionId, buf)
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
            log.error(`API 错误: ${msg.errorMessage}`)
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
        const sessionForTool = sessionDao.findById(sessionId)
        const toolCallMsg = messageService.add({
          sessionId,
          role: 'assistant',
          type: 'tool_call',
          content: '',
          metadata: JSON.stringify({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args
          }),
          model: sessionForTool?.model || ''
        })
        // 检查工具是否需要用户审批（bash 沙箱模式 / shuvix-project update / shuvix-setting set）
        let approvalRequired = false
        if (event.toolName === 'bash') {
          const config = resolveProjectConfig({ sessionId })
          approvalRequired = config.sandboxEnabled
        } else if (event.toolName === 'shuvix-project' && event.args?.action === 'update') {
          approvalRequired = true
        } else if (event.toolName === 'shuvix-setting' && event.args?.action === 'set') {
          approvalRequired = true
        }
        // ask 工具始终需要用户输入（与 bash 审批同模式，直接在 tool_start 携带标记）
        const userInputRequired = event.toolName === 'ask'
        this.sendToRenderer({
          type: 'tool_start',
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolArgs: event.args,
          data: toolCallMsg.id,
          approvalRequired,
          userInputRequired
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
      role: 'system_notify',
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
