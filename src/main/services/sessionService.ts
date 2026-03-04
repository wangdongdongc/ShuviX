import { v7 as uuidv7 } from 'uuid'
import { rmSync, existsSync } from 'fs'
import { sessionDao } from '../dao/sessionDao'
import { messageService } from './messageService'
import { httpLogDao } from '../dao/httpLogDao'
import { providerDao } from '../dao/providerDao'
import { projectDao } from '../dao/projectDao'
import { t } from '../i18n'
import { getTempWorkspace } from '../utils/paths'
import { resolveEnabledTools } from '../utils/tools'
import type { Session, SessionInfo, AgentInitResult, ModelCapabilities } from '../types'

import type { SshCredentialPayload } from '../tools/types'
import { AgentSession } from './agentSession'
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
    const project = session.projectId ? projectDao.findById(session.projectId) : undefined
    const workingDirectory = project?.path || getTempWorkspace(id)
    const enabledTools = resolveEnabledTools(session.modelMetadata.enabledTools, project?.settings)
    const { agentMdLoaded } = this.agentSessions.get(id)?.getInstructionLoadState() || {
      agentMdLoaded: false
    }
    return { ...session, workingDirectory, enabledTools, agentMdLoaded }
  }

  /** 创建新会话 */
  create(params?: Partial<Session>): Session {
    const now = Date.now()
    const id = uuidv7()

    const session: Session = {
      id,
      title: params?.title || t('agent.defaultTitle'),
      projectId: params?.projectId ?? null,
      provider: params?.provider || this.getDefaultProvider(),
      model: params?.model || this.getDefaultModel(),
      systemPrompt: params?.systemPrompt || 'You are a helpful assistant.',
      modelMetadata: params?.modelMetadata || {},
      settings: params?.settings || {},
      createdAt: now,
      updatedAt: now
    }
    sessionDao.insert(session)
    return session
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

  /** 更新 SSH 命令免审批 */
  updateSshAutoApprove(id: string, sshAutoApprove: boolean): void {
    sessionDao.updateSettings(id, { sshAutoApprove })
  }

  /** 删除会话（同时清理 AgentSession、消息、HTTP 日志和临时工作目录） */
  delete(id: string): void {
    // 先清理运行时 AgentSession
    const agent = this.agentSessions.get(id)
    if (agent) {
      agent.destroy()
      this.agentSessions.delete(id)
      log.info(`移除 AgentSession session=${id} 剩余=${this.agentSessions.size}`)
    }
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
  }

  // ─── AgentSession 运行时管理 ──────────────────

  /** 获取指定 session 的 AgentSession */
  getAgentSession(sessionId: string): AgentSession | undefined {
    return this.agentSessions.get(sessionId)
  }

  /** 初始化 Agent（已存在则跳过）；返回会话元信息供前端同步 */
  initAgent(sessionId: string): AgentInitResult {
    const session = sessionDao.findById(sessionId)
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
    const enabledTools = resolveEnabledTools(session.modelMetadata.enabledTools, project?.settings)
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
      const instrState = this.agentSessions.get(sessionId)!.getInstructionLoadState()
      return { success: true, created: false, ...meta, ...instrState }
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

    return {
      success: true,
      created: true,
      ...meta,
      ...agentSession.getInstructionLoadState()
    }
  }

  /** 使指定 session 的 Agent 失效（回退时使用，不销毁 Docker，下次 init 会重建） */
  invalidateAgent(sessionId: string): void {
    const s = this.agentSessions.get(sessionId)
    if (s) {
      s.invalidate()
      this.agentSessions.delete(sessionId)
    }
  }

  // ─── toolCallId-based 方法（遍历所有 session 查找归属） ──────

  /** 响应工具审批请求（前端用户点击允许/拒绝后调用） */
  approveToolCall(toolCallId: string, approved: boolean, reason?: string): void {
    for (const session of this.agentSessions.values()) {
      if (session.approveToolCall(toolCallId, approved, reason)) return
    }
  }

  /** 响应 ask 工具的用户选择 */
  respondToAsk(toolCallId: string, selections: string[]): void {
    for (const session of this.agentSessions.values()) {
      if (session.respondToAsk(toolCallId, selections)) return
    }
  }

  /** 响应 SSH 凭据输入（凭据不经过大模型，直接传给 sshManager） */
  respondToSshCredentials(toolCallId: string, credentials: SshCredentialPayload | null): void {
    for (const session of this.agentSessions.values()) {
      if (session.respondToSshCredentials(toolCallId, credentials)) return
    }
  }

  // ─── private ──────────────────────────────────

  /** 获取默认提供商 ID（第一个已启用的提供商） */
  private getDefaultProvider(): string {
    const enabled = providerDao.findEnabled()
    return enabled.length > 0 ? enabled[0].id : ''
  }

  /** 获取默认模型 ID（第一个已启用提供商的第一个已启用模型） */
  private getDefaultModel(): string {
    const providerId = this.getDefaultProvider()
    if (!providerId) return ''
    const models = providerDao.findEnabledModels(providerId)
    return models.length > 0 ? models[0].modelId : ''
  }
}

export const sessionService = new SessionService()
