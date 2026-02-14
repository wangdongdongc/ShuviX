import { ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { storageService, type Message } from '../services/storage'

/**
 * 消息管理 IPC 处理器
 * 负责消息的查询、添加、清空
 */
export function registerMessageHandlers(): void {
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
}
