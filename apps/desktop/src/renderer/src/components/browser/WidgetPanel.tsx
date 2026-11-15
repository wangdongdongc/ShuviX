import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft,
  ChevronRight,
  CircleEllipsis,
  RotateCw,
  AppWindow,
  Share,
  Wrench,
  Trash2,
  Archive,
  Square,
  Folder
} from 'lucide-react'
import { useWidgetStore } from '../../stores/widgetStore'
import { listTimeLabel, useContextMenu } from '@shuvix/app-shell'
import { PullDownMenu, type PullDownItem } from '../../mobile/PullDownMenu'
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
   * web 客户端的手机布局：点卡片就地打开（手机壳在应用开着时收起页头与标签栏，应用占满整屏，返回手势回列表 ——
   * 见 MobileShell）；应用顶栏换成手指的尺寸；菜单里没有「在面板中打开」（点一下就是）。要真开一个新标签页走菜单的
   * 「在独立窗口打开」。从前手机上点卡片总开新标签页：整个 web 客户端在那一页里从头加载一遍，每次都是整屏几闪。
   * 缺省 = 桌面的行为（面板里打开，或按记住的选择开窗口）
   */
  mobile?: boolean
}

export function WidgetPanel({ mobile = false }: WidgetPanelProps = {}): React.JSX.Element {
  const { t, i18n } = useTranslation()
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
  // 手机布局：开着的应用顶栏右边那颗「⋯」的下拉菜单（哪个应用的、贴着按钮的哪个位置）
  const [appMenu, setAppMenu] = useState<{
    id: string
    anchor: { right: number; bottom: number }
  } | null>(null)
  // 行尾时间按日历日分档。手机上这一页一直挂着：钟每分钟走一下，「刚刚」才会变旧、过了午夜才会换成「昨天」
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!mobile) return
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [mobile])
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
      if (launchTarget(id) === 'window') {
        // 开着的窗口 / 上次选的窗口：开或聚焦它，不改偏好（agent 开的窗口不算用户的选择）。
        // web 客户端（含手机布局）恒为 'panel'：页面里就地打开
        void focusWindow(id)
        return
      }
      openInPanel(id)
    },
    [launchTarget, focusWindow, openInPanel]
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
        ...(mobile ? [] : [{ id: 'openPanel', label: t('widgets.openInPanel') }]),
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

  // 那个小组件不在了（在别处被归档 / 删掉）或已经不在前台：菜单跟着收掉，不留着等它回来再冒出来
  if (appMenu && (!byId.has(appMenu.id) || foregroundApp !== appMenu.id)) setAppMenu(null)

  const deletingWidget = widgets.find((w) => w.id === deletingId) ?? null
  const bar = COMPACT_APP_BAR

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
        ) : mobile ? (
          // 手机：一张分组卡片里的行（与会话行同一副骨架：行首一列圆点，名字 + 说明，行尾时间与箭头）
          <div className="px-3 pb-6 pt-1">
            <div data-widget-rows="" className="overflow-hidden rounded-xl bg-bg-secondary">
              {widgets.map((w, index) => (
                <WidgetRow
                  key={w.id}
                  widget={w}
                  isRunning={runningIds.has(w.id)}
                  first={index === 0}
                  time={widgetTimeLabel(w.lastOpenedAt || w.createdAt, now, {
                    never: t('widgets.never'),
                    justNow: t('widgets.justNow'),
                    yesterday: t('mobile.yesterday'),
                    locale: i18n.language
                  })}
                  onOpen={() => handleLaunch(w.id)}
                  onContextMenu={(e) => handleContextMenu(e, w)}
                  t={t}
                />
              ))}
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
            {mobile ? (
              // 手机：与对话页同一副顶栏 —— 强调色的返回、居中的名字、右边一颗「⋯」（重新加载 / 新标签页 | 导出 / 停止）
              <div
                data-app-bar=""
                className="flex h-12 flex-shrink-0 items-center border-b border-border-secondary/40 px-1"
              >
                <div className="flex w-16 flex-shrink-0 items-center">
                  <button
                    type="button"
                    data-app-back=""
                    onClick={goHome}
                    className="flex h-10 items-center rounded-full pl-1.5 pr-2 text-accent active:bg-bg-hover"
                    title={t('widgets.backToHome')}
                    aria-label={t('widgets.backToHome')}
                  >
                    <ChevronLeft size={24} aria-hidden="true" />
                  </button>
                </div>
                <span
                  data-app-name=""
                  className="min-w-0 flex-1 truncate px-1 text-center text-[15px] font-medium text-text-primary"
                >
                  {w.name}
                </span>
                <div className="flex w-16 flex-shrink-0 items-center justify-end">
                  <button
                    type="button"
                    data-app-menu=""
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect()
                      setAppMenu({ id, anchor: { right: rect.right, bottom: rect.bottom } })
                    }}
                    className="flex h-10 w-10 items-center justify-center rounded-full text-accent active:bg-bg-hover"
                    aria-label={t('mobile.moreActions')}
                    aria-haspopup="menu"
                    aria-expanded={appMenu?.id === id}
                  >
                    <CircleEllipsis size={23} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ) : (
              <div className={bar.row}>
                <button
                  type="button"
                  data-app-back=""
                  onClick={goHome}
                  className={bar.back}
                  title={t('widgets.backToHome')}
                  aria-label={t('widgets.backToHome')}
                >
                  <ChevronLeft size={bar.chevron} className="flex-shrink-0" />
                  <span className={bar.name}>{w.name}</span>
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  data-app-reload=""
                  onClick={() => setReloadNonces((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }))}
                  className={bar.icon}
                  title={t('widgets.windowReload')}
                  aria-label={t('widgets.windowReload')}
                >
                  <RotateCw size={bar.reload} />
                </button>
                <button
                  type="button"
                  data-app-popout=""
                  onClick={() => void openInWindow(id)}
                  className={bar.icon}
                  title={t('widgets.openInWindow')}
                  aria-label={t('widgets.openInWindow')}
                >
                  <AppWindow size={bar.popout} />
                </button>
              </div>
            )}
            <WidgetFrame
              widgetId={id}
              title={w.name}
              reloadNonce={reloadNonces[id] ?? 0}
              className="flex-1 min-h-0"
            />
          </div>
        )
      })}

      {appMenu && byId.get(appMenu.id) && (
        <PullDownMenu
          anchor={appMenu.anchor}
          groups={[
            [
              { id: 'reload', label: t('widgets.windowReload'), icon: <RotateCw size={19} /> },
              { id: 'popout', label: t('mobile.widgetOpenTab'), icon: <AppWindow size={19} /> }
            ],
            [
              { id: 'export', label: t('mobile.widgetExport'), icon: <Share size={19} /> },
              ...(runningIds.has(appMenu.id)
                ? ([
                    {
                      id: 'stop',
                      label: t('widgets.stop'),
                      icon: <Square size={17} />
                    }
                  ] satisfies PullDownItem[])
                : [])
            ]
          ]}
          onClose={() => setAppMenu(null)}
          onPick={(action) => {
            const id = appMenu.id
            const widget = byId.get(id)
            if (action === 'reload') setReloadNonces((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }))
            if (action === 'popout') void openInWindow(id)
            if (action === 'export' && widget) void handleExport(widget)
            if (action === 'stop') void stopWidget(id)
          }}
        />
      )}

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

