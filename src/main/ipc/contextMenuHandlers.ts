import { ipcMain, Menu, BrowserWindow } from 'electron'
import type { ContextMenuRequest, ContextMenuResult } from '../../shared/types/contextMenu'

export function registerContextMenuHandlers(): void {
  ipcMain.handle(
    'contextMenu:popup',
    (event, request: ContextMenuRequest): Promise<ContextMenuResult> => {
      return new Promise((resolve) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) {
          resolve({ actionId: null })
          return
        }

        const template = request.items.map((item) => {
          if (item.type === 'separator') {
            return { type: 'separator' as const }
          }
          return {
            label: item.label,
            enabled: item.enabled ?? true,
            click: () => resolve({ actionId: item.id })
          }
        })

        const menu = Menu.buildFromTemplate(template)
        menu.popup({
          window: win,
          callback: () => {
            // menu 关闭回调：用 setImmediate 确保 click handler 的 resolve 优先执行
            setImmediate(() => resolve({ actionId: null }))
          }
        })
      })
    }
  )
}
