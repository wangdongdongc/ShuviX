import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, RotateCw, AppWindow } from 'lucide-react'
import { useWidgetStore } from '../../stores/widgetStore'
import { useContextMenu } from '@shuvix/app-shell'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { isWebHost } from '../../host/hostMedia'
import { downloadServerFile } from '../../host/serverDownload'
import { WidgetHome, IOS_EASING } from '../widget/WidgetHome'
import { WidgetFrame } from '../widget/WidgetFrame'
import { WidgetIcon } from '../widget/WidgetIcon'
import { ICON_SIZE } from '../widget/homeLayout'

/** 打开 / 关回主屏的动效时长 */
const OPEN_MS = 460
const CLOSE_MS = 400
/** 主屏在应用打开时缩到多小 */
const HOME_SCALE = 0.9

/** 一次进行中的打开 / 关回动效 */
interface Transition {
  kind: 'open' | 'close'
  id: string
}

/** 图标在面板里的位置（相对面板左上角） */
interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Widget 面板 —— Right panel 的 Widget tab：一块像手机主屏的面板。
 *
 * - 主屏（WidgetHome）：分页的图标网格；点图标在面板里打开应用（占满面板），右键菜单里有两种打开方式与
 *   停止 / 整理图标 / 导出 / 归档 / 删除。已归档的小组件在设置 → 已归档里。
 * - 应用：顶栏左边返回（回主屏）和名字，右边重新加载和「在独立窗口打开」。回主屏不关应用：它留在后台、
 *   状态还在，下次点图标直接回到它（不限个数，「停止」才真的退出）。
 * - 打开与关回仿手机主屏：应用从图标的位置展开成整块面板（图标的样子先铺满、再淡出露出应用），主屏同时
 *   缩小淡出；关回时反过来缩回图标。
 * - 一个小组件同一时间只开在一处：开着独立窗口的、或上次选了独立窗口的，点图标直接开 / 聚焦那个窗口；
 *   用户在这里选的打开方式记在主进程（widgetWindow:setPreferWindow），窗口的位置大小由窗口自己记。
 */
export interface WidgetPanelProps {
  /**
   * 点图标总在新页面打开、从不嵌在面板里（web 客户端的手机布局：手机上没有「面板」可言，小组件要整页）。
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
  const setHomeOrder = useWidgetStore((s) => s.setHomeOrder)
  const stopWidget = useWidgetStore((s) => s.stopWidget)
  const archiveWidget = useWidgetStore((s) => s.archiveWidget)
  const deleteWidget = useWidgetStore((s) => s.deleteWidget)

  const rootRef = useRef<HTMLDivElement>(null)
  const homeRef = useRef<HTMLDivElement>(null)
  const appRefs = useRef(new Map<string, HTMLDivElement>())
  const [editing, setEditing] = useState(false)
  const [transition, setTransition] = useState<Transition | null>(null)
  const pendingOpen = useRef<{ id: string; from: Box | null } | null>(null)
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

  /** 图标元素在面板里的位置；元素不在（翻到别的页、已删）→ 面板中央一个图标大小的方块 */
  const boxOf = useCallback((el: Element | null): Box => {
    const root = rootRef.current
    const rootRect = root?.getBoundingClientRect()
    if (!root || !rootRect) return { left: 0, top: 0, width: ICON_SIZE, height: ICON_SIZE }
    const rect = el?.getBoundingClientRect()
    if (!rect || rect.width === 0) {
      return {
        left: rootRect.width / 2 - ICON_SIZE / 2,
        top: rootRect.height / 2 - ICON_SIZE / 2,
        width: ICON_SIZE,
        height: ICON_SIZE
      }
    }
    return {
      left: rect.left - rootRect.left,
      top: rect.top - rootRect.top,
      width: rect.width,
      height: rect.height
    }
  }, [])

  /** 整块面板裁到某个方块（图标）的 clip-path */
  const clipTo = useCallback((box: Box): string => {
    const root = rootRef.current
    const w = root?.clientWidth ?? 0
    const h = root?.clientHeight ?? 0
    const right = Math.max(0, w - box.left - box.width)
    const bottom = Math.max(0, h - box.top - box.height)
    const radius = Math.round(box.width * 0.23)
    return `inset(${box.top}px ${right}px ${bottom}px ${box.left}px round ${radius}px)`
  }, [])

