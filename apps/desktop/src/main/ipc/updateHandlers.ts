import { ipcMain } from 'electron'
import { updateService } from '../services/updateService'

/**
 * 自动更新 IPC 处理器
 * 更新状态通过 'update:event' push 事件推送到渲染进程
 */
export function registerUpdateHandlers(): void {
  ipcMain.handle('update:check', async () => {
    await updateService.checkForUpdates()
    return { success: true }
  })

  ipcMain.handle('update:download', async () => {
    await updateService.downloadUpdate()
    return { success: true }
  })

  ipcMain.handle('update:install', () => {
    updateService.quitAndInstall()
    return { success: true }
  })

  ipcMain.handle('update:getLastEvent', () => {
    return updateService.getLastEvent()
  })
}