/** 面板里开着的应用的顶栏：桌面的紧凑档 */
const COMPACT_APP_BAR = {
  row: 'flex-shrink-0 flex items-center gap-1 h-9 pl-1 pr-1.5 border-b border-border-secondary/40',
  back: 'flex items-center gap-0.5 min-w-0 h-7 pl-0.5 pr-2 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors',
  name: 'truncate text-[12px] font-medium text-text-primary',
  icon: 'p-1.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors',
  chevron: 16,
  reload: 13,
  popout: 14
}

/**
 * 手机那一行行尾的时间：没有时间（从没打开过、widget.json 里也没有创建时间）→「从未打开」；一分钟之内 →「刚刚」；
 * 其余按列表的写法（今天时分 / 昨天 / 星期几 / 月-日）
 */
function widgetTimeLabel(
  at: number,
  now: number,
  labels: { never: string; justNow: string; yesterday: string; locale: string }
): string {
  if (!at) return labels.never
  if (now - at < 60_000) return labels.justNow
  return listTimeLabel(at, now, { yesterday: labels.yesterday, locale: labels.locale })
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

/**
 * 手机布局的一行（2026-11-15）：行首一列圆点（绿色 = 这个小组件还在后台开着），名字 + 两行说明 + 用过它的项目，
 * 行尾是上次打开的时间与箭头。长按 = 卡片的那份菜单。数据锚点沿用卡片的 `data-widget-card` / `data-running`
 */
function WidgetRow({
  widget,
  isRunning,
  first,
  time,
  onOpen,
  onContextMenu,
  t
}: {
  widget: WidgetSummary
  isRunning: boolean
  first: boolean
  time: string
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  t: (k: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element {
  return (
    <div
      data-widget-card={widget.id}
      data-widget-row=""
      data-running={isRunning ? '' : undefined}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      className="flex cursor-pointer items-stretch gap-2.5 pl-3 text-[16px] text-text-primary active:bg-bg-hover"
    >
      <span className="flex h-[44px] w-2 flex-shrink-0 items-center justify-center">
        {isRunning && (
          <span
            data-widget-running=""
            title={t('mobile.widgetRunning')}
            aria-label={t('mobile.widgetRunning')}
            className="h-2 w-2 rounded-full bg-emerald-400"
          />
        )}
      </span>
      <div
        className={`flex min-h-[44px] min-w-0 flex-1 items-start gap-2 py-2.5 pr-3 ${
          first ? '' : 'border-t border-border-secondary/50'
        }`}
      >
        <div className="min-w-0 flex-1">
          <div data-widget-name="" className="truncate">
            {widget.name}
          </div>
          {widget.description && (
            <p
              data-widget-description=""
              className="mt-0.5 line-clamp-2 text-[0.82em] leading-snug text-text-secondary"
            >
              {widget.description}
            </p>
          )}
          <ProjectTags projects={widget.projects ?? []} t={t} />
        </div>
        <span className="flex h-6 flex-shrink-0 items-center gap-1 text-text-tertiary">
          <span data-widget-time="" className="text-[0.82em] tabular-nums">
            {time}
          </span>
          <ChevronRight size={16} aria-hidden="true" />
        </span>
      </div>
    </div>
  )
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
          <ProjectTags projects={widget.projects ?? []} t={t} />
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

/** 卡片上的项目标签上限：再多的折成「+N」，全部名字在悬停提示里 */
const MAX_PROJECT_TAGS = 3

/**
 * 用过这个组件的会话所在的项目（最近的在前），只作信息展示：会话经 `widget` 工具用它时宿主记下（tools/widget.ts），
 * 名字是现在的项目名（widget:list 补的）。没有就不占地方
 */
function ProjectTags({
  projects,
  t
}: {
  projects: { id: string; name: string }[]
  t: (k: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element | null {
  if (projects.length === 0) return null
  const shown = projects.slice(0, MAX_PROJECT_TAGS)
  const more = projects.length - shown.length
  return (
    <div
      data-widget-projects=""
      title={t('widgets.usedInProjects', { names: projects.map((p) => p.name).join(', ') })}
      className="mt-1 flex flex-wrap items-center gap-1"
    >
      {shown.map((project) => (
        <span
          key={project.id}
          data-widget-project={project.id}
          className="inline-flex items-center gap-0.5 max-w-[9rem] rounded px-1 py-px text-[10px] leading-tight bg-bg-hover/70 text-text-secondary"
        >
          <Folder size={9} className="flex-shrink-0 text-text-tertiary" />
          <span className="truncate">{project.name}</span>
        </span>
      ))}
      {more > 0 && (
        <span data-widget-projects-more="" className="text-[10px] text-text-tertiary tabular-nums">
          +{more}
        </span>
      )}
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
