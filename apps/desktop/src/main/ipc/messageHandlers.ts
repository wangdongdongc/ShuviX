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

  /**
   * 回退到指定消息之前（P3-10b，PIN-02）：真的回退了 → `{success:true}`；没有可回退的目标（旧格式会话、
   * id 不是条目 id、目标不在当前对话里）→ `{success:false}`，界面据此不回填草稿、不重发。运行时抛错原样拒绝。
   */
  ipcMain.handle('message:rollback', (_event, params: { sessionId: string; messageId: string }) =>
    operationContext.run(createElectronContext(params.sessionId), async () => ({
      success: await chatGateway.rollbackMessage(params.sessionId, params.messageId)
    }))
  )

  // 注：message:deleteFrom 已并入 message:rollback（append-only 树上二者语义重合）。
  // message:addErrorEvent / message:deleteErrorEvent 已移除 —— 错误不再是独立可增删的
  // 消息行，而是 stopReason='error' 的 assistant entry，由投影渲染成 error_event。
}
