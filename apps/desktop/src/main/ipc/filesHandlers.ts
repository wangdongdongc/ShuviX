import { BrowserWindow, ipcMain } from 'electron'
import {
  scanSessionFiles,
  scanSessionDir,
  watchSessionFile,
  unwatchSessionFile
} from '../services/filesWatcherService'
import { previewSessionFile, writeSessionFile, saveBinaryAs } from '../services/filePreviewService'
import { reportChartValidation } from '../services/previewValidationBroker'
import { findArtifact, readArtifact } from '../services/artifacts/store'
import { sessionDao } from '../dao/sessionDao'

export function registerFilesHandlers(): void {
  ipcMain.handle('files:scan', (_event, params: { sessionId: string }) =>
    scanSessionFiles(params.sessionId)
  )
  // 按目录浅扫描（文件树懒加载）：dir 相对工作目录，空串 = 根
  ipcMain.handle('files:scanDir', (_event, params: { sessionId: string; dir: string }) =>
    scanSessionDir(params.sessionId, params.dir)
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
  // 会话 Artifact 按**名字**取内容 —— ```artifact 引用围栏的数据通道。
  // 刻意不走 files:read：那条要绝对路径，而围栏里只该有名字（路径不进转写），
  // 名字→路径的解析是本会话目录的事，归 artifacts 模块。
  ipcMain.handle('artifact:read', (_event, params: { sessionId: string; name: string }) => {
    // 先本会话，再往下找一层子会话：产物的目录跟着**产出它的那场会话**走（见 artifacts/store
    // 的说明），而 `work` 基座的分工正是把具体活交给 `coding` 子会话 —— 子代理画的图，
    // 父会话终答里的引用必须展示得出来。嵌套只有一层，所以不递归。
    const candidates = [
      params.sessionId,
      ...sessionDao.findChildren(params.sessionId).map((c) => c.id)
    ]
    for (const sid of candidates) {
      const found = findArtifact(sid, params.name)
      if (!found) continue
      const content = readArtifact(sid, params.name)
      if (content !== null) return { name: found.name, title: found.title, content }
    }
    return null
  })
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
