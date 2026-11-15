import { useTranslation } from 'react-i18next'
import type { Session } from '@shuvix/chat-ui'
import { useProjects } from '@shuvix/app-shell'
import { boundBotOf, projectContextIdOf } from '@shuvix/chat-protocol/botSession'

/**
 * 一条会话在哪干活：项目名；bot 会话（和它开出来的子会话）是它的工作项目，bot 会话没有工作项目是「临时」；
 * 别的不属于项目的是「聊天」。
 * 项目在清单里找不到时先不写 —— 清单可能还没取回来（刚打开对话页的那一下），不能先说它「未命名」或「已删除」
 */
export function useSessionLocation(session: Session | undefined): string {
  const { t } = useTranslation()
  const { projects, archivedProjects } = useProjects()
  if (!session) return ''
  const nameOf = (id: string): string => {
    const project = [...projects, ...archivedProjects].find((p) => p.id === id)
    return project ? project.name || t('sidebar.unnamedProject') : ''
  }
  // 所属项目，否则引用的工作项目（bot 会话，和它开出来的子会话）
  const project = projectContextIdOf(session)
  if (project) return nameOf(project)
  return boundBotOf(session.settings) ? t('sidebar.botTempLocation') : t('sidebar.tempChats')
}
