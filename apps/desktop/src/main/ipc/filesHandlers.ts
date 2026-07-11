import { ipcMain } from 'electron'
import {
  scanSessionFiles,
  watchSessionFile,
  unwatchSessionFile
} from '../services/filesWatcherService'
import { previewSessionFile, writeSessionFile } from '../services/filePreviewService'

export function registerFilesHandlers(): void {
  ipcMain.handle('files:scan', (_event, params: { sessionId: string }) =>
    scanSessionFiles(params.sessionId)
  )
  // 监听 / 取消监听单个已打开文件的内容变更（笔记本 / 预览自动刷新）
  ipcMain.handle('files:watch', (_event, params: { sessionId: string; path: string }) => {
    watchSessionFile(params.sessionId, params.path)
  })
  ipcMain.handle('files:unwatch', (_event, params: { sessionId: string; path: string }) => {
    unwatchSessionFile(params.sessionId, params.path)
  })
  ipcMain.handle('files:read', (_event, params: { sessionId: string; path: string }) =>
    previewSessionFile(params.sessionId, params.path)
  )
  ipcMain.handle(
    'files:write',
    (_event, params: { sessionId: string; path: string; content: string }) =>
      writeSessionFile(params.sessionId, params.path, params.content)
  )
}
