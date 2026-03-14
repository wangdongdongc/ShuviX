import { ipcMain } from 'electron'
import { commandService } from '../services/commandService'
import { sessionDao } from '../dao/sessionDao'
import { projectDao } from '../dao/projectDao'

/**
 * 斜杠命令相关 IPC 处理器
 */
export function registerCommandHandlers(): void {
  /** 获取当前会话可用的斜杠命令列表 */
  ipcMain.handle('command:list', (_event, params: { sessionId: string }) => {
    const session = sessionDao.pick(params.sessionId, ['projectId'])
    if (!session?.projectId) return []
    const project = projectDao.pick(session.projectId, ['path'])
    if (!project?.path) return []
    return commandService.discoverCommands(project.path)
  })
}
