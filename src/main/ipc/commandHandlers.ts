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
    const session = sessionDao.pick(params.sessionId, ['projectId', 'modelMetadata'])
    if (!session) return []

    // 项目命令（来自 .claude/commands/）
    const commands = session.projectId
      ? (() => {
          const project = projectDao.pick(session.projectId!, ['path'])
          return project?.path ? commandService.discoverCommands(project.path) : []
        })()
      : []

    // 内置命令（根据 enabledTools 条件）
    const enabledTools = session.modelMetadata?.enabledTools || []
    commands.push(...commandService.getBuiltinCommands(enabledTools))

    return commands
  })
}
