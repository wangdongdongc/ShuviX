import { defineHandler } from './registry'
import { appLogPath, readAppLogTail } from '../services/appLogService'
import type { AppLogCursor } from '../../shared/appLog'

/**
 * 应用日志 IPC 处理器（main.log）
 * 路径（关于页）与尾部（监视器 → 应用日志；带游标 = 只要新增的行）
 */
export function registerAppLogHandlers(): void {
  defineHandler('appLog:info', () => ({ path: appLogPath() }))

  defineHandler('appLog:tail', (_ctx, cursor?: AppLogCursor | null) =>
    readAppLogTail(appLogPath(), cursor)
  )
}
