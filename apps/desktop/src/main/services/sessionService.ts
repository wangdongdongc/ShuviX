import { v7 as uuidv7 } from 'uuid'
import { join, basename } from 'path'
import { rmSync, existsSync } from 'fs'
import { sessionDao } from '../dao/sessionDao'
import { messageService } from './messageService'
import { httpLogDao } from '../dao/httpLogDao'
import { providerDao } from '../dao/providerDao'
import { projectDao } from '../dao/projectDao'
import { settingsDao } from '../dao/settingsDao'
import { t } from '../i18n'
import { getTempWorkspace, getToolResultsBase } from '../utils/paths'
import { getDefaultEnabledTools, filterAvailableTools } from './toolAggregator'
import { getBuiltinToolEntries } from './toolRegistry'
import { buildAllowEntry } from '../utils/toolUtils/allowList'
import type { AllowToolType } from '../utils/toolUtils/allowList'
import type {
  Session,
  SessionInfo,
  SessionCreateParams,
  SessionModelMetadata,
  AgentInitResult,
  ModelCapabilities
} from '../types'
import type { Project } from '../dao/types'

import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { DEFAULT_THINKING_LEVEL } from '@shuvix/chat-protocol/types/thinking'
import {
  SessionManager,
  resolveInitialThinkingLevel,
  toInProcessAgentType
} from '@shuvix/agent-runtime'
import type { SubAgentModelConfig, InProcessAgentType } from '@shuvix/agent-runtime'
import { agentService } from './agentService'
import { mcpService } from './mcpService'
import { AgentSession, buildSystemPrompt } from './agentSession'
import { scanInstructionFiles } from './instruction'
import type { InstructionFileEntry } from '@shuvix/chat-protocol/types/instructionFile'
import { broadcastSessionConfigChanged } from '../utils/sessionConfigBroadcast'
import { registerUserInputResolver } from './userInputBroker'
import { createLogger } from '../logger'

const log = createLogger('SessionService')

/**
 * 会话服务 — 管理会话 CRUD 与 AgentSession 运行时生命周期
 */
export class SessionService {
  /**
   * AgentSession 运行时生命周期（Map + 懒创建 + 失效/销毁）由共享 SessionManager 托管；
   * 构造（resolveSessionAgentContext + AgentSession.create）与清理（invalidate/destroy）经此注入。
   */
  private readonly agents = new SessionManager<AgentSession>({
    create: (sessionId) => {
      const ctx = this.resolveSessionAgentContext(sessionId)
      if (!ctx) {
        log.error(`创建 Agent 失败，未找到 session=${sessionId}`)
        return undefined
      }
      log.info(`创建 Agent model=${ctx.model} session=${sessionId}`)
      return AgentSession.create({
        sessionId,
        provider: ctx.provider,
        model: ctx.model,
        capabilities: ctx.capabilities,
        project: ctx.project,
        workingDirectory: ctx.workingDirectory,
        enabledTools: ctx.enabledTools,
        modelMetadata: ctx.modelMetadata
      })
    },
    dispose: (sessionId, agent, reason) => {
      // invalidate=回退重建（下次 ensure 重建），destroy/remove=删除会话
      if (reason === 'invalidate') agent.invalidate()
      else agent.destroy()
      log.info(`移除 AgentSession session=${sessionId} reason=${reason}`)
    }
  })

  // ─── DB CRUD ──────────────────────────────────

  /** 获取所有会话 */
  list(): Session[] {
    return sessionDao.findAll()
  }

  /** 获取单个会话（含计算属性 workingDirectory、enabledTools） */
  getById(id: string): SessionInfo | undefined {
    const session = sessionDao.findById(id)
    if (!session) return undefined
    const project = session.projectId
      ? projectDao.pick(session.projectId, ['path', 'settings'])
      : undefined
    const workingDirectory = project?.path || getTempWorkspace(id)
    const enabledTools = filterAvailableTools(
      session.modelMetadata.enabledTools ?? [],
      project?.path
    )
    return { ...session, workingDirectory, enabledTools }
  }

