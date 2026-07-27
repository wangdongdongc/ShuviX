import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench, Trash2, Archive, Square, ChevronRight, RotateCcw } from 'lucide-react'
import { useWidgetStore } from '../../stores/widgetStore'
import { useContextMenu } from '../../hooks/useContextMenu'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { AnimatedCollapse } from '../common/AnimatedCollapse'

/**
 * Widget 面板 —— Right panel 的 Widget tab 内容
 * 卡片 ≈ app 图标：点击即在独立窗口打开（未构建时窗口内呈现加载态），运行中显示绿点；
 * "停止"= 退出 app（关窗 + 反注册）。server 是懒启动的实现细节，不在此展示状态
 */
export function WidgetPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  const widgets = useWidgetStore((s) => s.widgets)
  const archived = useWidgetStore((s) => s.archived)
  const loaded = useWidgetStore((s) => s.loaded)
  const serverStatus = useWidgetStore((s) => s.serverStatus)
  const reload = useWidgetStore((s) => s.reload)
  const openWidget = useWidgetStore((s) => s.openWidget)
  const openWidgetWindow = useWidgetStore((s) => s.openWidgetWindow)
  const stopWidgetAction = useWidgetStore((s) => s.stopWidget)
  const archiveWidget = useWidgetStore((s) => s.archiveWidget)
  const deleteWidget = useWidgetStore((s) => s.deleteWidget)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [exportResult, setExportResult] = useState<
    | { kind: 'success'; name: string; zipPath: string }
    | { kind: 'error'; name: string; message: string }
    | null
  >(null)

  useEffect(() => {
    void reload()
    // AppEvent 'widget.changed'（替代旧 widget.onChanged）
    return window.api.events.subscribe((event) => {
      if (event.type === 'widget.changed') void reload()
    })
  }, [reload])

  const isEmpty = loaded && widgets.length === 0

  /** 弹保存对话框 + 执行导出，并把结果记录到本地 state 以便展示 */
  const handleExport = async (w: WidgetSummary): Promise<void> => {
    const pick = await window.api.widget.pickExportTarget({ id: w.id })
    if (!pick.success) return // 用户取消 — 静默
    const res = await window.api.widget.exportAsVite({ id: w.id, targetPath: pick.path })
    if (res.success) {
      setExportResult({ kind: 'success', name: w.name, zipPath: res.zipPath })
    } else {
      setExportResult({
        kind: 'error',
        name: w.name,
        message: errorMessageForExportCode(res.code, res.error, t)
      })
    }
  }
  // 删除目标可能在 active 或 archived 列表中，两边都搜
  const deletingWidget =
    widgets.find((w) => w.id === deletingId) ?? archived.find((w) => w.id === deletingId) ?? null
  const running = serverStatus?.running === true

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!loaded ? (
          <div className="flex items-center justify-center h-full text-[11px] text-text-tertiary/40">
            …
          </div>
        ) : isEmpty && archived.length === 0 ? (
          <div className="flex items-center justify-center h-full select-none px-6">
            <div className="text-center">
              <Wrench size={20} className="text-text-tertiary/30 mx-auto mb-2" />
              <p className="text-[11px] text-text-tertiary/60 leading-relaxed">
                {t('widgets.panelEmptyHint')}
              </p>
            </div>
          </div>
        ) : (
          <>
            {widgets.length > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2 p-3">
                {widgets.map((w) => {
                  const isRunning =
                    running && (serverStatus?.registeredIds?.includes(w.id) ?? false)
                  return (
                    <WidgetCard
                      key={w.id}
                      widget={w}
                      isRunning={isRunning}
                      onOpen={() => void openWidgetWindow(w.id)}
                      onStop={() => void stopWidgetAction(w.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        showContextMenu(
                          [
                            { id: 'openWindow', label: t('widgets.openInWindow') },
                            { id: 'openPanel', label: t('widgets.openInPanel') },
                            ...(isRunning ? [{ id: 'stop', label: t('widgets.stop') }] : []),
                            { id: 'export', label: t('widgets.exportAsVite') },
                            { id: 'archive', label: t('widgets.archive') },
                            { id: 'sep', label: '', type: 'separator' },
                            { id: 'delete', label: t('widgets.delete') }
                          ],
                          (actionId) => {
                            if (actionId === 'openWindow') void openWidgetWindow(w.id)
                            if (actionId === 'openPanel') void openWidget(w.id)
                            if (actionId === 'stop') void stopWidgetAction(w.id)
                            if (actionId === 'export') void handleExport(w)
                            if (actionId === 'archive') void archiveWidget(w.id, true)
                            if (actionId === 'delete') setDeletingId(w.id)
                          }
                        )
                      }}
                      onArchive={() => void archiveWidget(w.id, true)}
                      onRequestDelete={() => setDeletingId(w.id)}
                      t={t}
                    />
                  )
                })}
              </div>
            )}
            {archived.length > 0 && (
              <div className="border-t border-border-secondary/30 mt-1">
                <button
                  onClick={() => setArchivedOpen((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/40 transition-colors"
                >
                  <ChevronRight
                    size={11}
                    className={`flex-shrink-0 transition-transform ${archivedOpen ? 'rotate-90' : ''}`}
                  />
                  <Archive size={11} className="text-text-tertiary/60" />
                  <span className="font-medium uppercase tracking-wider">
                    {t('widgets.archivedSection')}
                  </span>
                  <span className="text-text-tertiary/50 tabular-nums">{archived.length}</span>
                </button>
                <AnimatedCollapse open={archivedOpen}>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1.5 px-3 pb-3 pt-1">
                    {archived.map((w) => (
                      <ArchivedWidgetRow
                        key={w.id}
                        widget={w}
                        onRestore={() => void archiveWidget(w.id, false)}
                        onRequestDelete={() => setDeletingId(w.id)}
                        t={t}
                      />
                    ))}
                  </div>
                </AnimatedCollapse>
              </div>
            )}
          </>
        )}
      </div>

      {deletingWidget && (
        <ConfirmDialog
          title={t('widgets.confirmDeleteTitle')}
          description={t('widgets.confirmDeleteDescription', { name: deletingWidget.name })}
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={async () => {
            await deleteWidget(deletingWidget.id)
            setDeletingId(null)
          }}
          onCancel={() => setDeletingId(null)}
        />
      )}

      {exportResult && (
        <ConfirmDialog
          title={
            exportResult.kind === 'success'
              ? t('widgets.exportSuccessTitle')
              : t('widgets.exportFailedTitle')
          }
          description={
            exportResult.kind === 'success'
              ? t('widgets.exportSuccessDescription', {
                  name: exportResult.name,
                  path: exportResult.zipPath
                })
              : t('widgets.exportFailedDescription', {
                  name: exportResult.name,
                  reason: exportResult.message
                })
          }
          confirmText={
            exportResult.kind === 'success'
              ? t('widgets.exportOpenFolder')
              : t('common.ok', { defaultValue: 'OK' })
          }
          cancelText={t('common.close', { defaultValue: 'Close' })}
          onConfirm={async () => {
            if (exportResult.kind === 'success') {
              await window.api.widget.revealExport(exportResult.zipPath)
            }
            setExportResult(null)
          }}
          onCancel={() => setExportResult(null)}
        />
      )}
    </div>
  )
}

