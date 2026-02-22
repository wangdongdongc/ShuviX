/**
 * 路径相关工具函数
 */

import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { app } from 'electron'

/** 获取临时会话的工作目录（统一入口，所有地方通过此函数获取） */
export function getTempWorkspace(sessionId: string): string {
  const dir = join(app.getPath('userData'), 'temp_workspace', sessionId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}
