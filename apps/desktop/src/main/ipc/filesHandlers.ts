import { ipcMain } from 'electron'
import { scanSessionFiles } from '../services/filesWatcherService'
import { previewSessionFile, writeSessionFile } from '../services/filePreviewService'

export function registerFilesHandlers(): void {
  ipcMain.handle('files:scan', (_event, params: { sessionId: string }) =>
    scanSessionFiles(params.sessionId)
  )
  ipcMain.handle('files:read', (_event, params: { sessionId: string; path: string }) =>
    previewSessionFile(params.sessionId, params.path)
  )
  ipcMain.handle(
    'files:write',
    (_event, params: { sessionId: string; path: string; content: string }) =>
      writeSessionFile(params.sessionId, params.path, params.content)
  )
}
