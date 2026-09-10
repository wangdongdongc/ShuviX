import { ipcMain, shell } from 'electron'
import { escapesBundle, normalizeBundlePath } from '@shuvix/agent-runtime'
import { ensureKnowledgeRoot, fromBundlePath, listKnowledgeEntries } from '../services/knowledge'
import { openKnowledgeNote } from '../services/knowledgeNotes'

/**
 * 知识库 v2（OKF bundle）IPC —— 侧栏「知识库」分组：条目清单 + 打开 / 复用笔记本会话
 * （一文件至多一会话）+ 目录 / 文件在 OS 文件管理器里显示。管理动作（核实 / 过时）属
 * 管理页，尚未建。写入经宿主变更管线后广播 AppEvent `knowledge.changed`，分组据此重扫。
 */
export function registerKnowledgeHandlers(): void {
  ipcMain.handle('knowledge:list', () => listKnowledgeEntries())
  ipcMain.handle('knowledge:openNote', (_event, params: { path: string; title?: string }) =>
    openKnowledgeNote(params.path, params.title)
  )
  ipcMain.handle('knowledge:openFolder', async () => {
    await shell.openPath(await ensureKnowledgeRoot())
    return { success: true }
  })
  /** 在文件夹中显示条目文件（bundle 相对路径；越出 bundle 的路径忽略） */
  ipcMain.handle('knowledge:revealFile', (_event, params: { path: string }) => {
    const rel = normalizeBundlePath(params.path)
    if (!rel || escapesBundle(rel)) return { success: false }
    shell.showItemInFolder(fromBundlePath(rel))
    return { success: true }
  })
}
