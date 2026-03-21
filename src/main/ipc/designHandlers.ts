/**
 * Design Preview IPC 处理器
 *
 * 通道：
 * - design:init      — 初始化设计项目（脚手架模板文件）
 * - design:startDev  — 启动 dev server + 文件监听
 * - design:stopDev   — 停止 dev server + 文件监听
 * - design:status    — 查询当前状态
 */

import { ipcMain } from 'electron'
import { designProjectManager } from '../services/designProjectManager'
import { bundlerService } from '../services/bundlerService'

export function registerDesignHandlers(): void {
  /** 初始化设计项目（创建目录 + 脚手架模板） */
  ipcMain.handle(
    'design:init',
    async (_event, params: { sessionId: string; workingDir: string }) => {
      const designDir = await designProjectManager.init(params.sessionId, params.workingDir)
      return { designDir }
    }
  )

  /** 启动 dev server + 文件监听 */
  ipcMain.handle(
    'design:startDev',
    async (_event, params: { sessionId: string; workingDir: string }) => {
      return designProjectManager.startDev(params.sessionId, params.workingDir)
    }
  )

  /** 停止 dev server + 文件监听 */
  ipcMain.handle('design:stopDev', (_event, params: { sessionId: string }) => {
    designProjectManager.stopDev(params.sessionId)
    return { success: true }
  })

  /** 查询状态 */
  ipcMain.handle('design:status', (_event, params: { sessionId: string }) => {
    const active = designProjectManager.isActive(params.sessionId)
    const serverInfo = active ? bundlerService.getDevServerInfo(params.sessionId) : null
    return {
      active,
      server: serverInfo
    }
  })
}
