import { ipcMain } from 'electron'
import { chatGateway, operationContext, createElectronContext } from '../frontend'

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

  // 注：message:add 已移除 —— 迁移到 AgentHarness 后消息只能由 harness 产生，
  // 外部前端不再能凭空插入一条消息进会话树。

  /** 清空会话消息 */
  ipcMain.handle('message:clear', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), async () => {
      await chatGateway.clearMessages(sessionId)
      return { success: true }
    })
  )

  /** 回退到指定消息之前（entry 树把 leaf 移到其父节点，使 Agent 失效） */
  ipcMain.handle('message:rollback', (_event, params: { sessionId: string; messageId: string }) =>
    operationContext.run(createElectronContext(params.sessionId), async () => {
      await chatGateway.rollbackMessage(params.sessionId, params.messageId)
      return { success: true }
    })
  )

  // 注：message:deleteFrom 已并入 message:rollback（append-only 树上二者语义重合）。
  // message:addErrorEvent / message:deleteErrorEvent 已移除 —— 错误不再是独立可增删的
  // 消息行，而是 stopReason='error' 的 assistant entry，由投影渲染成 error_event。
}
