import { ipcMain } from 'electron'
import { widgetService } from '../services/widgetService'
import { widgetServer } from '../services/widgetServer'

/**
 * Widget IPC —— 列表、打开、归档、删除、重命名、server 状态
 * 广播事件 `widget:changed` 由 widgetService 内部在状态变更后发出
 */
export function registerWidgetHandlers(): void {
  ipcMain.handle('widget:list', () => widgetService.listActive())
  ipcMain.handle('widget:listArchived', () => widgetService.listArchived())

  ipcMain.handle('widget:open', async (_event, id: string) => {
    try {
      const result = await widgetService.open(id)
      return { success: true, url: result.url, widget: result.widget }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    'widget:rename',
    (_event, params: { id: string; name: string; description?: string }) => {
      widgetService.rename(params.id, params.name, params.description)
      return { success: true }
    }
  )

  ipcMain.handle('widget:setArchived', (_event, params: { id: string; archived: boolean }) => {
    widgetService.setArchived(params.id, params.archived)
    return { success: true }
  })

  ipcMain.handle('widget:delete', (_event, id: string) => {
    widgetService.delete(id)
    return { success: true }
  })

  // ========== 服务器状态 ==========

  ipcMain.handle('widget:getServerStatus', () => widgetServer.getStatus())

  ipcMain.handle('widget:stopServer', () => {
    widgetService.stopServer()
    return { success: true }
  })
}
