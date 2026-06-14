import { ipcMain } from 'electron'
import { httpLogService } from '../services/httpLogService'
import type { HttpLogListParams } from '../types'

/**
 * HTTP 日志 IPC 处理器
 * 提供日志列表、详情、清空能力
 */
export function registerHttpLogHandlers(): void {
  /** 获取日志列表（支持 sessionId 筛选，默认最近 200 条） */
  ipcMain.handle('httpLog:list', (_event, params?: HttpLogListParams) => {
    return httpLogService.list(params)
  })

  /** 获取日志详情（含完整请求体） */
  ipcMain.handle('httpLog:get', (_event, id: string) => {
    return httpLogService.getById(id)
  })

  /** 清空日志 */
  ipcMain.handle('httpLog:clear', () => {
    httpLogService.clear()
    return { success: true }
  })
}
