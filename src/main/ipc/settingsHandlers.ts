import { ipcMain, BrowserWindow } from 'electron'
import { settingsService } from '../services/settingsService'

/**
 * 设置管理 IPC 处理器
 * 负责参数解析，委托给 SettingsService
 */
export function registerSettingsHandlers(): void {
  /** 获取所有设置 */
  ipcMain.handle('settings:getAll', () => {
    return settingsService.getAll()
  })

  /** 获取单个设置 */
  ipcMain.handle('settings:get', (_event, key: string) => {
    return settingsService.get(key)
  })

  /** 保存设置，并广播通知所有窗口刷新 */
  ipcMain.handle('settings:set', (_event, params: { key: string; value: string }) => {
    settingsService.set(params.key, params.value)
    // 通知所有窗口设置已变更（主窗口监听后会刷新主题/字体等）
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('app:settings-changed')
    })
    return { success: true }
  })
}
