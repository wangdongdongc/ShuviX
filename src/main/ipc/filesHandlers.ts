import { ipcMain } from 'electron'
import { scanSessionFiles } from '../services/filesWatcherService'

export function registerFilesHandlers(): void {
  ipcMain.handle('files:scan', (_event, params: { sessionId: string }) =>
    scanSessionFiles(params.sessionId)
  )
}
