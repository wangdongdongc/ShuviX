import { ipcMain } from 'electron'
import { storageService } from '../services/storage'

/**
 * 设置管理 IPC 处理器
 * 负责应用设置的读写（API Key、Base URL、Provider 等）
 */
export function registerSettingsHandlers(): void {
  /** 获取所有设置 */
  ipcMain.handle('settings:getAll', () => {
    return storageService.getAllSettings()
  })

  /** 获取单个设置 */
  ipcMain.handle('settings:get', (_event, key: string) => {
    return storageService.getSetting(key)
  })

  /** 保存设置 */
  ipcMain.handle('settings:set', (_event, params: { key: string; value: string }) => {
    storageService.setSetting(params.key, params.value)
    return { success: true }
  })
}
