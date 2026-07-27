import { ipcMain } from 'electron'
import { listWikiFiles, openWikiNote } from '../services/wikiService'

/** 侧栏 Wiki 视图:md 文件清单 + 打开/复用笔记本会话(一文件至多一会话) */
export function registerWikiHandlers(): void {
  ipcMain.handle('wiki:listFiles', () => listWikiFiles())
  ipcMain.handle('wiki:openNote', (_event, params: { path: string }) => openWikiNote(params.path))
}
