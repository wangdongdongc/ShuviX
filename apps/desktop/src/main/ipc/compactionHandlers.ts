import { ipcMain } from 'electron'
import { compactionService } from '../services/compactionService'

export function registerCompactionHandlers(): void {
  ipcMain.handle('compact:start', (_event, sessionId: string) =>
    compactionService.compact(sessionId)
  )
}
