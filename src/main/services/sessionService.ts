import { v7 as uuidv7 } from 'uuid'
import { join } from 'path'
import { rmSync, existsSync } from 'fs'
import { app } from 'electron'
import { sessionDao } from '../dao/sessionDao'
import { messageDao } from '../dao/messageDao'
import { httpLogDao } from '../dao/httpLogDao'
import { providerDao } from '../dao/providerDao'
import { projectDao } from '../dao/projectDao'
import { t } from '../i18n'
import type { Session } from '../types'

/**
 * 会话服务 — 编排会话相关的业务逻辑
 * 例如删除会话时需要同时清理消息
 */

export class SessionService {
  /** 获取所有会话 */
  list(): Session[] {
    return sessionDao.findAll()
  }

  /** 获取单个会话（含计算属性 workingDirectory） */
  getById(id: string): Session | undefined {
    const session = sessionDao.findById(id)
    if (!session) return undefined
    const project = session.projectId ? projectDao.findById(session.projectId) : undefined
    return { ...session, workingDirectory: project?.path || process.cwd() }
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
      modelMetadata: params?.modelMetadata || '{}',
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

  /** 更新模型元数据（思考深度等） */
  updateModelMetadata(id: string, modelMetadata: string): void {
    sessionDao.updateModelMetadata(id, modelMetadata)
  }

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

  /** 删除会话（同时清理关联消息、HTTP 日志和临时工作目录） */
  delete(id: string): void {
    messageDao.deleteBySessionId(id)
    httpLogDao.deleteBySessionId(id)
    sessionDao.deleteById(id)
    // 清理临时会话工作目录
    const tempDir = join(app.getPath('userData'), 'temp_workspace', id)
    if (existsSync(tempDir)) {
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }
}

export const sessionService = new SessionService()
