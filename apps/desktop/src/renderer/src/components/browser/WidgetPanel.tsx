import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, RotateCw, AppWindow, Wrench, Trash2, Archive, Square } from 'lucide-react'
import { useWidgetStore } from '../../stores/widgetStore'
import { useContextMenu } from '@shuvix/app-shell'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { isWebHost } from '../../host/hostMedia'
import { downloadServerFile } from '../../host/serverDownload'
import { WidgetFrame } from '../widget/WidgetFrame'

/**
 * Widget 面板 —— Right panel 的 Widget tab。
 *
 * - 卡片列表：每个小组件一张卡（名字、描述、id、上次打开），运行中图标右下角亮绿点；点卡片打开，右键菜单里有
 *   两种打开方式与停止 / 导出 / 归档 / 删除。已归档的小组件在设置 → 已归档里。
 * - 应用在面板里打开时占满面板：顶栏左边返回（回列表）和名字，右边重新加载和「在独立窗口打开」。回列表不关
 *   应用：它留在后台、状态还在，下次点卡片直接回到它（不限个数，「停止」才真的退出）。
 * - 一个小组件同一时间只开在一处：开着独立窗口的、或上次选了独立窗口的，点卡片直接开 / 聚焦那个窗口；
 *   用户在这里选的打开方式记在主进程（widgetWindow:setPreferWindow），窗口的位置大小由窗口自己记。
 */
export interface WidgetPanelProps {
  /**
   * 点卡片总在新页面打开、从不嵌在面板里（web 客户端的手机布局：手机上没有「面板」可言，小组件要整页）。
   * 菜单里也就没有「在面板中打开」。缺省 = 桌面的行为（面板里打开，或按记住的选择开窗口）
   */
  launchInNewPage?: boolean
}

