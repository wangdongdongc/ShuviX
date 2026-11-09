import { defineHandler } from './registry'
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
  // 网络客户端（浏览器）没有窗口、也就没有焦点：照记「它看到了这个会话」（撤掉该会话名下的通知），
  // 但从不算「用户正看着」—— 桌面的通知照常弹
  // 浏览器 / 手机多报一个「页面在不在眼前」（visible）：只用于已读 —— 手机上看着的回复生来已读、切回前台算读过
  // （docs/inbox-read-state-design.md §3）；通知照旧不看它
  defineHandler(
    'notification:reportActiveSession',
    (ctx, sessionId: string | null, visible?: boolean) => {
      if (ctx.client.kind === 'window') {
        reportActiveSession(ctx.client.webContentsId, sessionId)
      } else if (ctx.client.kind === 'network') {
        reportActiveSession(null, sessionId, { clientId: ctx.client.id, visible: visible === true })
      } else {
        reportActiveSession(null, sessionId)
      }
      return { success: true }
    }
  )

  // 暂存的跳转目标是给「被通知点击重建的主窗口」的：浏览器来取会把它偷走，回 null
  defineHandler('notification:consumePendingOpenSession', (ctx) =>
    ctx.client.kind === 'window' ? consumePendingOpenSession() : null
  )
}
