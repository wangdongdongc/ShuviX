import { ipcMain } from 'electron'
import { chatGateway, operationContext, createElectronContext } from '../frontend'
import type { MessageAddParams } from '../types'

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
  ipcMain.handle(
    'message:deleteFrom',
    (_event, params: { sessionId: string; messageId: string }) =>
      operationContext.run(createElectronContext(params.sessionId), () => {
        chatGateway.deleteFromMessage(params.sessionId, params.messageId)
        return { success: true }
      })
  )
}
