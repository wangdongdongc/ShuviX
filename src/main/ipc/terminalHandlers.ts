import { ipcMain } from 'electron'
import {
  createTerminal,
  writeTerminal,
  resizeTerminal,
  destroyTerminal
} from '../services/terminalService'

/**
 * Terminal IPC 处理器
 */
export function registerTerminalHandlers(): void {
  /** 创建终端实例 */
  ipcMain.handle(
    'terminal:create',
    (event, params: { cwd?: string; cols?: number; rows?: number }) => {
      const windowId = event.sender.id
      return createTerminal({ ...params, windowId })
    }
  )

  /** 向终端写入数据 */
  ipcMain.on('terminal:write', (_event, params: { terminalId: string; data: string }) => {
    writeTerminal(params.terminalId, params.data)
  })

  /** 调整终端尺寸 */
  ipcMain.on(
    'terminal:resize',
    (_event, params: { terminalId: string; cols: number; rows: number }) => {
      resizeTerminal(params.terminalId, params.cols, params.rows)
    }
  )

  /** 销毁终端实例 */
  ipcMain.handle('terminal:destroy', (_event, terminalId: string) => {
    destroyTerminal(terminalId)
    return { success: true }
  })
}