/** 把 widget:exportAsVite 返回的 code 映射成本地化错误描述 */
function errorMessageForExportCode(
  code: string,
  fallback: string,
  t: (k: string, opts?: Record<string, unknown>) => string
): string {
  switch (code) {
    case 'TARGET_EXISTS':
      return t('widgets.exportErrorTargetExists')
    case 'WIDGET_NOT_FOUND':
      return t('widgets.exportErrorWidgetNotFound')
    case 'INVALID_PATH':
      return t('widgets.exportErrorInvalidPath')
    case 'PACK_FAILED':
      return t('widgets.exportErrorPackFailed', { reason: fallback })
    default:
      return fallback
  }
}

interface WidgetCardProps {
  widget: WidgetSummary
  isRunning: boolean
  onOpen: () => void
  onStop: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onArchive: () => void
  onRequestDelete: () => void
  t: (k: string, opts?: Record<string, unknown>) => string
}

function WidgetCard({
  widget,
  isRunning,
  onOpen,
  onStop,
  onContextMenu,
  onArchive,
  onRequestDelete,
  t
}: WidgetCardProps): React.JSX.Element {
  const last = widget.lastOpenedAt || widget.createdAt
  return (
    <div
      onClick={onOpen}
      onContextMenu={onContextMenu}
      className="group relative rounded-md border border-border-secondary/40 bg-bg-secondary/30 hover:border-border-secondary hover:bg-bg-hover/60 transition-colors p-2.5 cursor-pointer"
    >
      <div className="flex items-start gap-2">
        {/* app 图标 —— 运行中右下角亮绿点 */}
        <div className="relative flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-violet-500/10 text-violet-500">
          <Wrench size={13} />
          {isRunning && (
            <span className="absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full bg-emerald-400 border border-bg-primary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-text-primary truncate pr-14">
            {widget.name}
          </div>
          {widget.description && (
            <p className="mt-0.5 text-[11px] text-text-tertiary/80 leading-snug line-clamp-2">
              {widget.description}
            </p>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-tertiary/50 tabular-nums">
            <span className="font-mono truncate">{widget.id}</span>
            <span className="text-text-tertiary/30">·</span>
            <span className="shrink-0">{formatRelative(last, t)}</span>
          </div>
        </div>
      </div>
      {/* 悬浮操作按钮 */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
        {isRunning && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onStop()
            }}
            className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-error"
            title={t('widgets.stopWidgetTooltip')}
          >
            <Square size={10} className="fill-current" />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onArchive()
          }}
          className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-amber-400"
          title={t('widgets.archive')}
        >
          <Archive size={11} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRequestDelete()
          }}
          className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-error"
          title={t('widgets.delete')}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}

interface ArchivedWidgetRowProps {
  widget: WidgetSummary
  onRestore: () => void
  onRequestDelete: () => void
  t: (k: string, opts?: Record<string, unknown>) => string
}

function ArchivedWidgetRow({
  widget,
  onRestore,
  onRequestDelete,
  t
}: ArchivedWidgetRowProps): React.JSX.Element {
  return (
    <div className="group relative flex items-center gap-2 rounded-md border border-border-secondary/30 bg-bg-secondary/20 px-2.5 py-1.5">
      <Archive size={11} className="flex-shrink-0 text-text-tertiary/60" />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-text-secondary truncate">{widget.name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-tertiary/60 tabular-nums">
          <span className="font-mono truncate">{widget.id}</span>
          {widget.archivedAt > 0 && (
            <>
              <span className="text-text-tertiary/30">·</span>
              <span className="shrink-0">
                {t('widgets.archivedAt')} {formatRelative(widget.archivedAt, t)}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onRestore}
          className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-emerald-500"
          title={t('widgets.restore')}
        >
          <RotateCcw size={11} />
        </button>
        <button
          onClick={onRequestDelete}
          className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-error"
          title={t('widgets.delete')}
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  )
}

/** 相对时间 —— 返回短文本 */
function formatRelative(
  ts: number,
  t: (k: string, opts?: Record<string, unknown>) => string
): string {
  if (!ts) return t('widgets.never')
  const diff = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return t('widgets.justNow')
  if (diff < hour) return t('widgets.minutesAgo', { count: Math.floor(diff / minute) })
  if (diff < day) return t('widgets.hoursAgo', { count: Math.floor(diff / hour) })
  if (diff < 7 * day) return t('widgets.daysAgo', { count: Math.floor(diff / day) })
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
