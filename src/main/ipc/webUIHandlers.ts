import { ipcMain } from 'electron'
import { webUIService } from '../services/webUIService'
// 副作用导入：触发 WebUIServer 实例化 + 注册到 webUIService
import '../frontend/web/WebUIServer'

/**
 * WebUI 分享管理 IPC 处理器
 */
export function registerWebUIHandlers(): void {
  /** 切换指定 session 的分享状态 */
  ipcMain.handle('webui:setShared', (_event, params: { sessionId: string; shared: boolean }) => {
    webUIService.setShared(params.sessionId, params.shared)
    return { success: true }
  })

  /** 查询单个 session 是否已分享 */
  ipcMain.handle('webui:isShared', (_event, sessionId: string) => {
    return webUIService.isShared(sessionId)
  })

  /** 获取所有已分享的 session ID 列表 */
  ipcMain.handle('webui:listShared', () => {
    return webUIService.listShared()
  })

  /** 获取 WebUI 服务器状态 */
  ipcMain.handle('webui:serverStatus', () => {
    return webUIService.getServerStatus()
  })
}
