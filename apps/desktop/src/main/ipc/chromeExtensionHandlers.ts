import { ipcMain } from 'electron'
import { chromeExtensionStatus, installChromeNativeHost } from '../services/chromeExtensionService'

/**
 * Chrome 扩展 IPC —— 设置页（MCP 设置里内置 `chrome` 行的展开区）看连接状态、修复本地组件。
 */
export function registerChromeExtensionHandlers(): void {
  ipcMain.handle('chromeExtension:status', () => chromeExtensionStatus())
  ipcMain.handle('chromeExtension:repair', async () => {
    await installChromeNativeHost()
    return chromeExtensionStatus()
  })
}
