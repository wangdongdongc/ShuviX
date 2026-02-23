import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, FolderOpen } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import type { Session } from '../../stores/chatStore'

interface ProjectOption {
  id: string
  name: string
}

interface SessionEditDialogProps {
  session: Session
  onClose: () => void
}

/**
 * 会话编辑弹窗 — 编辑标题、所属项目
 */
export function SessionEditDialog({ session, onClose }: SessionEditDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [title, setTitle] = useState(session.title)
  const [projectId, setProjectId] = useState<string | null>(session.projectId)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [saving, setSaving] = useState(false)

  // 加载项目列表
  useEffect(() => {
    window.api.project.list().then((list) => {
      setProjects(list.map((p) => ({ id: p.id, name: p.name })))
    })
  }, [])

  // 按 Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  /** 保存所有变更 */
  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const store = useChatStore.getState()

      // 更新标题
      if (title.trim() && title.trim() !== session.title) {
        await window.api.session.updateTitle({ id: session.id, title: title.trim() })
        store.updateSessionTitle(session.id, title.trim())
      }

      // 更新所属项目
      if (projectId !== session.projectId) {
        await window.api.session.updateProject({ id: session.id, projectId })
        store.updateSessionProject(session.id, projectId)
      }

      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay">
      <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[420px] max-w-[90vw] dialog-panel">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-secondary">
          <h2 className="text-sm font-semibold text-text-primary">{t('sessionEdit.title')}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="px-5 py-4 space-y-4">
          {/* 标题 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">{t('sessionEdit.sessionTitle')}</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors"
              placeholder={t('sessionEdit.sessionTitlePlaceholder')}
            />
          </div>

          {/* 所属项目 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              <FolderOpen size={12} className="inline mr-1 -mt-0.5" />
              {t('sessionEdit.project')}
            </label>
            <select
              value={projectId || ''}
              onChange={(e) => setProjectId(e.target.value || null)}
              className="w-full bg-bg-secondary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary outline-none focus:border-accent transition-colors"
            >
              <option value="">{t('sessionEdit.noProject')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="text-[10px] text-text-tertiary mt-1">
              {t('sessionEdit.projectHint')}
            </p>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-lg text-xs bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
