import { ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { agentService } from '../services/agent'
import { storageService, type Session, type Message } from '../services/storage'

/**
 * 注册所有 IPC 处理器
 * 连接 Renderer Process 和 Main Process 的服务层
 */
export function registerIpcHandlers(): void {
  // ============ Agent 相关 ============

  /** 初始化 Agent（切换会话时调用） */
  ipcMain.handle('agent:init', (_event, params: {
    provider: string
    model: string
    systemPrompt: string
    apiKey?: string
    baseUrl?: string
    messages?: Array<{ role: string; content: string }>
  }) => {
    agentService.createAgent(params.provider, params.model, params.systemPrompt, params.apiKey, params.baseUrl)

    // 如果有历史消息，恢复到 Agent 状态
    if (params.messages && params.messages.length > 0) {
      const agentMessages = params.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: [{ type: 'text' as const, text: m.content }],
        timestamp: Date.now()
      }))
      for (const msg of agentMessages) {
        agentService.getMessages().push(msg as any)
      }
    }

    return { success: true }
  })

  /** 发送消息 */
  ipcMain.handle('agent:prompt', async (_event, text: string) => {
    await agentService.prompt(text)
    return { success: true }
  })

  /** 中止生成 */
  ipcMain.handle('agent:abort', () => {
    agentService.abort()
    return { success: true }
  })

  /** 切换模型 */
  ipcMain.handle('agent:setModel', (_event, params: { provider: string; model: string; baseUrl?: string }) => {
    agentService.setModel(params.provider, params.model, params.baseUrl)
    return { success: true }
  })

  // ============ 会话管理 ============

  /** 获取所有会话 */
  ipcMain.handle('session:list', () => {
    return storageService.getSessions()
  })

  /** 创建新会话 */
  ipcMain.handle('session:create', (_event, params?: Partial<Session>) => {
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
    return storageService.createSession(session)
  })

  /** 更新会话标题 */
  ipcMain.handle('session:updateTitle', (_event, params: { id: string; title: string }) => {
    storageService.updateSessionTitle(params.id, params.title)
    return { success: true }
  })

  /** 删除会话 */
  ipcMain.handle('session:delete', (_event, id: string) => {
    storageService.deleteSession(id)
    return { success: true }
  })

  // ============ 消息管理 ============

  /** 获取会话消息 */
  ipcMain.handle('message:list', (_event, sessionId: string) => {
    return storageService.getMessages(sessionId)
  })

  /** 保存消息 */
  ipcMain.handle('message:add', (_event, params: {
    sessionId: string
    role: 'user' | 'assistant'
    content: string
  }) => {
    const message: Message = {
      id: uuidv4(),
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      createdAt: Date.now()
    }
    return storageService.addMessage(message)
  })

  /** 清空会话消息 */
  ipcMain.handle('message:clear', (_event, sessionId: string) => {
    storageService.clearMessages(sessionId)
    return { success: true }
  })

  // ============ 设置管理 ============

  /** 获取所有设置 */
  ipcMain.handle('settings:getAll', () => {
    return storageService.getAllSettings()
  })

  /** 获取单个设置 */
  ipcMain.handle('settings:get', (_event, key: string) => {
    return storageService.getSetting(key)
  })

  /** 保存设置 */
  ipcMain.handle('settings:set', (_event, params: { key: string; value: string }) => {
    storageService.setSetting(params.key, params.value)
    return { success: true }
  })
}
