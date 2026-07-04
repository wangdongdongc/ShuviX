/**
 * 项目设置页（桌面）—— 薄封装共享 <ProjectsSettings>（已归档列表 + 恢复），
 * 注入桌面专属删除：弹 ConfirmDialog 确认，确认后级联删除并在必要时重指活跃会话。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ProjectsSettings as SharedProjectsSettings } from '@shuvix/app-shell'
import { getChatApi, useChatStore } from '@shuvix/chat-ui'
import { ConfirmDialog } from '../common/ConfirmDialog'

export function ProjectsSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null)

  /** 删除归档项目（含级联会话）；若当前活跃会话属于该项目先切走 */
  const doDeleteProject = async (projectId: string): Promise<void> => {
    const store = useChatStore.getState()
    const activeSession = store.sessions.find((s) => s.id === store.activeSessionId)
    if (activeSession?.projectId === projectId) {
      const other = store.sessions.find((s) => s.projectId !== projectId)
      if (other) store.setActiveSessionId(other.id)
    }
    await getChatApi().project.delete({ id: projectId })
    store.setSessions(await getChatApi().session.list())
    setDeletingProjectId(null)
  }

  return (
    <>
      <SharedProjectsSettings onDeleteProject={(id) => setDeletingProjectId(id)} />
      {deletingProjectId && (
        <ConfirmDialog
          title={t('sidebar.confirmDeleteProject')}
          description={
            <>
              {t('sidebar.deleteProjectWarning')}
              <span className="text-error font-medium">
                {t('sidebar.deleteProjectWarningBold')}
              </span>
              {t('sidebar.deleteProjectWarningEnd')}
            </>
          }
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void doDeleteProject(deletingProjectId)}
          onCancel={() => setDeletingProjectId(null)}
        />
      )}
    </>
  )
}
