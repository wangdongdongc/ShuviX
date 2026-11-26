/**
 * ProjectConfigDialog —— 项目配置弹窗外壳（共享）。
 * 头部(标题 + tab 切换 + 关闭) + 内容(当前 tab) + 底部(归档 / 取消 / 保存)。
 * tab 内容由宿主注入（桌面：项目信息 + 扩展能力 + 高级；扩展：仅项目信息）。归档确认内置。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useDialogClose } from '@shuvix/chat-ui'
import { ConfirmDialog } from '../common/ConfirmDialog'

export interface ProjectConfigTab {
  key: string
  label: string
  icon?: React.ReactNode
  /** 可选小计数徽标（> 0 时展示） */
  badge?: number
  content: React.ReactNode
}

export interface ProjectConfigDialogProps {
  title: string
  tabs: ProjectConfigTab[]
  activeTab: string
  onTabChange: (key: string) => void
  onClose: () => void
  onSave: () => void | Promise<void>
  saving?: boolean
  /** 传入则显示「归档」按钮（点后弹确认 → onArchive） */
  onArchive?: () => void | Promise<void>
}

export function ProjectConfigDialog({
  title,
  tabs,
  activeTab,
  onTabChange,
  onClose,
  onSave,
  saving = false,
  onArchive
}: ProjectConfigDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { closing, handleClose } = useDialogClose(onClose)
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleClose])

  const current = tabs.find((tb) => tb.key === activeTab) ?? tabs[0]
  const hasTabs = tabs.length > 1

  return (
    <div
      onClick={handleClose}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 dialog-overlay${closing ? ' dialog-closing' : ''}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-project-config-dialog=""
        className={`bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[680px] max-w-[92vw] ${
          hasTabs ? 'h-[520px]' : ''
        } max-h-[80vh] flex flex-col overflow-hidden dialog-panel`}
      >
        {/* 头部：标题 + X，以及多 tab 时的顶部下划线切换栏 */}
        <div
          className={`bg-bg-secondary/40 border-b border-border-secondary/60 shrink-0 ${
            hasTabs ? 'px-5 pt-3.5' : 'px-5 py-3'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-text-primary truncate">{title}</h3>
            <button
              type="button"
              onClick={handleClose}
              className="p-1 rounded-lg hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors shrink-0"
            >
              <X size={14} />
            </button>
          </div>
          {hasTabs && (
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
                    onClick={() => onTabChange(key)}
                    className={`relative inline-flex items-center gap-1.5 pb-2.5 text-xs transition-colors ${
                      active
                        ? 'text-text-primary font-medium'
                        : 'text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    {icon && <span className="flex shrink-0 opacity-80">{icon}</span>}
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
          )}
        </div>

        {/* 内容 */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">{current?.content}</div>

        {/* 底部：归档（左） + 取消/保存（右） */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border-secondary/60 bg-bg-secondary/30 shrink-0">
          {onArchive ? (
            <button
              onClick={() => setShowArchiveConfirm(true)}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-xs text-error hover:bg-error/10 transition-colors disabled:opacity-50"
            >
              {t('projectForm.archiveProject')}
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void onSave()}
              disabled={saving}
              className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>

      {showArchiveConfirm && onArchive && (
        <ConfirmDialog
          title={t('projectForm.archiveConfirmTitle')}
          description={t('projectForm.archiveConfirmDesc')}
          confirmText={t('projectForm.archiveConfirmAction')}
          cancelText={t('common.cancel')}
          onConfirm={() => {
            setShowArchiveConfirm(false)
            void onArchive()
          }}
          onCancel={() => setShowArchiveConfirm(false)}
        />
      )}
    </div>
  )
}
