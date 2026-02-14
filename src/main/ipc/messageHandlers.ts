import { ipcMain } from 'electron'
import { messageService } from '../services/messageService'
import type { MessageAddParams } from '../types'

/**
 * 消息管理 IPC 处理器
 * 负责参数解析，委托给 MessageService
 */
export function registerMessageHandlers(): void {
  /** 获取会话消息 */
  ipcMain.handle('message:list', (_event, sessionId: string) => {
    return messageService.listBySession(sessionId)
  })

  /** 保存消息 */
  ipcMain.handle('message:add', (_event, params: MessageAddParams) => {
    return messageService.add(params)
  })

  /** 清空会话消息 */
  ipcMain.handle('message:clear', (_event, sessionId: string) => {
    messageService.clear(sessionId)
    return { success: true }
  })
}
