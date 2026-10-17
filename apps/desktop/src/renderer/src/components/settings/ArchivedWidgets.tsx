import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, RotateCcw, Trash2 } from 'lucide-react'
import { useWidgetStore } from '../../stores/widgetStore'
import { ConfirmDialog } from '../common/ConfirmDialog'

/**
 * 设置 → 已归档 → 小组件：归档的小组件不在 Widget 面板里，都在这里 —— 恢复或删除。
 * 数据与面板同一个 widgetStore，订阅 'widget.changed' 刷新（设置是独立窗口时，面板那边的 store 不在这里）。
 */
export function ArchivedWidgets(): React.JSX.Element {
  const { t } = useTranslation()
  const archived = useWidgetStore((s) => s.archived)
  const reload = useWidgetStore((s) => s.reload)
  const archiveWidget = useWidgetStore((s) => s.archiveWidget)
  const deleteWidget = useWidgetStore((s) => s.deleteWidget)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    void reload()
    return window.api.events.subscribe((event) => {
      if (event.type === 'widget.changed') void reload()
    })
  }, [reload])

  const deleting = archived.find((w) => w.id === deletingId) ?? null

  return (
    <>
      {archived.length === 0 ? (
        <div className="px-3 py-8 text-center text-text-tertiary text-xs">
          {t('widgets.noArchived')}
        </div>
      ) : (
        <div className="space-y-0.5" data-archived-widgets="">
          {archived.map((w) => (
            <div
              key={w.id}
              data-archived-widget={w.id}
              className="group relative flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-text-secondary hover:bg-bg-hover"
            >
              <Archive size={13} className="flex-shrink-0 text-text-tertiary/60" />
              <div className="flex-1 min-w-0 group-hover:pr-16 [@media(hover:none)]:pr-16">
                <div className="truncate text-[13px]">{w.name}</div>
                {w.description && (
                  <div className="truncate text-[11px] text-text-tertiary">{w.description}</div>
                )}
              </div>
              {/* 没有悬停的设备（触屏、手机布局）上一直显示：这两个按钮是恢复 / 删除的唯一入口 */}
              <div className="absolute right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                <button
                  onClick={() => void archiveWidget(w.id, false)}
                  className="p-1 rounded hover:bg-bg-hover text-text-tertiary/70 hover:text-text-secondary"
                  title={t('widgets.restore')}
                  aria-label={t('widgets.restore')}
                >
                  <RotateCcw size={13} className="text-green-400/80" />
                </button>
                <button
                  onClick={() => setDeletingId(w.id)}
                  className="p-1 rounded hover:bg-bg-hover text-text-tertiary/70 hover:text-red-400"
                  title={t('widgets.delete')}
                  aria-label={t('widgets.delete')}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title={t('widgets.confirmDeleteTitle')}
          description={t('widgets.confirmDeleteDescription', { name: deleting.name })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={async () => {
            await deleteWidget(deleting.id)
            setDeletingId(null)
          }}
          onCancel={() => setDeletingId(null)}
        />
      )}
    </>
  )
}
