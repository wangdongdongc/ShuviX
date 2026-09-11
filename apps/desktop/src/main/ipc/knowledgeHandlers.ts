import { ipcMain, shell } from 'electron'
import { normalizeBundlePath } from '@shuvix/agent-runtime'
import {
  bundleFilePath,
  getShuvixKnowledgeRoot,
  listKnowledgeEntries,
  locateBundle
} from '../services/knowledge'
import { openKnowledgeNote } from '../services/knowledgeNotes'

/**
 * 知识库 v2 IPC —— 侧栏「知识库」分组：条目清单 + 打开 / 复用笔记本会话（一文件至多一会话）
 * + 目录 / 文件在 OS 文件管理器里显示。路径一律 shuvix 根相对（`projects/<slug>/x.md`）。
 * 管理动作（核实 / 过时）属管理页，尚未建。写入经宿主变更管线后广播 AppEvent
 * `knowledge.changed`，分组据此重扫。
 */
export function registerKnowledgeHandlers(): void {
  ipcMain.handle('knowledge:list', () => listKnowledgeEntries())
  ipcMain.handle('knowledge:openNote', (_event, params: { path: string; title?: string }) =>
    openKnowledgeNote(params.path, params.title)
  )
  ipcMain.handle('knowledge:openFolder', async () => {
    await shell.openPath(getShuvixKnowledgeRoot())
    return { success: true }
  })
  /** 在文件夹中显示条目文件；落不进任何 bundle 的路径忽略 */
  ipcMain.handle('knowledge:revealFile', (_event, params: { path: string }) => {
    const rel = normalizeBundlePath(params.path)
    const abs = rel ? bundleFilePath('', rel) : ''
    if (!abs || !locateBundle(abs)) return { success: false }
    shell.showItemInFolder(abs)
    return { success: true }
  })
}
