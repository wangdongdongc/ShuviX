import { ipcMain } from 'electron'
import { commandService } from '../services/commandService'
import { skillService } from '../services/skillService'
import { agentService } from '../services/agentService'
import { sessionDao } from '../dao/sessionDao'
import { projectDao } from '../dao/projectDao'
import type { SlashCommand } from '@shuvix/chat-protocol/types/slashCommand'

/**
 * 聚合所有来源的斜杠命令（命令源扩展点）
 *
 * - `projectPath` 为 null 时（如欢迎页未建会话），跳过依赖项目的源（如 .claude/commands/、项目级 skill）
 * - 命名冲突按数组顺序优先：靠前的源胜出（项目命令 > skill 命令）
 * - 新增内置命令源在此函数内追加即可（如 /help、/clear、内置 builtin pack 等）
 */
function gatherSlashCommands(projectPath: string | null): SlashCommand[] {
  // 1. 项目命令（来自 .claude/commands/）—— 需要 projectPath
  const projectCommands: SlashCommand[] = projectPath
    ? commandService.discoverCommands(projectPath).map((c) => ({ ...c, kind: 'project' as const }))
    : []
  const taken = new Set(projectCommands.map((c) => c.commandId))

  // 2. Skill 命令（已启用 skill；projectPath 为 null 时自动跳过项目级 skill）
  const skillCommands = skillService
    .findEnabledAsCommands(projectPath ?? undefined)
    .filter((c) => !taken.has(c.commandId))
  skillCommands.forEach((c) => taken.add(c.commandId))

  // 3. 子代理派发命令（kind 'agent'）：`/<agentName> <prompt>` 由前端识别 kind 走
  //    agent.dispatchPrompt 直接派发具名子智能体（无模板展开）。名字含空白无法按
  //    "/name 参数" 解析，跳过；与项目/skill 命令同名时靠后让位（taken 去重）
  const agentCommands: SlashCommand[] = agentService
    .listEnabled()
    .filter((a) => !/\s/.test(a.name) && !taken.has(a.name))
    .map((a) => ({
      commandId: a.name,
      name: a.displayName,
      description: a.whenToUse,
      template: '',
      filePath: a.basePath,
      kind: 'agent' as const
    }))
  agentCommands.forEach((c) => taken.add(c.commandId))

  // 4. （未来）其他内置命令源在此处追加，统一通过 taken 去重

  return [...projectCommands, ...skillCommands, ...agentCommands]
}

/**
 * 斜杠命令相关 IPC 处理器
 */
export function registerCommandHandlers(): void {
  /**
   * 获取斜杠命令列表
   * - 已激活会话：解析出 projectPath，包含项目命令 + 全部 skill 命令
   * - 无会话（欢迎页）：projectPath 为 null，仅返回不依赖项目的命令（如全局/内置/外部 skill）
   */
  ipcMain.handle('command:list', (_event, params: { sessionId: string | null }) => {
    let projectPath: string | null = null
    if (params.sessionId) {
      const session = sessionDao.pick(params.sessionId, ['projectId'])
      if (session?.projectId) {
        projectPath = projectDao.pick(session.projectId, ['path'])?.path ?? null
      }
    }
    return gatherSlashCommands(projectPath)
  })
}
