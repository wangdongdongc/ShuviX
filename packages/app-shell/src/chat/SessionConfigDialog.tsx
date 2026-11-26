import { getChatApi } from '@shuvix/chat-ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Puzzle, ShieldCheck, Trash2, X } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import { useDialogClose, isImeComposing } from '@shuvix/chat-ui'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SessionAclSection, useSessionAclCounts } from './SessionAclSection'
import { SessionExtensionsSection } from './SessionConfigPanel'

export interface SessionConfigDialogProps {
  sessionId: string
  onClose: () => void
}

type SessionConfigTabKey = 'extensions' | 'permissions'

export function SessionConfigDialog({
  sessionId,
  onClose
}: SessionConfigDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const session = useChatStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const [title, setTitle] = useState(session?.title || '')
  const [activeTab, setActiveTab] = useState<SessionConfigTabKey>('extensions')
  const aclCounts = useSessionAclCounts(sessionId)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  const handleSaveTitle = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed || trimmed === session?.title) return
    await getChatApi().session.updateTitle({ id: sessionId, title: trimmed })
    useChatStore.getState().updateSessionTitle(sessionId, trimmed)
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const handleRequestDelete = async (): Promise<void> => {
    const msgs = await getChatApi().message.list(sessionId)
    if (msgs.length > 0) {
      setShowDeleteConfirm(true)
    } else {
      await doDeleteSession()
    }
  }

  const doDeleteSession = async (): Promise<void> => {
    await getChatApi().session.delete(sessionId)
    useChatStore.getState().removeSession(sessionId)
    onClose()
  }

  const totalAclCount = aclCounts ? aclCounts.paths + aclCounts.sessions + aclCounts.widgets : 0

  const tabs: {
    key: SessionConfigTabKey
    label: string
    icon: React.ReactNode
    badge?: number
  }[] = [
    {
      key: 'extensions',
      label: t('sessionConfig.extensionsGroup'),
      icon: <Puzzle size={12} />
    },
    {
      key: 'permissions',
      label: t('sessionConfig.permissionsTab'),
      icon: <ShieldCheck size={12} />,
      badge: totalAclCount
    }
  ]

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        data-session-config-dialog=""
        className="w-[680px] max-w-[92vw] h-[520px] max-h-[80vh] bg-bg-primary border border-border-primary rounded-xl shadow-xl flex flex-col overflow-hidden dialog-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：行内可编辑会话标题 + 关闭 + 顶部下划线 Tab 栏 */}
        <div className="bg-bg-secondary/40 border-b border-border-secondary/60 px-5 pt-3.5 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-[11px] font-medium text-text-tertiary shrink-0">
                {t('sessionConfig.title')}
              </span>
              <span className="text-border-primary shrink-0">/</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void handleSaveTitle()}
                onKeyDown={(e) => {
                  // 输入法组字中的回车是「确认选词」，不能当成提交（中文标题必踩）
                  if (isImeComposing(e)) return
                  if (e.key === 'Enter') {
                    void handleSaveTitle()
                    e.currentTarget.blur()
                  }
                }}
                placeholder={t('sessionConfig.sessionTitle')}
                aria-label={t('sessionConfig.sessionTitle')}
                className="min-w-0 flex-1 bg-transparent px-2 py-0.5 -ml-1 rounded-md border border-transparent hover:border-border-secondary/60 focus:border-accent/60 focus:bg-bg-primary outline-none text-sm font-semibold text-text-primary placeholder:text-text-tertiary placeholder:font-normal transition-colors"
              />
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors shrink-0"
            >
              <X size={14} />
            </button>
          </div>

          <div role="tablist" className="flex items-center gap-5 mt-2.5 -mb-px">
            {tabs.map(({ key, label, icon, badge }) => {
              const active = activeTab === key
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-config-tab={key}
                  onClick={() => setActiveTab(key)}
                  className={`relative inline-flex items-center gap-1.5 pb-2.5 text-xs transition-colors ${
                    active
                      ? 'text-text-primary font-medium'
                      : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                >
                  <span className="flex shrink-0 opacity-80">{icon}</span>
                  <span>{label}</span>
                  {badge !== undefined && badge > 0 && (
                    <span
                      className={`px-1.5 py-px rounded-full text-[10px] tabular-nums leading-tight ${
                        active ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-tertiary'
                      }`}
                    >
                      {badge}
                    </span>
                  )}
                  {active && (
                    <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-accent" />
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {activeTab === 'extensions' ? (
            <SessionExtensionsSection sessionId={sessionId} hideTitle />
          ) : (
            <SessionAclSection sessionId={sessionId} />
          )}
        </div>

        <div className="px-5 py-3 border-t border-border-secondary/60 bg-bg-secondary/30 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={() => void handleRequestDelete()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={12} />
            {t('common.delete')}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-bg-secondary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('sidebar.confirmDelete')}
          description={
            <>
              {t('sidebar.deleteWarning')}
              <span className="text-error font-medium">{t('sidebar.deleteWarningBold')}</span>
              {t('sidebar.deleteWarningEnd')}
            </>
          }
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void doDeleteSession()}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
