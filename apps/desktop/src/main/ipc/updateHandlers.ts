import { defineHandler } from './registry'
import { updateService } from '../services/updateService'

/**
 * 自动更新 IPC 处理器
 * 更新状态通过 'update:event' push 事件推送到渲染进程
 */
export function registerUpdateHandlers(): void {
  defineHandler('update:check', async () => {
    await updateService.checkForUpdates()
    return { success: true }
  })

  defineHandler('update:download', async () => {
    await updateService.downloadUpdate()
    return { success: true }
  })

  defineHandler('update:install', () => {
    updateService.quitAndInstall()
    return { success: true }
  })

  defineHandler('update:getLastEvent', () => {
    return updateService.getLastEvent()
  })
}
