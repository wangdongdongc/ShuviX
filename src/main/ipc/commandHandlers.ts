import { ipcMain } from 'electron'
import { commandService } from '../services/commandService'
import { skillService } from '../services/skillService'
import { sessionDao } from '../dao/sessionDao'
import { projectDao } from '../dao/projectDao'
import type { SlashCommand } from '../../shared/types/slashCommand'

/**
 * 斜杠命令相关 IPC 处理器
 */
export function registerCommandHandlers(): void {
  /** 获取当前会话可用的斜杠命令列表（项目命令 + 已启用 skill 命令） */
  ipcMain.handle('command:list', (_event, params: { sessionId: string }) => {
    const session = sessionDao.pick(params.sessionId, ['projectId'])
    if (!session) return []

    // 1. 项目命令（来自 .claude/commands/）
    const projectPath = session.projectId
      ? (projectDao.pick(session.projectId, ['path'])?.path ?? null)
      : null
    const projectCommands: SlashCommand[] = projectPath
      ? commandService
          .discoverCommands(projectPath)
          .map((c) => ({ ...c, kind: 'project' as const }))
      : []
    const projectIds = new Set(projectCommands.map((c) => c.commandId))

    // 2. Skill 命令（已启用 skill，commandId = skill.name）
    //    冲突时让位给项目命令——同名 .claude/commands/<id>.md 优先
    const skillCommands = skillService
      .findEnabledAsCommands(projectPath ?? undefined)
      .filter((c) => !projectIds.has(c.commandId))

    return [...projectCommands, ...skillCommands]
  })
}
