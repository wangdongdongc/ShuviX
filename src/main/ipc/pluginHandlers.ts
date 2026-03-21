import { ipcMain } from 'electron'
import { pluginRegistry } from '../services/pluginRegistry'

export function registerPluginHandlers(): void {
  ipcMain.on('preview:start', (_event, params: { sessionId: string; workingDir: string }) => {
    pluginRegistry.dispatchEvent({ type: 'preview:start', ...params })
  })

  ipcMain.on('preview:stop', (_event, params: { sessionId: string }) => {
    pluginRegistry.dispatchEvent({ type: 'preview:stop', ...params })
  })

  ipcMain.handle('plugin:purposes', () => {
    return pluginRegistry.getAllPurposes()
  })
}
