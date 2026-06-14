import { ipcMain, Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type {
  ContextMenuItem,
  ContextMenuRequest,
  ContextMenuResult
} from '@shuvix/chat-protocol/types/contextMenu'

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

        // 递归构建模板：separator / role（原生编辑动作）/ 子菜单 / 自定义点击项
        const toTemplate = (items: ContextMenuItem[]): MenuItemConstructorOptions[] =>
          items.map((item) => {
            if (item.type === 'separator') return { type: 'separator' }
            if (item.role) {
              return {
                role: item.role,
                ...(item.label ? { label: item.label } : {}),
                enabled: item.enabled ?? true
              }
            }
            const node: MenuItemConstructorOptions = {
              label: item.label ?? '',
              enabled: item.enabled ?? true
            }
            if (item.submenu) node.submenu = toTemplate(item.submenu)
            else if (item.id) node.click = () => resolve({ actionId: item.id ?? null })
            return node
          })

        const menu = Menu.buildFromTemplate(toTemplate(request.items))
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
