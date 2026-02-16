import { ipcMain, dialog, BrowserWindow } from 'electron'
import { sessionService } from '../services/sessionService'
import { agentService } from '../services/agent'
import { dockerManager } from '../services/dockerManager'
import type {
  Session,
  SessionUpdateDockerParams,
  SessionUpdateModelConfigParams,
  SessionUpdateTitleParams,
  SessionUpdateWorkingDirParams
} from '../types'

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

  /** 更新工作目录 */
  ipcMain.handle('session:updateWorkingDir', (_event, params: SessionUpdateWorkingDirParams) => {
    sessionService.updateWorkingDirectory(params.id, params.workingDirectory)
    return { success: true }
  })

  /** 更新 Docker 配置 */
  ipcMain.handle('session:updateDocker', (_event, params: SessionUpdateDockerParams) => {
    sessionService.updateDockerConfig(params.id, params.dockerEnabled, params.dockerImage)
    return { success: true }
  })

  /** 删除会话 */
  ipcMain.handle('session:delete', (_event, id: string) => {
    sessionService.delete(id)
    return { success: true }
  })

  /** AI 自动生成会话标题（后台静默，对用户透明） */
  ipcMain.handle(
    'session:generateTitle',
    async (_event, params: { sessionId: string; userMessage: string; assistantMessage: string }) => {
      const title = await agentService.generateTitle(params.sessionId, params.userMessage, params.assistantMessage)
      if (title) {
        sessionService.updateTitle(params.sessionId, title)
      }
      return { title }
    }
  )

  /** 检测 Docker 是否可用 */
  ipcMain.handle('docker:check', () => {
    return { available: dockerManager.isDockerAvailable() }
  })

  /** 打开文件夹选择对话框 */
  ipcMain.handle('dialog:openDirectory', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
