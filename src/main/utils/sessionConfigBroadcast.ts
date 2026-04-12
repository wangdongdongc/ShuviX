import { BrowserWindow } from 'electron'

/**
 * 广播"会话配置已变更"事件,通知所有渲染进程窗口刷新派生数据。
 *
 * 触发场景:
 * - 工具允许列表(allowList)变化(命令审批"允许并记住" / 设置面板手动删除)
 * - LAN 分享开启/关闭
 * - Telegram 绑定切换
 *
 * 渲染端在 useAppInit 中监听 `session:configChanged`,根据 payload.sessionId
 * 重新拉取该会话的设置并写回 chatStore。
 */
export function broadcastSessionConfigChanged(sessionId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('session:configChanged', { sessionId })
    }
  }
}
