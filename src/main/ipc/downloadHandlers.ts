import { ipcMain } from 'electron'
import { downloadManager } from '../services/downloadManager'

/**
 * 注册下载管理 IPC 处理器
 */
export function registerDownloadHandlers(): void {
  ipcMain.handle('download:cancel', (_event, taskId: string) => {
    downloadManager.cancel(taskId)
    return { success: true }
  })
}
