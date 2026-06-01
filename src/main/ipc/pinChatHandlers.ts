import { ipcMain } from 'electron'
import * as pinnedChatService from '../services/pinnedChatService'

/**
 * 悬浮聊天（Floating Pin Chat）IPC 处理器
 *
 * 多窗模型：每个 sessionId 对应一个独立的悬浮窗口；多个会话可同时悬浮、并行运行 Agent。
 * pin / unpin / focus 都按 sessionId 操作；getState 返回当前所有正在悬浮的 sessionId。
 */
export function registerPinChatHandlers(): void {
  ipcMain.handle('pinChat:pin', async (_event, sessionId: string) => {
    await pinnedChatService.pin(sessionId)
    return { success: true }
  })

  ipcMain.handle('pinChat:unpin', async (_event, sessionId: string) => {
    await pinnedChatService.unpin(sessionId, 'user')
    return { success: true }
  })

  ipcMain.handle('pinChat:focus', (_event, sessionId: string) => {
    pinnedChatService.focusFloating(sessionId)
    return { success: true }
  })

  ipcMain.handle('pinChat:getState', () => {
    return pinnedChatService.getState()
  })

  /** 切换悬浮窗"始终置顶"特性,关闭后窗口降为普通窗口 */
  ipcMain.handle(
    'pinChat:setAlwaysOnTop',
    (_event, params: { sessionId: string; value: boolean }) => {
      return { alwaysOnTop: pinnedChatService.setAlwaysOnTop(params.sessionId, params.value) }
    }
  )

  ipcMain.handle('pinChat:getAlwaysOnTop', (_event, sessionId: string) => {
    return { alwaysOnTop: pinnedChatService.getAlwaysOnTop(sessionId) }
  })
}
