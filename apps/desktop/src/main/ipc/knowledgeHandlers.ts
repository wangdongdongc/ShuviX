import { mkdirSync } from 'fs'
import { ipcMain, shell } from 'electron'
import {
  entryFilePath,
  getUserKnowledgeRoot,
  listKnowledgeEntries,
  locateBundle
} from '../services/knowledge'
import { openKnowledgeNote } from '../services/knowledgeNotes'

/**
 * 知识库 v2 IPC —— 侧栏「知识库」分组：条目清单 + 打开 / 复用笔记本会话（一文件至多一会话）
 * + 目录 / 文件在 OS 文件管理器里显示。路径一律是条目 id（`projects/<id>/x.md` /
 * `knowledge/<库名>/x.md`）。写入经宿主变更管线后广播 AppEvent `knowledge.changed`，分组据此重扫。
 */
export function registerKnowledgeHandlers(): void {
  ipcMain.handle('knowledge:list', () => listKnowledgeEntries())
  ipcMain.handle('knowledge:openNote', (_event, params: { path: string; title?: string }) =>
    openKnowledgeNote(params.path, params.title)
  )
  /**
   * 打开**用户知识库根**：建库、改名、删库都交给文件系统，用户往这里拷文件夹 —— 所以目录得先在。
   * 项目库是宿主维护的，条目行的「在文件夹中显示」照样够得着。
   */
  ipcMain.handle('knowledge:openFolder', async () => {
    const root = getUserKnowledgeRoot()
    mkdirSync(root, { recursive: true })
    await shell.openPath(root)
    return { success: true }
  })
  /** 在文件夹中显示条目文件；落不进任何 bundle 的路径忽略 */
  ipcMain.handle('knowledge:revealFile', (_event, params: { path: string }) => {
    const abs = params.path ? entryFilePath(params.path) : ''
    if (!abs || !locateBundle(abs)) return { success: false }
    shell.showItemInFolder(abs)
    return { success: true }
  })
}
