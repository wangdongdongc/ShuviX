import { v4 as uuidv4 } from 'uuid'
import { sessionDao } from '../dao/sessionDao'
import { messageDao } from '../dao/messageDao'
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

  /** 获取单个会话 */
  getById(id: string): Session | undefined {
    return sessionDao.findById(id)
  }

  /** 创建新会话 */
  create(params?: Partial<Session>): Session {
    const now = Date.now()
    const session: Session = {
      id: uuidv4(),
      title: params?.title || '新对话',
      provider: params?.provider || 'openai',
      model: params?.model || 'gpt-4o-mini',
      systemPrompt: params?.systemPrompt || 'You are a helpful assistant.',
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

  /** 删除会话（同时清理关联消息） */
  delete(id: string): void {
    messageDao.deleteBySessionId(id)
    sessionDao.deleteById(id)
  }
}

export const sessionService = new SessionService()
