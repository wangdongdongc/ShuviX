/**
 * 输入框 `@` 会话的候选（chat-protocol `SessionMentionEntry`）：侧栏看得见的会话（`sessionService.list` —— 不含
 * Chrome 标签页会话与内存会话），去掉正在输入的这一条，最近活跃的在前。只给标题、项目名与父会话标题，不读对话。
 */
import type { SessionMentionEntry } from '@shuvix/chat-protocol/sessionMention'
import { projectDao } from '../dao/projectDao'
import { sessionService } from './sessionService'

export function listSessionMentions(sessionId: string): SessionMentionEntry[] {
  const sessions = sessionService.list()
  const titles = new Map(sessions.map((s) => [s.id, s.title]))
  const projectNames = new Map<string, string | undefined>()
  const projectName = (id: string | null): string | undefined => {
    if (!id) return undefined
    if (!projectNames.has(id)) projectNames.set(id, projectDao.pick(id, ['name'])?.name)
    return projectNames.get(id)
  }
  return sessions
    .filter((s) => s.id !== sessionId)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((s) => {
      const project = projectName(s.projectId)
      const parentTitle = s.parentId ? titles.get(s.parentId) : undefined
      return {
        id: s.id,
        title: s.title,
        ...(project ? { projectName: project } : {}),
        ...(parentTitle ? { parentTitle } : {}),
        lastActiveAt: s.lastActiveAt
      }
    })
}
