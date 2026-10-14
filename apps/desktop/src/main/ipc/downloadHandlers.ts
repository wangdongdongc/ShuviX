import { defineHandler } from './registry'
import { downloadManager } from '../utils/downloadManager'

/**
 * 注册下载管理 IPC 处理器
 */
export function registerDownloadHandlers(): void {
  defineHandler('download:cancel', (_ctx, taskId: string) => {
    downloadManager.cancel(taskId)
    return { success: true }
  })
}
