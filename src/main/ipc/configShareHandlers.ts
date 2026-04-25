import { ipcMain, BrowserWindow } from 'electron'
import { configShareService } from '../services/configShareService'
import type {
  ConfigSharePayload,
  ExportOptions,
  ImportSelection
} from '../../shared/types/configShare'

function notifyAll(): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('app:settings-changed')
  })
}

/**
 * 配置导出/导入 IPC 处理器
 */
export function registerConfigShareHandlers(): void {
  ipcMain.handle('config:buildExportSnapshot', () => {
    return configShareService.buildExportSnapshot()
  })

  ipcMain.handle('config:buildExportPayload', (_event, options: ExportOptions) => {
    return configShareService.buildExportPayload(options)
  })

  ipcMain.handle('config:parseImportPayload', (_event, encoded: string) => {
    return configShareService.parseImportPayload(encoded)
  })

  ipcMain.handle('config:planImport', (_event, payload: ConfigSharePayload) => {
    return configShareService.planImport(payload)
  })

  ipcMain.handle(
    'config:applyImport',
    async (_event, params: { payload: ConfigSharePayload; selection: ImportSelection }) => {
      const result = await configShareService.applyImportPayload(params.payload, params.selection)
      notifyAll()
      return result
    }
  )
}
