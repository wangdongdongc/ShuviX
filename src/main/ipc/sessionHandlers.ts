import { ipcMain, dialog, BrowserWindow } from 'electron'
import { sessionService } from '../services/sessionService'
import { agentService } from '../services/agent'
import { dockerManager } from '../services/dockerManager'
import { chatGateway, operationContext, createElectronContext } from '../frontend'
import type {
  Session,
  SessionUpdateModelConfigParams,
  SessionUpdateModelMetadataParams,
  SessionUpdateProjectParams,
  SessionUpdateSettingsParams,
  SessionUpdateTitleParams
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

  /** 更新会话所属项目 */
  ipcMain.handle('session:updateProject', (_event, params: SessionUpdateProjectParams) => {
    sessionService.updateProjectId(params.id, params.projectId)
    return { success: true }
  })

  /** 更新模型元数据（思考深度等） */
  ipcMain.handle(
    'session:updateModelMetadata',
    (_event, params: SessionUpdateModelMetadataParams) => {
      sessionService.updateModelMetadata(params.id, params.modelMetadata)
      return { success: true }
    }
  )

  /** 更新会话级配置（sshAutoApprove 等） */
  ipcMain.handle('session:updateSettings', (_event, params: SessionUpdateSettingsParams) => {
    sessionService.updateSettings(params.id, params.settings)
    return { success: true }
  })

  /** 获取单个会话（含 workingDirectory） */
  ipcMain.handle('session:getById', (_event, id: string) => {
    return sessionService.getById(id) || null
  })

  /** 删除会话（同时清理 Agent 内存实例 + Docker 容器） */
  ipcMain.handle('session:delete', (_event, id: string) => {
    agentService.removeAgent(id)
    sessionService.delete(id)
    return { success: true }
  })

  /** AI 自动生成会话标题（后台静默，对用户透明） */
  ipcMain.handle(
    'session:generateTitle',
    async (
      _event,
      params: { sessionId: string; userMessage: string; assistantMessage: string }
    ) => {
      const title = await agentService.generateTitle(
        params.sessionId,
        params.userMessage,
        params.assistantMessage
      )
      if (title) {
        sessionService.updateTitle(params.sessionId, title)
      }
      return { title }
    }
  )

  /** 校验 Docker 环境（不传 image 仅检查命令可用性，传 image 则完整校验） */
  ipcMain.handle('docker:validate', async (_event, params?: { image?: string }) => {
    return dockerManager.validateSetup(params?.image)
  })

  /** 选择文件并读取其文本内容（用于 SSH 私钥等） */
  ipcMain.handle(
    'dialog:readTextFile',
    async (event, params?: { title?: string; filters?: Electron.FileFilter[] }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null
      const result = await dialog.showOpenDialog(win, {
        title: params?.title || 'Select File',
        properties: ['openFile'],
        filters: params?.filters || [{ name: 'All Files', extensions: ['*'] }]
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const fs = await import('fs/promises')
      const content = await fs.readFile(result.filePaths[0], 'utf-8')
      return { path: result.filePaths[0], content }
    }
  )

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

  /** 查询指定 session 的 Docker 容器状态 */
  ipcMain.handle('docker:sessionStatus', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () =>
      chatGateway.getDockerStatus(sessionId)
    )
  )

  /** 查询指定 session 的 SSH 连接状态 */
  ipcMain.handle('ssh:sessionStatus', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () =>
      chatGateway.getSshStatus(sessionId)
    )
  )

  /** 手动销毁指定 session 的 Docker 容器 */
  ipcMain.handle('docker:destroySession', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () =>
      chatGateway.destroyDocker(sessionId)
    )
  )

  /** 手动断开指定 session 的 SSH 连接 */
  ipcMain.handle('ssh:disconnectSession', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () =>
      chatGateway.disconnectSsh(sessionId)
    )
  )
}
