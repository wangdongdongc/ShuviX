import { ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { storageService, type Session } from '../services/storage'

/**
 * 会话管理 IPC 处理器
 * 负责会话的增删改查
 */
export function registerSessionHandlers(): void {
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
}
