import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron'
import { join, resolve } from 'path'
import {
  widgetService,
  widgetServer,
  exportWidget,
  resolveExportZipPath,
  WidgetExportError
} from '../services/widget'
import * as widgetWindowService from '../services/widgetWindowService'

/**
 * Widget IPC —— 列表、打开、归档、删除、重命名、server 状态、导出 Vite 工程 zip
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

  /** 启动单个 widget —— 注册到 server，但不打开浏览器 */
  ipcMain.handle('widget:startWidget', async (_event, id: string) => {
    try {
      const result = await widgetService.startWidget(id)
      return { success: true, url: result.url, buildSuccess: result.buildSuccess }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  /** 停止单个 widget —— 退出 app 语义：关闭独立窗口 + 从 server 注销 */
  ipcMain.handle('widget:stopWidget', (_event, id: string) => {
    widgetWindowService.close(id) // 关窗后 closed 回调也会反注册；下一行兜底"无窗口仅注册"的情况
    widgetService.stopWidget(id)
    return { success: true }
  })

  ipcMain.handle(
    'widget:rename',
    async (_event, params: { id: string; name: string; description?: string }) => {
      await widgetService.rename(params.id, params.name, params.description)
      return { success: true }
    }
  )

  ipcMain.handle('widget:setArchived', (_event, params: { id: string; archived: boolean }) => {
    widgetService.setArchived(params.id, params.archived)
    return { success: true }
  })

  ipcMain.handle('widget:delete', async (_event, id: string) => {
    await widgetService.delete(id)
    return { success: true }
  })

  // ========== 独立窗口（widget app window） ==========

  /** 在独立窗口打开 widget（已开则聚焦）。构建 / URL 获取由窗口内 shell 调 widget:open 完成 */
  ipcMain.handle('widgetWindow:open', (_event, id: string) => {
    try {
      widgetWindowService.open(id)
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('widgetWindow:close', (_event, id: string) => {
    widgetWindowService.close(id)
    return { success: true }
  })

  ipcMain.handle(
    'widgetWindow:setAlwaysOnTop',
    (_event, params: { id: string; value: boolean }) => {
      return { alwaysOnTop: widgetWindowService.setAlwaysOnTop(params.id, params.value) }
    }
  )

  ipcMain.handle('widgetWindow:getAlwaysOnTop', (_event, id: string) => {
    return { alwaysOnTop: widgetWindowService.getAlwaysOnTop(id) }
  })

  // ========== 服务器状态 ==========

  ipcMain.handle('widget:getServerStatus', () => widgetServer.getStatus())

  ipcMain.handle('widget:stopServer', () => {
    widgetService.stopServer()
    return { success: true }
  })

  // ========== 导出为独立 Vite 工程 zip ==========

  /** 弹出保存对话框选择 zip 落点（仅返回路径，不执行导出） */
  ipcMain.handle(
    'widget:pickExportTarget',
    async (
      event,
      params: { id: string }
    ): Promise<{ success: true; path: string } | { success: false; reason: string }> => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const options = {
        title: 'Export widget',
        defaultPath: join(app.getPath('downloads'), `${params.id}.zip`),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }]
      }
      const result = await (win
        ? dialog.showSaveDialog(win, options)
        : dialog.showSaveDialog(options))
      if (result.canceled || !result.filePath) {
        return { success: false, reason: 'canceled' }
      }
      return { success: true, path: result.filePath }
    }
  )

  /**
   * 在系统文件管理器中定位导出的 zip。
   * 不能复用 app:open-folder —— 那是 shell.openPath，对归档文件等于直接解压/打开。
   */
  ipcMain.handle('widget:revealExport', (_event, zipPath: string): { success: true } => {
    shell.showItemInFolder(zipPath)
    return { success: true }
  })

  /** 执行导出 —— 覆盖确认已由保存对话框完成 */
  ipcMain.handle(
    'widget:exportAsVite',
    async (
      _event,
      params: { id: string; targetPath: string }
    ): Promise<
      | { success: true; zipPath: string; entryCount: number }
      | { success: false; code: string; error: string }
    > => {
      try {
        // 只有"最终写入的文件 == 保存对话框询问过的那个文件"时才允许覆盖。
        // 用户在对话框里输了个不带 .zip 的名字时，真正写入的是 <那个名字>/<id>.zip，
        // 对话框从没问过它 —— 这种情况退回不覆盖，让 TARGET_EXISTS 正常报出来。
        const confirmedPath = resolve(params.targetPath)
        const overwrite = resolveExportZipPath(params.id, confirmedPath) === confirmedPath
        const result = await exportWidget({ ...params, overwrite })
        return { success: true, zipPath: result.zipPath, entryCount: result.entryCount }
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
