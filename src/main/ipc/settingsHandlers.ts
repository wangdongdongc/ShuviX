import { ipcMain } from 'electron'
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

  /** 保存设置 */
  ipcMain.handle('settings:set', (_event, params: { key: string; value: string }) => {
    settingsService.set(params.key, params.value)
    return { success: true }
  })
}
