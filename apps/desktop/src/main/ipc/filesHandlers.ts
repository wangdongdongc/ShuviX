import { BrowserWindow, ipcMain } from 'electron'
import {
  scanSessionFiles,
  watchSessionFile,
  unwatchSessionFile
} from '../services/filesWatcherService'
import { previewSessionFile, writeSessionFile, saveBinaryAs } from '../services/filePreviewService'
import { reportChartValidation } from '../services/previewValidationBroker'

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
  // 二进制另存为（图表预览导出 PNG / SVG）：落点由用户在系统保存对话框里当场指定
  ipcMain.handle('files:saveAs', (event, params: { defaultPath: string; dataBase64: string }) =>
    saveBinaryAs(params, BrowserWindow.fromWebContents(event.sender) ?? undefined)
  )
  // 渲染端图表验证回执（preview 工具 → AppEvent 'preview.validateChart' 的应答通道）
  ipcMain.handle(
    'preview:reportRender',
    (_event, params: { validationId: string; ok: boolean; error?: string }) =>
      reportChartValidation(params)
  )
}
