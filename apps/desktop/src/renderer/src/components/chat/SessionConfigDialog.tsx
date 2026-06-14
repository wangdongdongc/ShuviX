import { getChatApi } from '@shuvix/chat-ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, X } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import { useDialogClose } from '@shuvix/chat-ui'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SessionConfigPanel } from './SessionConfigPanel'

export function SessionConfigDialog({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const session = useChatStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const [title, setTitle] = useState(session?.title || '')

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

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
      onClick={handleClose}
    >
      <div
        className="w-[560px] max-w-[90vw] bg-bg-primary border border-border-secondary rounded-xl shadow-xl max-h-[85vh] flex flex-col dialog-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-secondary/50 bg-bg-secondary/50">
          <h3 className="text-sm font-semibold text-text-primary">{t('sessionConfig.title')}</h3>
          <button
            onClick={handleClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-5 overflow-y-auto flex-1 min-h-0">
          {/* 会话标题 */}
          <section>
            <h3 className="text-[13px] font-semibold text-text-primary mb-2 px-1">
              {t('sessionConfig.sessionTitle')}
            </h3>
            <div className="rounded-xl border border-border-secondary/60 bg-bg-secondary/30 px-4 py-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void handleSaveTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSaveTitle()
                }}
                className="w-full bg-transparent border-none outline-none text-[13px] text-text-primary placeholder:text-text-tertiary"
              />
            </div>
          </section>

          <SessionConfigPanel sessionId={sessionId} />
        </div>

        <div className="px-4 py-3 border-t border-border-secondary/50 bg-bg-secondary/30 flex items-center justify-between">
          <button
            onClick={() => void handleRequestDelete()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={12} />
            {t('common.delete')}
          </button>
          <button
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
