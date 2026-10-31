import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw, Trash2 } from 'lucide-react'
import { BotAvatar } from '@shuvix/chat-ui'
import { ConfirmDialog } from '../common/ConfirmDialog'

interface ArchivedBotRow {
  name: string
  displayName: string
  description: string
  fileName: string
  sessionCount: number
}

/**
 * 设置 → 已归档 → Bots：归档的 bot（文件在 bots 目录的 `archived/` 里）不在侧栏，它的会话也一起藏着 —— 在这里恢复，
 * 或删除（与项目一样：删 bot 就是连它的会话一起删，用户 2026-10-30；确认框说清楚会删几条）。
 * 订阅 'bot.changed' 刷新（设置是独立窗口，侧栏那边归档了这里要跟上）。
 */
export function ArchivedBots(): React.JSX.Element {
  const { t } = useTranslation()
  const [rows, setRows] = useState<ArchivedBotRow[]>([])
  const [deleting, setDeleting] = useState<ArchivedBotRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setRows(await window.api.bot.listArchived())
  }, [])

  useEffect(() => {
    // 回包在微任务之后才写 state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
    return window.api.events.subscribe((event) => {
      if (event.type === 'bot.changed') void reload()
    })
  }, [reload])

  const restore = async (row: ArchivedBotRow): Promise<void> => {
    const r = await window.api.bot.restore({ fileName: row.fileName })
    setError(r.success ? null : (r.error ?? null))
  }

  return (
    <>
      {error && <div className="px-3 pb-2 text-[11px] text-error">{error}</div>}
      {rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-text-tertiary text-xs">
          {t('settings.archivedBotsEmpty')}
        </div>
      ) : (
        <div className="space-y-0.5" data-archived-bots="">
          {rows.map((b) => (
            <div
              key={b.fileName}
              data-archived-bot={b.fileName}
              className="group relative flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-text-secondary hover:bg-bg-hover"
            >
              <span className="flex-shrink-0 opacity-70">
                <BotAvatar name={b.name} displayName={b.displayName} size={15} />
              </span>
              <div className="flex-1 min-w-0 group-hover:pr-16 [@media(hover:none)]:pr-16">
                <div className="truncate text-[13px]">{b.displayName}</div>
                <div className="truncate text-[11px] text-text-tertiary">
                  {t('settings.archivedBotSessions', { count: b.sessionCount })}
                  {' · '}
                  <span className="font-mono">{b.fileName}</span>
                </div>
              </div>
              {/* 没有悬停的设备（触屏、手机布局）上一直显示：这两个按钮是恢复 / 删除的唯一入口 */}
              <div className="absolute right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                <button
                  data-archived-bot-restore=""
                  onClick={() => void restore(b)}
                  className="p-1 rounded hover:bg-bg-hover text-text-tertiary/70 hover:text-text-secondary"
                  title={t('settings.archivedBotRestore')}
                  aria-label={t('settings.archivedBotRestore')}
                >
                  <RotateCcw size={13} className="text-green-400/80" />
                </button>
                <button
                  data-archived-bot-delete=""
                  onClick={() => setDeleting(b)}
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
          title={t('settings.archivedBotDeleteTitle', { name: deleting.displayName })}
          description={t('settings.archivedBotDeleteDesc', { count: deleting.sessionCount })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={async () => {
            const r = await window.api.bot.deleteArchived({ fileName: deleting.fileName })
            setError(r.success ? null : (r.error ?? null))
            setDeleting(null)
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}
