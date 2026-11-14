import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, RotateCcw, Trash2 } from 'lucide-react'
import type { TrackingItem } from '@shuvix/chat-protocol/trackingNotes'
import { ConfirmDialog } from '../common/ConfirmDialog'

/**
 * 设置 → 已归档 → 跟踪项（2026-11-14 用户：已归档的跟踪项从收件箱挪到设置里）。收件箱只列还在跟的；归档了的在这里
 * 恢复（状态改回 `active`，回到收件箱的「跟踪中」）或删除（与收件箱的行菜单同一个确认框、同一条宿主路径：先把删除前
 * 那一版记进跟踪项文件夹的 git 历史，连它的笔记本会话一起删）。每行是标题 + 结论（标题下第一段）+ 文件名。
 * 设置是独立窗口：订阅 `tracking.changed` 刷新，收件箱那边归档了这里要跟上。不在这里打开文件 —— 设置窗口打不开主窗口
 * 里的会话，要看内容就先恢复。
 */
export function ArchivedTracking(): React.JSX.Element {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TrackingItem[]>([])
  const [deleting, setDeleting] = useState<TrackingItem | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const items = await window.api.tracking.list()
      setRows(items.filter((item) => item.status === 'archived'))
    } catch {
      setRows([])
    }
  }, [])

  useEffect(() => {
    // 回包在微任务之后才写 state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
    return window.api.events.subscribe((event) => {
      if (event.type === 'tracking.changed') void reload()
    })
  }, [reload])

  const restore = async (row: TrackingItem): Promise<void> => {
    try {
      await window.api.tracking.setStatus({ fileName: row.fileName, status: 'active' })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    void reload()
  }

  return (
    <>
      {error && <div className="px-3 pb-2 text-[11px] text-error">{error}</div>}
      {rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-text-tertiary text-xs">
          {t('settings.archivedTrackingEmpty')}
        </div>
      ) : (
        <div className="space-y-0.5" data-archived-tracking="">
          {rows.map((item) => (
            <div
              key={item.fileName}
              data-archived-tracking-item={item.fileName}
              className="group relative flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-text-secondary hover:bg-bg-hover"
            >
              <Archive size={14} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
              <div className="flex-1 min-w-0 group-hover:pr-16 [@media(hover:none)]:pr-16">
                <div className="truncate text-[13px]">{item.title}</div>
                <div className="truncate text-[11px] text-text-tertiary">
                  {item.conclusion && (
                    <>
                      {item.conclusion}
                      {' · '}
                    </>
                  )}
                  <span className="font-mono">{item.fileName}</span>
                </div>
              </div>
              {/* 没有悬停的设备（触屏、手机布局）上一直显示：这两个按钮是恢复 / 删除的唯一入口 */}
              <div className="absolute right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                <button
                  data-archived-tracking-restore=""
                  onClick={() => void restore(item)}
                  className="p-1 rounded hover:bg-bg-hover text-text-tertiary/70 hover:text-text-secondary"
                  title={t('settings.archivedTrackingRestore')}
                  aria-label={t('settings.archivedTrackingRestore')}
                >
                  <RotateCcw size={13} className="text-green-400/80" />
                </button>
                <button
                  data-archived-tracking-delete=""
                  onClick={() => setDeleting(item)}
                  className="p-1 rounded hover:bg-bg-hover text-text-tertiary/70 hover:text-red-400"
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
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
          title={t('sidebar.trackingConfirmDeleteTitle')}
          description={t('sidebar.trackingConfirmDeleteDescription', { title: deleting.title })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={async () => {
            const target = deleting
            setDeleting(null)
            try {
              await window.api.tracking.deleteItem({ fileName: target.fileName })
              setError(null)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
            void reload()
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}
