import { ipcMain } from 'electron'
import { commandService } from '../services/commandService'
import { skillService } from '../services/skillService'
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

  // 3. （未来）其他内置命令源在此处追加，统一通过 taken 去重
  //
  // 注：会话档案切换曾经也是一个命令源（kind 'agent'，`/<agentName> [prompt]`），已下线 ——
  // 改由输入框的档案选择器承担。那条路径顺带甩掉了三条只为 "/name 参数" 解析而生的限制：
  // 名字含空白的档案被丢弃、与项目/skill 命令重名的被让位、笔记本会话要单独关掉整段。
  // 档案列表现在走 session.listAgentProfiles。

  return [...projectCommands, ...skillCommands]
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
      const projectId = sessionDao.pick(params.sessionId, ['projectId'])?.projectId
      if (projectId) projectPath = projectDao.pick(projectId, ['path'])?.path ?? null
    }
    return gatherSlashCommands(projectPath)
  })
}
