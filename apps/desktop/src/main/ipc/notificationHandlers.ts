import { ipcMain } from 'electron'
import { consumePendingOpenSession, reportActiveSession } from '../services/notificationService'

/**
 * 通知 IPC —— 两个方向各一条。
 *
 * 上行 `reportActiveSession`：主进程不知道渲染层的 activeSessionId（那是 chatStore 的状态），
 * 而「用户正看着这个会话就别弹」的判定又只能在主进程做（macOS 关窗后没有渲染进程，
 * 恰恰是最该通知的时候）。所以由每个聊天窗口自报当前会话，主进程叠加窗口焦点判定。
 *
 * 下行 `consumePendingOpenSession`：通知点击时主窗可能已销毁，跳转目标先存主进程，
 * 窗口重建、渲染就绪后由渲染层来取。窗口还在的情形直接走 `notification:open-session` 推送。
 */
export function registerNotificationHandlers(): void {
  ipcMain.handle('notification:reportActiveSession', (event, sessionId: string | null) => {
    reportActiveSession(event.sender.id, sessionId)
    return { success: true }
  })

  ipcMain.handle('notification:consumePendingOpenSession', () => consumePendingOpenSession())
}
