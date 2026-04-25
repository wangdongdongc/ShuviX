import { ipcMain, dialog, BrowserWindow } from 'electron'
import { widgetService, widgetServer, exportWidget, WidgetExportError } from '../services/widget'

/**
 * Widget IPC —— 列表、打开、归档、删除、重命名、server 状态、导出 Vite 项目
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

  // ========== 导出为独立 Vite 项目 ==========

  /** 弹出文件夹选择器（仅返回路径，不执行导出） */
  ipcMain.handle(
    'widget:pickExportDir',
    async (
      event
    ): Promise<{ success: true; path: string } | { success: false; reason: string }> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const result = await (win
        ? dialog.showOpenDialog(win, {
            properties: ['openDirectory', 'createDirectory'],
            title: 'Select export target folder'
          })
        : dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
            title: 'Select export target folder'
          }))
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, reason: 'canceled' }
      }
      return { success: true, path: result.filePaths[0] }
    }
  )

  /** 执行导出 */
  ipcMain.handle(
    'widget:exportAsVite',
    async (
      _event,
      params: { id: string; targetPath: string }
    ): Promise<
      | { success: true; filesWritten: string[]; targetPath: string }
      | { success: false; code: string; error: string }
    > => {
      try {
        const result = await exportWidget(params)
        return { success: true, filesWritten: result.filesWritten, targetPath: result.targetPath }
      } catch (err) {
        if (err instanceof WidgetExportError) {
          return { success: false, code: err.code, error: err.message }
        }
        return {
          success: false,
          code: 'UNKNOWN',
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
}
