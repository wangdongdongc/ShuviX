import { ipcMain, dialog, BrowserWindow } from 'electron'
import { sessionService } from '../services/sessionService'
import { closeWatcherIfWorkingDirectory } from '../services/filesWatcherService'
import { chatGateway, operationContext, createElectronContext } from '../frontend'
import { isPinned, unpin as unpinPinnedChat } from '../services/pinnedChatService'
import type {
  SessionUpdateModelConfigParams,
  SessionUpdateThinkingLevelParams,
  SessionUpdateEnabledToolsParams,
  SessionUpdateProjectParams,
  SessionUpdateAutoApproveParams,
  SessionAllowListAddParams,
  SessionAllowListRemoveParams,
  SessionUpdateTitleParams,
  SessionCreateParams
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

  /** 创建新会话（含笔记本会话：params.notebookPath 非空时绑定 md 文件） */
  ipcMain.handle('session:create', (_event, params?: SessionCreateParams) => {
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

  /** 更新思考深度 */
  ipcMain.handle(
    'session:updateThinkingLevel',
    (_event, params: SessionUpdateThinkingLevelParams) => {
      sessionService.updateThinkingLevel(params.id, params.thinkingLevel)
      return { success: true }
    }
  )

  /** 更新会话启用工具列表 */
  ipcMain.handle(
    'session:updateEnabledTools',
    (_event, params: SessionUpdateEnabledToolsParams) => {
      sessionService.updateEnabledTools(params.id, params.enabledTools)
      return { success: true }
    }
  )

  /** 更新命令免审批（统一开关） */
  ipcMain.handle('session:updateAutoApprove', (_event, params: SessionUpdateAutoApproveParams) => {
    sessionService.updateAutoApprove(params.id, params.autoApprove)
    return { success: true }
  })

  /** 预览命令拆解后的通配符模式（过滤已在允许列表中的） */
  ipcMain.handle(
    'session:previewAllowPatterns',
    (_event, params: { command: string; sessionId?: string; toolType?: 'bash' | 'ssh' }) => {
      return sessionService.previewAllowPatterns(params.command, params.sessionId, params.toolType)
    }
  )

  /** 批量添加模式到统一允许列表 */
  ipcMain.handle('session:addAllowListPatterns', (_event, params: SessionAllowListAddParams) => {
    sessionService.addAllowListPatterns(params.id, params.toolType, params.patterns)
    return { success: true }
  })

  /** 从统一允许列表移除条目 */
  ipcMain.handle('session:removeAllowListEntry', (_event, params: SessionAllowListRemoveParams) => {
    sessionService.removeAllowListEntry(params.id, params.entry)
    return { success: true }
  })

  /** 获取单个会话（含 workingDirectory） */
  ipcMain.handle('session:getById', (_event, id: string) => {
    return sessionService.getById(id) || null
  })

  /** 扫描会话工作目录顶层的候选指令文件 */
  ipcMain.handle('session:scanInstructionFiles', (_event, sessionId: string) => {
    return sessionService.scanInstructionFiles(sessionId)
  })

  /** 更新会话启用的指令文件列表 */
  ipcMain.handle(
    'session:updateInstructionFiles',
    (_event, params: { id: string; filenames: string[] }) => {
      sessionService.updateEnabledInstructionFiles(params.id, params.filenames)
      return { success: true }
    }
  )

  /** 删除会话（同时清理 Agent 内存实例、消息、HTTP 日志和临时工作目录） */
  ipcMain.handle('session:delete', async (_event, id: string) => {
    // 若被删的会话正处于悬浮态，先关闭对应悬浮窗
    if (isPinned(id)) {
      await unpinPinnedChat(id, 'session-deleted')
    }
    // 删除前捕获 workingDirectory，删除后用于关闭 watcher（仅当当前 watcher 监听的就是此目录时）
    // 注：同项目的多个会话共享 workingDirectory，此时不应误关 —— closeWatcherIfWorkingDirectory
    // 只做"路径相同则关"的窄判断；项目目录被多个会话共用时不影响其它会话的后续 scan
    const wd = sessionService.getById(id)?.workingDirectory
    sessionService.delete(id)
    if (wd) closeWatcherIfWorkingDirectory(wd)
    return { success: true }
  })

  /** AI 自动生成会话标题（后台静默，对用户透明） */
  ipcMain.handle(
    'session:generateTitle',
    async (_event, params: { sessionId: string; conversationText: string }) => {
      const title =
        (await sessionService
          .getAgentSession(params.sessionId)
          ?.generateTitle(params.conversationText)) ?? null
      if (title) {
        sessionService.updateTitle(params.sessionId, title)
      }
      return { title }
    }
  )

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

  /** 查询指定 session 的所有运行时资源状态 */
  ipcMain.handle('runtime:statuses', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () =>
      chatGateway.getRuntimeStatuses(sessionId)
    )
  )

  /** 销毁指定运行时资源 */
  ipcMain.handle('runtime:destroy', (_event, params: { sessionId: string; runtimeId: string }) =>
    operationContext.run(createElectronContext(params.sessionId), () =>
      chatGateway.destroyRuntime(params.sessionId, params.runtimeId)
    )
  )
}
