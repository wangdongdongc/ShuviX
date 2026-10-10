import { ipcMain } from 'electron'
import { noteView, setNoteFill, unsetNoteFill } from '../services/mdMetaService'

/**
 * md 扩展元数据 IPC —— 属性卡「ShuviX 设置」条读写一份注册表笔记的补缺值（ChatApi `mdMeta`）。
 * 按笔记本会话认文件，校验全在 mdMetaService；这是补缺值唯一的写入口（不给工具、不给 CLI）。
 */
export function registerMdMetaHandlers(): void {
  ipcMain.handle('mdMeta:get', (_event, params: { sessionId: string }) =>
    noteView(params?.sessionId)
  )
  ipcMain.handle(
    'mdMeta:setFill',
    (_event, params: { sessionId: string; objectId: string; key: string; value: unknown }) =>
      setNoteFill(params)
  )
  ipcMain.handle(
    'mdMeta:unsetFill',
    (_event, params: { sessionId: string; objectId: string; key: string }) => unsetNoteFill(params)
  )
}