  /**
   * 闪屏（图标的样子）的 transform：`box` = 图标那一格时它就是图标本身大小、在图标的位置；`cover` = 整块面板时
   * 它等比放大到盖住面板（取长边）、居中。图标瓦片是 ICON_SIZE 见方、origin 在左上角，所以放大用 scale、
   * 平移把中心对上。与应用的 clip-path 同一条曲线插值，看上去就是图标在长大 / 缩回
   */
  const splashAt = useCallback((box: Box | 'cover'): string => {
    const root = rootRef.current
    const w = root?.clientWidth ?? 0
    const h = root?.clientHeight ?? 0
    const size = box === 'cover' ? Math.max(w, h) : box.width
    const cx = box === 'cover' ? w / 2 : box.left + box.width / 2
    const cy = box === 'cover' ? h / 2 : box.top + box.height / 2
    return `translate(${cx - size / 2}px, ${cy - size / 2}px) scale(${size / ICON_SIZE})`
  }, [])

  // ── 打开：先把应用挂上（不可见），下一帧从图标的位置展开 ──
  const launchInPanel = useCallback(
    (id: string, iconEl: HTMLElement | null): void => {
      if (transition) return
      pendingOpen.current = { id, from: iconEl ? boxOf(iconEl) : null }
      setTransition({ kind: 'open', id })
      openInPanel(id)
    },
    [transition, boxOf, openInPanel]
  )

