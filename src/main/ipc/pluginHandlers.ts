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

  ipcMain.handle('plugin:toolPresentations', () => {
    return pluginRegistry.getAllToolPresentations()
  })

  ipcMain.handle('plugin:getRuntimeStatuses', (_event, sessionId: string) => {
    return pluginRegistry.getRuntimeStatuses(sessionId)
  })

  ipcMain.handle(
    'plugin:destroyRuntime',
    (_event, params: { sessionId: string; runtimeId: string }) => {
      pluginRegistry.dispatchEvent({
        type: 'runtime:destroy',
        sessionId: params.sessionId,
        runtimeId: params.runtimeId
      })
      return { success: true }
    }
  )
}
