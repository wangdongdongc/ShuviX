import { ipcMain } from 'electron'
import { scanSessionFiles } from '../services/filesWatcherService'
import { previewSessionFile } from '../services/filePreviewService'

export function registerFilesHandlers(): void {
  ipcMain.handle('files:scan', (_event, params: { sessionId: string }) =>
    scanSessionFiles(params.sessionId)
  )
  ipcMain.handle('files:read', (_event, params: { sessionId: string; path: string }) =>
    previewSessionFile(params.sessionId, params.path)
  )
}
