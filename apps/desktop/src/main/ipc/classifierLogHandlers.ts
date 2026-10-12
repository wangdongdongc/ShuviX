import { ipcMain } from 'electron'
import { classifierLogService } from '../services/classifierLogService'
import type { ClassifierLogListParams } from '../types'

/**
 * 分类器调用日志 IPC —— 列表、详情、出现过的场景、清空（设置「监控 → 分类器」）
 */
export function registerClassifierLogHandlers(): void {
  ipcMain.handle('classifierLog:list', (_event, params?: ClassifierLogListParams) =>
    classifierLogService.list(params)
  )
  ipcMain.handle('classifierLog:get', (_event, id: string) => classifierLogService.getById(id))
  ipcMain.handle('classifierLog:scenes', () => classifierLogService.scenes())
  ipcMain.handle('classifierLog:clear', () => {
    classifierLogService.clear()
    return { success: true }
  })
}
