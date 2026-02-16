import { v7 as uuidv7 } from 'uuid'
import { sessionDao } from '../dao/sessionDao'
import { messageDao } from '../dao/messageDao'
import type { DirContentsResult, Session } from '../types'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, existsSync, readdirSync, rmSync } from 'fs'

/**
 * 会话服务 — 编排会话相关的业务逻辑
 * 例如删除会话时需要同时清理消息
 */
/** 临时目录根路径 */
const SESSIONS_TMP_ROOT = join(tmpdir(), 'shirobot-sessions')

export class SessionService {
  /** 获取所有会话 */
  list(): Session[] {
    return sessionDao.findAll()
  }

  /** 获取单个会话 */
  getById(id: string): Session | undefined {
    return sessionDao.findById(id)
  }

  /** 创建新会话，自动创建临时工作目录 */
  create(params?: Partial<Session>): Session {
    const now = Date.now()
    const id = uuidv7()

    // 自动创建临时工作目录
    const workingDirectory = params?.workingDirectory || join(SESSIONS_TMP_ROOT, id)
    if (!existsSync(workingDirectory)) {
      mkdirSync(workingDirectory, { recursive: true })
    }

    const session: Session = {
      id,
      title: params?.title || '新对话',
      provider: params?.provider || 'openai',
      model: params?.model || 'gpt-4o-mini',
      systemPrompt: params?.systemPrompt || 'You are a helpful assistant.',
      workingDirectory,
      dockerEnabled: params?.dockerEnabled ?? 0,
      dockerImage: params?.dockerImage || 'ubuntu:latest',
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

  /** 更新工作目录 */
  updateWorkingDirectory(id: string, workingDirectory: string): void {
    // 确保目标目录存在
    if (!existsSync(workingDirectory)) {
      mkdirSync(workingDirectory, { recursive: true })
    }
    sessionDao.updateWorkingDirectory(id, workingDirectory)
  }

  /** 更新 Docker 配置 */
  updateDockerConfig(id: string, dockerEnabled: boolean, dockerImage?: string): void {
    sessionDao.updateDockerConfig(
      id,
      dockerEnabled ? 1 : 0,
      dockerImage || 'ubuntu:latest'
    )
  }

  /** 检查目录内容（用于删除确认弹窗） */
  checkDirContents(dirPath: string): DirContentsResult {
    if (!existsSync(dirPath)) {
      return { exists: false, isEmpty: true, files: [], totalCount: 0 }
    }
    try {
      const entries = readdirSync(dirPath)
      return {
        exists: true,
        isEmpty: entries.length === 0,
        files: entries.slice(0, 20),
        totalCount: entries.length
      }
    } catch {
      return { exists: false, isEmpty: true, files: [], totalCount: 0 }
    }
  }

  /** 删除会话（同时清理关联消息，可选清理临时目录） */
  delete(id: string, cleanDir = false): void {
    if (cleanDir) {
      const session = sessionDao.findById(id)
      if (session?.workingDirectory && this.isTempDirectory(session.workingDirectory)) {
        try {
          rmSync(session.workingDirectory, { recursive: true, force: true })
        } catch (err) {
          console.error(`[会话] 清理工作目录失败: ${err}`)
        }
      }
    }
    messageDao.deleteBySessionId(id)
    sessionDao.deleteById(id)
  }

  /** 判断是否为 ShiroBot 创建的临时目录 */
  private isTempDirectory(dirPath: string): boolean {
    return dirPath.startsWith(SESSIONS_TMP_ROOT)
  }
}

export const sessionService = new SessionService()
