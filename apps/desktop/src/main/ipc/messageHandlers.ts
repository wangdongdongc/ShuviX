import { ipcMain } from 'electron'
import { chatGateway, operationContext, createElectronContext } from '../frontend'
import { messageService } from '../services/messageService'
import type { MessageAddParams, ErrorEventAddParams } from '../types'

/**
 * 消息管理 IPC 处理器
 * 负责参数解析，委托给 ChatGateway
 */
export function registerMessageHandlers(): void {
  /** 获取会话消息 */
  ipcMain.handle('message:list', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () =>
      chatGateway.listMessages(sessionId)
    )
  )

  /** 保存消息 */
  ipcMain.handle('message:add', (_event, params: MessageAddParams) =>
    operationContext.run(createElectronContext(params.sessionId), () =>
      chatGateway.addMessage(params)
    )
  )

  /** 清空会话消息 */
  ipcMain.handle('message:clear', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () => {
      chatGateway.clearMessages(sessionId)
      return { success: true }
    })
  )

  /** 回退到指定消息（保留该消息，删除之后的所有消息，使 Agent 失效） */
  ipcMain.handle('message:rollback', (_event, params: { sessionId: string; messageId: string }) =>
    operationContext.run(createElectronContext(params.sessionId), () => {
      chatGateway.rollbackMessage(params.sessionId, params.messageId)
      return { success: true }
    })
  )

  /** 从指定消息开始删除（含该消息，使 Agent 失效） */
  ipcMain.handle('message:deleteFrom', (_event, params: { sessionId: string; messageId: string }) =>
    operationContext.run(createElectronContext(params.sessionId), () => {
      chatGateway.deleteFromMessage(params.sessionId, params.messageId)
      return { success: true }
    })
  )

  /** 新增 error_event 消息（类型化便捷入口） */
  ipcMain.handle('message:addErrorEvent', (_event, params: ErrorEventAddParams) =>
    operationContext.run(createElectronContext(params.sessionId), () =>
      messageService.addErrorEvent(params)
    )
  )

  /** 删除单条 error_event 消息（UI 便捷操作，不影响 agent 上下文） */
  ipcMain.handle(
    'message:deleteErrorEvent',
    (_event, params: { sessionId: string; messageId: string }) =>
      operationContext.run(createElectronContext(params.sessionId), () => ({
        success: messageService.deleteErrorEvent(params.sessionId, params.messageId)
      }))
  )

  /** 统计会话已归档消息数 */
  ipcMain.handle('message:countArchived', (_event, sessionId: string) =>
    messageService.countArchived(sessionId)
  )

  /** 分页加载已归档消息（含 steps） */
  ipcMain.handle(
    'message:listArchived',
    (_event, params: { sessionId: string; limit: number; offset: number }) =>
      messageService.listArchivedBySession(params.sessionId, params.limit, params.offset)
  )
}
