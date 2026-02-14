import { ipcMain } from 'electron'
import { sessionService } from '../services/sessionService'
import type { Session, SessionUpdateModelConfigParams, SessionUpdateTitleParams } from '../types'

/**
 * 会话管理 IPC 处理器
 * 负责参数解析，委托给 SessionService
 */
export function registerSessionHandlers(): void {
  /** 获取所有会话 */
  ipcMain.handle('session:list', () => {
    return sessionService.list()
  })

  /** 创建新会话 */
  ipcMain.handle('session:create', (_event, params?: Partial<Session>) => {
    return sessionService.create(params)
  })

  /** 更新会话标题 */
  ipcMain.handle('session:updateTitle', (_event, params: SessionUpdateTitleParams) => {
    sessionService.updateTitle(params.id, params.title)
    return { success: true }
  })

  /** 更新会话模型配置（provider/model） */
  ipcMain.handle('session:updateModelConfig', (_event, params: SessionUpdateModelConfigParams) => {
    sessionService.updateModelConfig(params.id, params.provider, params.model)
    return { success: true }
  })

  /** 删除会话 */
  ipcMain.handle('session:delete', (_event, id: string) => {
    sessionService.delete(id)
    return { success: true }
  })
}
