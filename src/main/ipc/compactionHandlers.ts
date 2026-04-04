import { ipcMain } from 'electron'
import { compactionService } from '../services/compaction/compactionService'

export function registerCompactionHandlers(): void {
  ipcMain.handle('compact:start', (_event, sessionId: string) =>
    compactionService.compact(sessionId)
  )
}