  /**
   * 创建新会话（后端自行获取默认 provider/model/systemPrompt，并持久化默认启用工具）。
   * params.notebookPath 非空时创建「笔记本会话」：绑定项目内的一个 md 文件、标题默认取 basename
   * （去后缀的标题由共享的 useCreateNotebook 显式传入 params.title）。
   */
  create(params?: SessionCreateParams): Session {
    const id = uuidv7()
    const pid = params?.projectId ?? null
    const notebookPath = params?.notebookPath
    const project = pid ? projectDao.pick(pid, ['path', 'settings']) : undefined
    const enabledTools = project?.settings?.enabledTools
      ? filterAvailableTools(project.settings.enabledTools, project.path)
      : getDefaultEnabledTools(project?.path)
    const now = Date.now()

    const session: Session = {
      id,
      title: params?.title ?? (notebookPath ? basename(notebookPath) : t('agent.defaultTitle')),
      projectId: pid,
      provider: this.getDefaultProvider(),
      model: this.getDefaultModel(),
      systemPrompt: settingsDao.findByKey('general.systemPrompt') || '',
      modelMetadata: { thinkingLevel: DEFAULT_THINKING_LEVEL, enabledTools },
      // 指令文件不预写配置：留空即「未显式配置」，注入时按 AGENTS.md → CLAUDE.md 优先级自动选
      settings: {
        ...(notebookPath ? { notebookPath } : {})
      },
      createdAt: now,
      updatedAt: now
    }
    sessionDao.insert(session)
    // 注：指令文件不在创建时注入。改为在用户首次发送 prompt 时按当前配置懒注入
    // （由 AgentSession.prompt 判定 agent 上下文是否为空），使得用户可以在
    // 创建会话后、发送第一条消息前任意切换配置。
    return session
  }

  /** 扫描指定会话工作目录顶层的候选指令文件 */
  scanInstructionFiles(sessionId: string): InstructionFileEntry[] {
    const info = this.getById(sessionId)
    if (!info?.workingDirectory) {
      log.info(`scanInstructionFiles: session=${sessionId} 无工作目录，返回空`)
      return []
    }
    return scanInstructionFiles(info.workingDirectory)
  }

  /** 更新会话注入的指令文件（单选；null = 不注入） */
  updateInstructionFile(sessionId: string, filename: string | null): void {
    log.info(`updateInstructionFile session=${sessionId} → ${filename ?? '(none)'}`)
    sessionDao.updateSettings(sessionId, { instructionFile: filename })
    const after = sessionDao.pick(sessionId, ['settings'])?.settings?.instructionFile
    log.info(`updateInstructionFile 写入后回读: ${after ?? '(none)'}`)
  }

  /** 更新会话标题 */
  updateTitle(id: string, title: string): void {
    sessionDao.updateTitle(id, title)
  }

  /** 更新会话模型配置（provider/model） */
  updateModelConfig(id: string, provider: string, model: string): void {
    sessionDao.updateModelConfig(id, provider, model)
  }

  /** 更新会话所属项目 */
  updateProjectId(id: string, projectId: string | null): void {
    sessionDao.updateProjectId(id, projectId)
  }

  /** 更新思考深度 */
  updateThinkingLevel(id: string, thinkingLevel: string): void {
    sessionDao.updateModelMetadata(id, { thinkingLevel })
  }

  /** 更新会话级启用工具列表 */
  updateEnabledTools(id: string, enabledTools: string[]): void {
    sessionDao.updateModelMetadata(id, { enabledTools })
  }

  /** 更新命令免审批（bash + ssh 统一开关） */
  updateAutoApprove(id: string, autoApprove: boolean): void {
    sessionDao.updateSettings(id, { autoApprove })
  }

