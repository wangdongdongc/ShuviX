import { ipcMain } from 'electron'
import { messageService } from '../services/messageService'
import { agentService } from '../services/agent'
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

  /** 回退到指定消息（保留该消息，删除之后的所有消息，使 Agent 失效） */
  ipcMain.handle('message:rollback', (_event, params: { sessionId: string; messageId: string }) => {
    messageService.rollbackToMessage(params.sessionId, params.messageId)
    agentService.invalidateAgent(params.sessionId)
    return { success: true }
  })

  /** 从指定消息开始删除（含该消息，使 Agent 失效） */
  ipcMain.handle('message:deleteFrom', (_event, params: { sessionId: string; messageId: string }) => {
    messageService.deleteFromMessage(params.sessionId, params.messageId)
    agentService.invalidateAgent(params.sessionId)
    return { success: true }
  })
}
