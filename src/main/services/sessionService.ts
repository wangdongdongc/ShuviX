import { v7 as uuidv7 } from 'uuid'
import { join } from 'path'
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
import { extractPatterns, parseAllowEntry, buildAllowEntry } from '../utils/toolUtils/allowList'
import type { AllowToolType } from '../utils/toolUtils/allowList'
import type { Session, SessionInfo, AgentInitResult, ModelCapabilities } from '../types'

import type { InputResponse } from '../../shared/types/inputRequest'
import { AgentSession } from './agentSession'
import { scanInstructionFiles } from './instruction'
import type { InstructionFileEntry } from '../../shared/types/instructionFile'
import { broadcastSessionConfigChanged } from '../utils/sessionConfigBroadcast'
import { createLogger } from '../logger'

const log = createLogger('SessionService')

/**
 * 会话服务 — 管理会话 CRUD 与 AgentSession 运行时生命周期
 */
export class SessionService {
  private agentSessions = new Map<string, AgentSession>()

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

  /** 创建新会话（后端自行获取默认 provider/model/systemPrompt，并持久化默认启用工具） */
  create(projectId?: string | null): Session {
    const id = uuidv7()
    const pid = projectId ?? null
    const project = pid ? projectDao.pick(pid, ['path', 'settings']) : undefined
    const enabledTools = project?.settings?.enabledTools
      ? filterAvailableTools(project.settings.enabledTools, project.path)
      : getDefaultEnabledTools(project?.path)
    const now = Date.now()

    const session: Session = {
      id,
      title: t('agent.defaultTitle'),
      projectId: pid,
      provider: this.getDefaultProvider(),
      model: this.getDefaultModel(),
      systemPrompt: settingsDao.findByKey('general.systemPrompt') || '',
      modelMetadata: { enabledTools },
      settings: {},
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

  /** 更新会话启用的指令文件列表 */
  updateEnabledInstructionFiles(sessionId: string, filenames: string[]): void {
    log.info(`updateEnabledInstructionFiles session=${sessionId} → [${filenames.join(', ')}]`)
    sessionDao.updateSettings(sessionId, { enabledInstructionFiles: filenames })
    const after = sessionDao.pickSettings(sessionId, [
      'enabledInstructionFiles'
    ])?.enabledInstructionFiles
    log.info(`updateEnabledInstructionFiles 写入后回读: [${(after ?? []).join(', ')}]`)
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

  /** 预览命令拆解后生成的通配符模式（纯函数，不写入 DB）
   *  如果传入 sessionId + toolType，会过滤掉已在允许列表中的模式
   *
   *  注:仅用于命令类(bash/ssh)的"允许并记住"模式预览。read/write 路径审批
   *  不走该流程,直接 remember 整路径。
   */
  previewAllowPatterns(command: string, sessionId?: string, toolType?: 'bash' | 'ssh'): string[] {
    const patterns = extractPatterns(command)
    if (!sessionId || !toolType) return patterns
    const sess = sessionDao.pickSettings(sessionId, ['allowList'])
    const existing = new Set(
      (sess?.allowList || [])
        .map(parseAllowEntry)
        .filter((e): e is NonNullable<typeof e> => e !== null && e.toolType === toolType)
        .map((e) => e.pattern)
    )
    return patterns.filter((p) => !existing.has(p))
  }

  /** 批量添加通配符/路径模式到统一允许列表（按 toolType 自动加前缀） */
  addAllowListPatterns(id: string, toolType: AllowToolType, patterns: string[]): void {
    const sess = sessionDao.pickSettings(id, ['allowList'])
    const list = sess?.allowList || []
    const prefixed = patterns.map((p) => buildAllowEntry(toolType, p))
    const newEntries = prefixed.filter((p) => !list.includes(p))
    if (newEntries.length > 0) {
      sessionDao.updateSettings(id, { allowList: [...list, ...newEntries] })
      log.info(`addAllowListPatterns session=${id} ${toolType} +${newEntries.length}`)
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
    // 先清理运行时 AgentSession
    const agent = this.agentSessions.get(id)
    if (agent) {
      agent.destroy()
      this.agentSessions.delete(id)
      log.info(`移除 AgentSession session=${id} 剩余=${this.agentSessions.size}`)
    }
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

  /** 获取指定 session 的 AgentSession */
  getAgentSession(sessionId: string): AgentSession | undefined {
    return this.agentSessions.get(sessionId)
  }

  /** 初始化 Agent（已存在则跳过）；返回会话元信息供前端同步 */
  initAgent(sessionId: string): AgentInitResult {
    const session = sessionDao.pick(sessionId, ['provider', 'model', 'projectId', 'modelMetadata'])
    if (!session) {
      log.error(`创建失败，未找到 session=${sessionId}`)
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
    const meta = {
      provider,
      model,
      capabilities,
      modelMetadata: session.modelMetadata,
      workingDirectory,
      enabledTools
    }

    // 已存在则跳过
    if (this.agentSessions.has(sessionId)) {
      return { success: true, created: false, ...meta }
    }

    log.info(`创建 Agent model=${model} session=${sessionId}`)
    const agentSession = AgentSession.create({
      sessionId,
      provider,
      model,
      capabilities,
      project,
      workingDirectory,
      enabledTools,
      modelMetadata: session.modelMetadata
    })
    this.agentSessions.set(sessionId, agentSession)

    return { success: true, created: true, ...meta }
  }

  /** 使指定 session 的 Agent 失效（回退时使用，下次 init 会重建） */
  invalidateAgent(sessionId: string): void {
    const s = this.agentSessions.get(sessionId)
    if (s) {
      s.invalidate()
      this.agentSessions.delete(sessionId)
    }
  }

  // ─── 用户输入响应路由(遍历所有 session 查找归属) ──

  /**
   * 统一响应入口:根据 requestId 找到归属 session 并把响应送达。
   * 所有类型的用户输入(审批 / 选择题 / SSH 凭证)都走这一个路径。
   */
  respondToInput(requestId: string, response: InputResponse): void {
    for (const session of this.agentSessions.values()) {
      if (session.respondToInput(requestId, response)) return
    }
  }

  /**
   * 重建所有活跃 AgentSession 的工具集。
   * 调用方：sub-agent FS 变化（启用/禁用/refresh）后，让正在运行的会话立刻看到最新可用 agent 列表。
   * 实现：对每个会话用其当前 enabledTools 触发 setEnabledTools，间接重跑 buildTools。
   */
  rebuildToolsForAllSessions(): void {
    for (const [sid, agentSession] of this.agentSessions) {
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
