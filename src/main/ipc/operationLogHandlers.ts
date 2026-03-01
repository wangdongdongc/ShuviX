import { ipcMain } from 'electron'
import { operationLogService } from '../services/operationLogService'
import type { OperationLogListParams } from '../types'

/**
 * 操作日志 IPC 处理器
 * 提供日志列表、详情、清空能力
 */
export function registerOperationLogHandlers(): void {
  /** 获取操作日志列表（支持筛选，默认最近 200 条） */
  ipcMain.handle('operationLog:list', (_event, params?: OperationLogListParams) => {
    return operationLogService.list(params)
  })

  /** 获取日志详情（含完整 detail） */
  ipcMain.handle('operationLog:get', (_event, id: string) => {
    return operationLogService.getById(id)
  })

  /** 清空日志 */
  ipcMain.handle('operationLog:clear', () => {
    operationLogService.clear()
    return { success: true }
  })
}
