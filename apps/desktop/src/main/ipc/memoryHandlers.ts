import { ipcMain } from 'electron'
import { listProjectMemories, openMemoryNote } from '../services/memoryService'

/** 侧栏「项目记忆」子文件夹：条目清单 + 打开/复用绑定该记忆的笔记本会话 */
export function registerMemoryHandlers(): void {
  ipcMain.handle('memory:list', (_event, params: { projectId: string }) =>
    listProjectMemories(params.projectId)
  )
  ipcMain.handle('memory:openNote', (_event, params: { projectId: string; slug: string }) =>
    openMemoryNote(params.projectId, params.slug)
  )
}