  useLayoutEffect(() => {
    const pending = pendingOpen.current
    if (!pending || transition?.kind !== 'open' || transition.id !== pending.id) return
    const layer = appRefs.current.get(pending.id)
    if (!layer) return
    pendingOpen.current = null
    const from = pending.from ?? boxOf(null)
    const opts: KeyframeAnimationOptions = { duration: OPEN_MS, easing: IOS_EASING, fill: 'both' }
    const grow = layer.animate(
      [{ clipPath: clipTo(from) }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }],
      opts
    )
    const splash = layer.querySelector<HTMLElement>('[data-app-splash]')
    splash?.animate(
      [
        { transform: splashAt(from), opacity: 1, offset: 0 },
        { opacity: 1, offset: 0.32 },
        { opacity: 0, offset: 0.78 },
        { transform: splashAt('cover'), opacity: 0, offset: 1 }
      ],
      opts
    )
    const origin = `${from.left + from.width / 2}px ${from.top + from.height / 2}px`
    homeRef.current?.animate(
      [
        { transform: 'scale(1)', opacity: 1, transformOrigin: origin },
        { transform: `scale(${HOME_SCALE})`, opacity: 0, transformOrigin: origin }
      ],
      opts
    )
    void grow.finished
      .catch(() => undefined)
      .then(() => {
        grow.cancel()
        splash?.getAnimations().forEach((a) => a.cancel())
        homeRef.current?.getAnimations().forEach((a) => a.cancel())
        setTransition(null)
      })
  }, [transition, boxOf, clipTo, splashAt])

  // ── 关回主屏：先让图标所在的页露出来，下一帧量位置、缩回图标 ──
  const [revealId, setRevealId] = useState<string | null>(null)
  const closeToHome = useCallback((): void => {
    if (!foregroundApp || transition) return
    setRevealId(foregroundApp)
    setTransition({ kind: 'close', id: foregroundApp })
  }, [foregroundApp, transition])

  useEffect(() => {
    if (transition?.kind !== 'close') return undefined
    const id = transition.id
    const layer = appRefs.current.get(id)
    // 等主屏切好页（revealId 的 layoutEffect）再量
    const raf = requestAnimationFrame(() => {
      const icon = homeRef.current?.querySelector(`[data-home-slot="${id}"] [data-widget-icon]`)
      const to = boxOf(icon ?? null)
      if (!layer) {
        goHome()
        setTransition(null)
        return
      }
      const opts: KeyframeAnimationOptions = {
        duration: CLOSE_MS,
        easing: IOS_EASING,
        fill: 'both'
      }
      const shrink = layer.animate(
        [{ clipPath: 'inset(0px 0px 0px 0px round 0px)' }, { clipPath: clipTo(to) }],
        opts
      )
      layer.querySelector<HTMLElement>('[data-app-splash]')?.animate(
        [
          { transform: splashAt('cover'), opacity: 0, offset: 0 },
          { opacity: 0, offset: 0.2 },
          { opacity: 1, offset: 0.6 },
          { transform: splashAt(to), opacity: 1, offset: 1 }
        ],
        opts
      )
      const origin = `${to.left + to.width / 2}px ${to.top + to.height / 2}px`
      homeRef.current?.animate(
        [
          { transform: `scale(${HOME_SCALE})`, opacity: 0, transformOrigin: origin },
          { transform: 'scale(1)', opacity: 1, transformOrigin: origin }
        ],
        opts
      )
      void shrink.finished
        .catch(() => undefined)
        .then(() => {
          goHome()
          setTransition(null)
          setRevealId(null)
          // 动效留下的 fill 收掉：应用在后台时按 visibility 藏着，回到前台时得是整块
          requestAnimationFrame(() => {
            layer.getAnimations({ subtree: true }).forEach((a) => a.cancel())
            homeRef.current?.getAnimations().forEach((a) => a.cancel())
          })
        })
    })
    return () => cancelAnimationFrame(raf)
  }, [transition, boxOf, clipTo, splashAt, goHome])

  // ── 点图标 / 菜单 ──
  const handleLaunch = useCallback(
    (id: string, iconEl: HTMLElement | null): void => {
      if (launchInNewPage || launchTarget(id) === 'window') {
        // 开着的窗口 / 上次选的窗口：开或聚焦它，不改偏好（agent 开的窗口不算用户的选择）。
        // 手机布局：总是新页面（web 客户端的「窗口」就是一个新标签页）
        void focusWindow(id)
        return
      }
      launchInPanel(id, iconEl)
    },
    [launchInNewPage, launchTarget, focusWindow, launchInPanel]
  )

  const iconElOf = (id: string): HTMLElement | null =>
    homeRef.current?.querySelector<HTMLElement>(`[data-home-slot="${id}"] [data-widget-icon]`) ??
    null

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
        { id: 'arrange', label: t('widgets.arrange') },
        { id: 'export', label: t('widgets.exportAsVite') },
        { id: 'archive', label: t('widgets.archive') },
        { id: 'sep2', label: '', type: 'separator' as const },
        { id: 'delete', label: t('widgets.delete') }
      ],
      (actionId) => {
        if (actionId === 'openPanel') {
          void chooseOpenInPanel(w.id).then(() => launchInPanel(w.id, iconElOf(w.id)))
        }
        if (actionId === 'openWindow') void openInWindow(w.id)
        if (actionId === 'stop') void stopWidget(w.id)
        if (actionId === 'arrange') setEditing(true)
        if (actionId === 'export') void handleExport(w)
        if (actionId === 'archive') void archiveWidget(w.id, true)
        if (actionId === 'delete') setDeletingId(w.id)
      }
    )
  }

  const deletingWidget = widgets.find((w) => w.id === deletingId) ?? null
  const homeVisible = foregroundApp === null || transition !== null

  return (
    <div
      ref={rootRef}
      data-widget-panel=""
      className="relative h-full bg-bg-primary overflow-hidden"
      style={transition ? { pointerEvents: 'none' } : undefined}
    >
      {/* 主屏 */}
      <div
        ref={homeRef}
        className="absolute inset-0"
        style={homeVisible ? undefined : { visibility: 'hidden' }}
      >
        {!loaded ? (
          <div className="flex items-center justify-center h-full text-[11px] text-text-tertiary/40">
            …
          </div>
        ) : (
          <WidgetHome
            widgets={widgets}
            runningIds={runningIds}
            editing={editing}
            onEditingChange={setEditing}
            onLaunch={handleLaunch}
            onContextMenu={handleContextMenu}
            onReorder={(ids) => void setHomeOrder(ids)}
            revealId={revealId}
            longPressToArrange={!launchInNewPage}
          />
        )}
      </div>

      {/* 面板里开着的应用：都挂着（状态留着），只有前台那个可见 */}
      {panelApps.map((id) => {
        const w = byId.get(id)
        if (!w) return null
        const visible = foregroundApp === id || transition?.id === id
        return (
          <div
            key={id}
            ref={(el) => {
              if (el) appRefs.current.set(id, el)
              else appRefs.current.delete(id)
            }}
            data-panel-app={id}
            data-foreground={foregroundApp === id ? '' : undefined}
            className="absolute inset-0 flex flex-col bg-bg-primary"
            style={visible ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
          >
            <div className="flex-shrink-0 flex items-center gap-1 h-9 pl-1 pr-1.5 border-b border-border-secondary/40">
              <button
                type="button"
                data-app-back=""
                onClick={closeToHome}
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
            {/* 打开 / 关回时随应用一起长大 / 缩回的图标（平时透明；位置与大小全由动效给，见 splashAt） */}
            <div
              data-app-splash=""
              aria-hidden="true"
              className="absolute left-0 top-0 pointer-events-none"
              style={{ width: ICON_SIZE, height: ICON_SIZE, opacity: 0, transformOrigin: '0 0' }}
            >
              <WidgetIcon widget={w} size={ICON_SIZE} />
            </div>
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