  /** 批量添加路径到统一允许列表（按 toolType 自动加 `Read(...)`/`Write(...)` 前缀）
   *
   *  仅路径类:命令类工具(bash/ssh)不再有允许列表,逐条审批。
   */
  addAllowListPaths(id: string, toolType: AllowToolType, paths: string[]): void {
    const sess = sessionDao.pickSettings(id, ['allowList'])
    const list = sess?.allowList || []
    const prefixed = paths.map((p) => buildAllowEntry(toolType, p))
    const newEntries = prefixed.filter((p) => !list.includes(p))
    if (newEntries.length > 0) {
      sessionDao.updateSettings(id, { allowList: [...list, ...newEntries] })
      log.info(`addAllowListPaths session=${id} ${toolType} +${newEntries.length}`)
      broadcastSessionConfigChanged(id)
    }
  }

  /** 从统一允许列表移除条目 */
  removeAllowListEntry(id: string, entry: string): void {
    const sess = sessionDao.pickSettings(id, ['allowList'])
    const list = (sess?.allowList || []).filter((e) => e !== entry)
    sessionDao.updateSettings(id, { allowList: list })
    broadcastSessionConfigChanged(id)
  }

  /** 删除会话（同时清理 AgentSession、消息、HTTP 日志、Telegram 绑定和临时工作目录） */
  delete(id: string): void {
    // 先清理运行时 AgentSession（dispose 触发 destroy）
    this.agents.remove(id, 'destroy')
    // 清理 Telegram 绑定（异步，不阻塞删除）
    import('./telegram').then(({ telegramService }) => {
      telegramService.unbindSession(id).catch(() => {})
    })
    // 再清理持久化数据
    messageService.clear(id)
    httpLogDao.deleteBySessionId(id)
    sessionDao.deleteById(id)
    // 清理临时会话工作目录
    const tempDir = getTempWorkspace(id)
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
    // 清理工具大结果持久化目录
    const toolResultsDir = join(getToolResultsBase(), id)
    if (existsSync(toolResultsDir)) {
      try {
        rmSync(toolResultsDir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  }

  // ─── AgentSession 运行时管理 ──────────────────

  /** 获取指定 session 的 AgentSession（不创建） */
  getAgentSession(sessionId: string): AgentSession | undefined {
    return this.agents.get(sessionId)
  }

  /** 解析会话的 Agent 上下文元信息（provider/model/能力/工作目录/启用工具/项目），不创建 AgentSession。
   *  供 initAgent（前端同步）与 ensureAgentSession（懒创建）共用。session 不存在返回 null。 */
  private resolveSessionAgentContext(sessionId: string): {
    provider: string
    model: string
    capabilities: ModelCapabilities
    workingDirectory: string
    enabledTools: string[]
    project: Pick<Project, 'path' | 'promptSections' | 'settings'> | undefined
    modelMetadata: SessionModelMetadata
  } | null {
    const session = sessionDao.pick(sessionId, ['provider', 'model', 'projectId', 'modelMetadata'])
    if (!session) return null
    const provider = session.provider || ''
    const model = session.model || ''
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const capabilities: ModelCapabilities = modelRow?.capabilities
      ? JSON.parse(modelRow.capabilities)
      : {}
    const project = session.projectId
      ? projectDao.pick(session.projectId, ['path', 'promptSections', 'settings'])
      : undefined
    const workingDirectory = project?.path || getTempWorkspace(sessionId)
    const enabledTools = filterAvailableTools(
      session.modelMetadata.enabledTools ?? [],
      project?.path
    )
    return {
      provider,
      model,
      capabilities,
      workingDirectory,
      enabledTools,
      project,
      modelMetadata: session.modelMetadata
    }
  }

  /**
   * 返回会话元信息供前端同步（projectPath / 启用工具 / 模型能力 等）。
   * **不创建 AgentSession** —— Agent 延迟到用户首次发送消息时（ensureAgentSession）才创建，
   * 故仅打开会话（含笔记本会话）不会启动 Agent。
   */
  initAgent(sessionId: string): AgentInitResult {
    const ctx = this.resolveSessionAgentContext(sessionId)
    if (!ctx) {
      log.error(`初始化失败，未找到 session=${sessionId}`)
      return {
        success: false,
        created: false,
        provider: '',
        model: '',
        capabilities: {},
        modelMetadata: {},
        workingDirectory: '',
        enabledTools: []
      }
    }
    return {
      success: true,
      // created 现仅表示「Agent 此刻是否已存在」（已不在 init 时创建）
      created: this.agents.has(sessionId),
      provider: ctx.provider,
      model: ctx.model,
      capabilities: ctx.capabilities,
      modelMetadata: ctx.modelMetadata,
      workingDirectory: ctx.workingDirectory,
      enabledTools: ctx.enabledTools
    }
  }

  /**
   * 懒创建并返回指定 session 的 AgentSession（已存在直接返回）。
   * 首次发送消息 / 压缩 / 其它需要运行时 Agent 的操作调用；session 不存在返回 undefined。
   * 构造逻辑见 SessionManager 的 create 注入（resolveSessionAgentContext + AgentSession.create）。
   */
  ensureAgentSession(sessionId: string): Promise<AgentSession | undefined> {
    return this.agents.ensure(sessionId)
  }

  /** 使指定 session 的 Agent 失效（回退时使用，下次 ensure 会重建） */
  invalidateAgent(sessionId: string): void {
    this.agents.remove(sessionId, 'invalidate')
  }

  /**
   * 解析笔记本会话「一次性子智能体」的运行数据（systemPrompt + 工具白名单 + 模型 + 路径），不创建任何运行时。
   * 仅负责数据存取；信封组装与派发由 runNotebookTask（共享内核）完成。
   * 复用会话的完整工具集（剔除 ask，面板只读无法应答）+ 完整 systemPrompt + 模型。session 不存在返回 null。
   */
  buildNotebookRunParams(sessionId: string): {
    systemPrompt: string
    /** 子代理工具白名单（buildSubAgentTools 按名解析） */
    tools: string[]
    modelConfig: SubAgentModelConfig
    /** 绑定 md 的项目内相对路径（文件工具相对工作目录寻址）；供注入上下文告知子代理 */
    notebookPath: string
  } | null {
    const ctx = this.resolveSessionAgentContext(sessionId)
    if (!ctx) return null
    const notebookPath = sessionDao.pickSettings(sessionId, ['notebookPath'])?.notebookPath ?? ''
    // 子代理工具白名单（buildSubAgentTools 按名解析）：内置与主 Agent 同口径
    // （注册表 defaultEnabled，剔除 ask —— 笔记本面板只读无法应答）+ 会话启用的 mcp:/skill:。
    const builtinNames = getBuiltinToolEntries()
      .filter((e) => e.factory && e.defaultEnabled && e.name !== 'ask')
      .map((e) => e.name)
    const mcpSkill = ctx.enabledTools.filter((n) => n.startsWith('mcp:') || n.startsWith('skill:'))
    return {
      systemPrompt: buildSystemPrompt(ctx.project, ctx.workingDirectory, sessionId),
      tools: [...builtinNames, ...mcpSkill],
      modelConfig: {
        provider: ctx.provider,
        model: ctx.model,
        capabilities: ctx.capabilities,
        // 笔记本子代理继承会话所选思考深度（与主会话口径一致，经共享 helper 解析）
        thinkingLevel: resolveInitialThinkingLevel({
          persisted: ctx.modelMetadata.thinkingLevel,
          reasoning: ctx.capabilities.reasoning
        })
      },
      notebookPath
    }
  }

  /**
   * 用户直发派发（kind='agent' 斜杠命令 `/<agentName> <prompt>`）运行参数：
   * 具名 agent 定义 → 运行配置投影 + 会话模型配置。与 Agent 工具派发同一投影/requiredMcp
   * 校验口径；modelConfig 继承会话所选思考深度（与笔记本子代理一致）。
   */
  buildAgentDispatchRunParams(
    sessionId: string,
    agentName: string
  ): { agentType: InProcessAgentType; modelConfig: SubAgentModelConfig } | { error: string } {
    const ctx = this.resolveSessionAgentContext(sessionId)
    if (!ctx) return { error: `Session not found: ${sessionId}` }
    const def = agentService.getEnabled(agentName)
    if (!def) return { error: `Unknown agent "${agentName}"` }
    const missingMcp = (def.requiredMcp ?? []).filter((n) => !mcpService.isConnectedByName(n))
    if (missingMcp.length > 0) {
      const list = missingMcp.map((n) => `"${n}"`).join(', ')
      return {
        error: `Cannot run agent "${def.name}": required MCP server(s) not connected: ${list}. Configure the missing server(s) in MCP settings, then retry.`
      }
    }
    return {
      agentType: toInProcessAgentType(def),
      modelConfig: {
        provider: ctx.provider,
        model: ctx.model,
        capabilities: ctx.capabilities,
        thinkingLevel: resolveInitialThinkingLevel({
          persisted: ctx.modelMetadata.thinkingLevel,
          reasoning: ctx.capabilities.reasoning
        })
      }
    }
  }

  // ─── 用户输入响应路由(遍历所有 session 查找归属) ──

  /**
   * 统一响应入口:根据 requestId 找到归属 session 并把响应送达。
   * 所有类型的用户输入(审批 / 选择题 / SSH 凭证)都走这一个路径。
   */
  respondToInput(requestId: string, response: InputResponse): void {
    for (const session of this.agents.values()) {
      if (session.respondToInput(requestId, response)) return
    }
  }

  /**
   * 重建所有活跃 AgentSession 的工具集。
   * 调用方：sub-agent FS 变化（启用/禁用/refresh）后，让正在运行的会话立刻看到最新可用 agent 列表。
   * 实现：对每个会话用其当前 enabledTools 触发 setEnabledTools，间接重跑 buildTools。
   */
  rebuildToolsForAllSessions(): void {
    for (const [sid, agentSession] of this.agents.entries()) {
      const session = sessionDao.pick(sid, ['modelMetadata', 'projectId'])
      const projectPath = session?.projectId
        ? projectDao.pick(session.projectId, ['path'])?.path
        : undefined
      const enabledTools = filterAvailableTools(
        session?.modelMetadata.enabledTools ?? [],
        projectPath
      )
      agentSession.setEnabledTools(enabledTools)
    }
  }

  // ─── private ──────────────────────────────────

  /**
   * 获取默认提供商 ID。
   * 用户配置存在且依然处于启用状态时返回该值；否则返回空字符串（不做自动回退）。
   * 这样用户在设置中把默认显式选为「无」时，新会话也不会被静默配上某个模型。
   */
  private getDefaultProvider(): string {
    const configured = settingsDao.findByKey('general.defaultProvider')
    if (!configured) return ''
    const enabled = providerDao.findEnabled()
    return enabled.some((p) => p.id === configured) ? configured : ''
  }

  /**
   * 获取默认模型 ID。
   * 仅当 provider 已确定且配置模型仍处于启用列表中时返回该值；否则返回空字符串。
   */
  private getDefaultModel(): string {
    const providerId = this.getDefaultProvider()
    if (!providerId) return ''
    const configured = settingsDao.findByKey('general.defaultModel')
    if (!configured) return ''
    const models = providerDao.findEnabledModels(providerId)
    return models.some((m) => m.modelId === configured) ? configured : ''
  }
}

export const sessionService = new SessionService()

// 子代理审批通道：把子代理工具的 InputRequest 转发到父会话（表单出现在父会话对话流）。
// 经 userInputBroker 注册，避免 AgentManager 静态依赖 sessionService 形成循环。
registerUserInputResolver((sessionId, request) => {
  const agent = sessionService.getAgentSession(sessionId)
  if (!agent) {
    return Promise.reject(new Error(`Session ${sessionId} is not active`))
  }
  return agent.requestUserInput(request)
})
