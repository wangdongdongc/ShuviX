import { mkdirSync } from 'fs'
import { ipcMain, shell } from 'electron'
import {
  createKnowledgeBase,
  createKnowledgeEntry,
  createKnowledgeFolder,
  entryFilePath,
  getUserKnowledgeRoot,
  listKnowledgeEntries,
  locateBundle
} from '../services/knowledge'
import { openKnowledgeNote } from '../services/knowledgeNotes'

/**
 * 知识库 v2 IPC —— 侧栏「知识库」分组：条目清单 + 打开 / 复用笔记本会话（一文件至多一会话）
 * + 目录 / 文件在 OS 文件管理器里显示 + 手动新建（知识库 / 文件夹 / 条目）。路径一律是清单里的 id
 * （`projects/<id>/x.md` / `knowledge/<库名>/x.md`）。写入经宿主变更管线后广播 AppEvent
 * `knowledge.changed`，分组据此重扫。改名与删除仍然交给文件系统（「打开知识库目录」那条路）。
 */
export function registerKnowledgeHandlers(): void {
  ipcMain.handle('knowledge:list', () => listKnowledgeEntries())
  ipcMain.handle('knowledge:openNote', (_event, params: { path: string; title?: string }) =>
    openKnowledgeNote(params.path, params.title)
  )
  /**
   * 打开**用户知识库根**：拷库、改名、删库都在这里做 —— 所以目录得先在。
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
  /** 新建：名字不合法 / 重名 / 目录已不在都回 { success:false, error }，侧栏把原因显示在输入行下面 */
  ipcMain.handle('knowledge:createBase', (_event, params: { name: string }) =>
    createKnowledgeBase(params.name)
  )
  ipcMain.handle('knowledge:createFolder', (_event, params: { dir: string; name: string }) =>
    createKnowledgeFolder(params.dir, params.name)
  )
  ipcMain.handle('knowledge:createEntry', (_event, params: { dir: string; title: string }) =>
    createKnowledgeEntry(params.dir, params.title)
  )
}
