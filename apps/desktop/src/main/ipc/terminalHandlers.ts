import { defineHandler, defineListener } from './registry'
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
  defineHandler('terminal:create', (ctx, params: { cwd?: string; cols?: number; rows?: number }) =>
    createTerminal({ ...params, client: ctx.client })
  )

  /** 向终端写入数据 */
  defineListener('terminal:write', (_ctx, params: { terminalId: string; data: string }) => {
    writeTerminal(params.terminalId, params.data)
  })

  /** 调整终端尺寸 */
  defineListener(
    'terminal:resize',
    (_ctx, params: { terminalId: string; cols: number; rows: number }) => {
      resizeTerminal(params.terminalId, params.cols, params.rows)
    }
  )

  /** 销毁终端实例 */
  defineHandler('terminal:destroy', (_ctx, terminalId: string) => {
    destroyTerminal(terminalId)
    return { success: true }
  })
}