export function WidgetPanel({ launchInNewPage = false }: WidgetPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  const widgets = useWidgetStore((s) => s.widgets)
  const loaded = useWidgetStore((s) => s.loaded)
  const serverStatus = useWidgetStore((s) => s.serverStatus)
  const panelApps = useWidgetStore((s) => s.panelApps)
  const foregroundApp = useWidgetStore((s) => s.foregroundApp)
  const reload = useWidgetStore((s) => s.reload)
  const openInPanel = useWidgetStore((s) => s.openInPanel)
  const goHome = useWidgetStore((s) => s.goHome)
  const openInWindow = useWidgetStore((s) => s.openInWindow)
  const focusWindow = useWidgetStore((s) => s.focusWindow)
  const chooseOpenInPanel = useWidgetStore((s) => s.chooseOpenInPanel)
  const launchTarget = useWidgetStore((s) => s.launchTarget)
  const stopWidget = useWidgetStore((s) => s.stopWidget)
  const archiveWidget = useWidgetStore((s) => s.archiveWidget)
  const deleteWidget = useWidgetStore((s) => s.deleteWidget)

  const [reloadNonces, setReloadNonces] = useState<Record<string, number>>({})
  const [deletingId, setDeletingId] = useState<string | null>(null)
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

  const byId = useMemo(() => new Map(widgets.map((w) => [w.id, w])), [widgets])
  const runningIds = useMemo(
    () => new Set(serverStatus?.running ? (serverStatus.registeredIds ?? []) : []),
    [serverStatus]
  )

  // ── 点卡片 / 菜单 ──
  const handleLaunch = useCallback(
    (id: string): void => {
      if (launchInNewPage || launchTarget(id) === 'window') {
        // 开着的窗口 / 上次选的窗口：开或聚焦它，不改偏好（agent 开的窗口不算用户的选择）。
        // 手机布局：总是新页面（web 客户端的「窗口」就是一个新标签页）
        void focusWindow(id)
        return
      }
      openInPanel(id)
    },
    [launchInNewPage, launchTarget, focusWindow, openInPanel]
  )

  /**
   * 弹保存对话框 + 执行导出，并把结果记录到本地 state 以便展示。
   * 浏览器里的 web 客户端（phase D）没有保存框：导出到服务端的临时目录，再下载到浏览器这边；只有失败才弹框
   */
  const handleExport = async (w: WidgetSummary): Promise<void> => {
    if (isWebHost) {
      const res = await window.api.widget.exportForDownload({ id: w.id })
      if (res.success) {
        downloadServerFile(res.zipPath)
      } else {
        setExportResult({
          kind: 'error',
          name: w.name,
          message: errorMessageForExportCode(res.code, res.error, t)
        })
      }
      return
    }
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

  const handleContextMenu = (e: React.MouseEvent, w: WidgetSummary): void => {
    const isRunning = runningIds.has(w.id)
    // 共享的菜单（ContextMenuProvider）：桌面弹原生菜单，浏览器里的 web 客户端弹 DOM 菜单
    void showContextMenu(
      e,
      [
        ...(launchInNewPage ? [] : [{ id: 'openPanel', label: t('widgets.openInPanel') }]),
        { id: 'openWindow', label: t('widgets.openInWindow') },
        ...(isRunning ? [{ id: 'stop', label: t('widgets.stop') }] : []),
        { id: 'sep1', label: '', type: 'separator' as const },
        { id: 'export', label: t('widgets.exportAsVite') },
        { id: 'archive', label: t('widgets.archive') },
        { id: 'sep2', label: '', type: 'separator' as const },
        { id: 'delete', label: t('widgets.delete') }
      ],
      (actionId) => {
        if (actionId === 'openPanel') void chooseOpenInPanel(w.id).then(() => openInPanel(w.id))
        if (actionId === 'openWindow') void openInWindow(w.id)
        if (actionId === 'stop') void stopWidget(w.id)
        if (actionId === 'export') void handleExport(w)
        if (actionId === 'archive') void archiveWidget(w.id, true)
        if (actionId === 'delete') setDeletingId(w.id)
      }
    )
  }

  const deletingWidget = widgets.find((w) => w.id === deletingId) ?? null

  return (
    <div data-widget-panel="" className="relative h-full bg-bg-primary overflow-hidden">
      {/* 卡片列表 */}
      <div
        data-widget-list=""
        className="absolute inset-0 overflow-y-auto"
        style={foregroundApp === null ? undefined : { visibility: 'hidden' }}
      >
        {!loaded ? (
          <div className="flex items-center justify-center h-full text-[11px] text-text-tertiary/40">
            …
          </div>
        ) : widgets.length === 0 ? (
          <div className="flex items-center justify-center h-full select-none px-6">
            <div className="text-center">
              <Wrench size={20} className="text-text-tertiary/30 mx-auto mb-2" />
              <p className="text-[11px] text-text-tertiary/60 leading-relaxed">
                {t('widgets.panelEmptyHint')}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2 p-3">
            {widgets.map((w) => {
              const isRunning = runningIds.has(w.id)
              return (
                <WidgetCard
                  key={w.id}
                  widget={w}
                  isRunning={isRunning}
                  onOpen={() => handleLaunch(w.id)}
                  onStop={() => void stopWidget(w.id)}
                  onContextMenu={(e) => handleContextMenu(e, w)}
                  onArchive={() => void archiveWidget(w.id, true)}
                  onRequestDelete={() => setDeletingId(w.id)}
                  t={t}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* 面板里开着的应用：都挂着（状态留着），只有前台那个可见 */}
      {panelApps.map((id) => {
        const w = byId.get(id)
        if (!w) return null
        const visible = foregroundApp === id
        return (
          <div
            key={id}
            data-panel-app={id}
            data-foreground={visible ? '' : undefined}
            className="absolute inset-0 flex flex-col bg-bg-primary"
            style={visible ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
          >
            <div className="flex-shrink-0 flex items-center gap-1 h-9 pl-1 pr-1.5 border-b border-border-secondary/40">
              <button
                type="button"
                data-app-back=""
                onClick={goHome}
                className="flex items-center gap-0.5 min-w-0 h-7 pl-0.5 pr-2 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                title={t('widgets.backToHome')}
                aria-label={t('widgets.backToHome')}
              >
                <ChevronLeft size={16} className="flex-shrink-0" />
                <span className="truncate text-[12px] font-medium text-text-primary">{w.name}</span>
              </button>
              <div className="flex-1" />
              <button
                type="button"
                data-app-reload=""
                onClick={() => setReloadNonces((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }))}
                className="p-1.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors"
                title={t('widgets.windowReload')}
                aria-label={t('widgets.windowReload')}
              >
                <RotateCw size={13} />
              </button>
              <button
                type="button"
                data-app-popout=""
                onClick={() => void openInWindow(id)}
                className="p-1.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors"
                title={t('widgets.openInWindow')}
                aria-label={t('widgets.openInWindow')}
              >
                <AppWindow size={14} />
              </button>
            </div>
            <WidgetFrame
              widgetId={id}
              title={w.name}
              reloadNonce={reloadNonces[id] ?? 0}
              className="flex-1 min-h-0"
            />
          </div>
        )
      })}

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
      data-widget-card={widget.id}
      data-running={isRunning ? '' : undefined}
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
      {/* 悬浮操作按钮。没有悬停的设备（触屏）上它们一直是透明的，也就不接点击 —— 否则点卡片右上角会误按到
          归档 / 删除；那里用长按菜单 */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-100">
        {isRunning && (
          <button
            data-card-stop=""
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
          data-card-archive=""
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
          data-card-delete=""
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
