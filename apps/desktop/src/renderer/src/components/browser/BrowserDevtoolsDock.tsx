import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { selectedTab, useBrowserTabsStore } from '../../stores/browserTabsStore'
import type { DevtoolsDockPanel } from '../../../../shared/browserAgentDevtools'
import { AgentDevtoolsPanel } from './AgentDevtoolsPanel'
import { clampDockHeight } from './dockHeight'

/**
 * 停靠区 —— 页面下方那一块（照 Chrome 停靠在底部的 DevTools），作用于**选中的那一页**，那页开着才有：
 *
 *   ┌ [DevTools] [Agent n] ──────────── ✕ ┐  页签条（上沿可拖动改高度）
 *   │ 原生 DevTools（主进程挂的原生 view） │
 *   │   或 agent 的 devtool（DOM）        │
 *   └────────────────────────────────────┘
 *
 * 「DevTools」页签只是一块占位：主进程把这一页的原生 DevTools 前端铺在它上报的矩形上（setDevtoolsLayout），
 * 与页面区同一套做法。「Agent」页签是 AgentDevtoolsPanel。开 / 关 / 换页签都只发 IPC，状态是主进程的镜像。
 */
export function BrowserDevtoolsDock({
  height,
  onHeight
}: {
  height: number
  /** 拖动中（commit=false）与松手（commit=true，记进设置） */
  onHeight: (height: number, commit: boolean) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const tab = useBrowserTabsStore(selectedTab)
  const openDevtools = useBrowserTabsStore((s) => s.openDevtools)
  const closeDevtools = useBrowserTabsStore((s) => s.closeDevtools)
  const dock = tab?.devtools
  if (!tab || !dock) return null

  const tabBtn = (panel: DevtoolsDockPanel, label: string, badge?: number): React.JSX.Element => (
    <button
      role="tab"
      aria-selected={dock.panel === panel}
      onClick={() => openDevtools(tab.id, panel)}
      className={`flex items-center gap-1.5 h-full px-3 text-[12px] border-b-2 transition-colors ${
        dock.panel === panel
          ? 'border-accent text-text-primary'
          : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover/50'
      }`}
      data-devtools-tab={panel}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="min-w-[16px] px-1 rounded-full bg-bg-hover text-[10px] leading-4 text-text-secondary tabular-nums">
          {badge}
        </span>
      )}
    </button>
  )

  return (
    <div
      className="relative flex-shrink-0 flex flex-col bg-bg-primary border-t border-border-secondary/60"
      style={{ height }}
      data-devtools-dock={tab.id}
      data-panel={dock.panel}
    >
      <DockResizeEdge height={height} onHeight={onHeight} tabId={tab.id} />
      <div
        role="tablist"
        className="flex-shrink-0 flex items-stretch h-8 pl-1 pr-1 bg-bg-secondary border-b border-border-secondary/40"
      >
        {tabBtn('devtools', t('browser.devtools.tabNative'))}
        {tabBtn('agent', t('browser.devtools.tabAgent'), tab.agentDevtoolsCalls)}
        <div className="flex-1" />
        <button
          onClick={() => closeDevtools(tab.id)}
          className="self-center p-1 rounded-md text-text-secondary hover:bg-bg-hover/70 hover:text-text-primary transition-colors"
          title={t('browser.devtools.close')}
          aria-label={t('browser.devtools.close')}
          data-devtools-close
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {dock.panel === 'devtools' ? (
          <NativeDevtoolsSlot tabId={tab.id} />
        ) : (
          <AgentDevtoolsPanel tabId={tab.id} />
        )}
      </div>
    </div>
  )
}

/**
 * 原生 DevTools 的占位：把自己的矩形报给主进程（窗口缩放、停靠区改高度时跟着报），卸载时报 null。
 * 原生 view 什么时候让位（对话框、站点信息气泡、拖停靠区）由主进程那道可见性门统一管，这里不用操心。
 */
function NativeDevtoolsSlot({ tabId }: { tabId: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef(0)

  const report = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const rect = ref.current?.getBoundingClientRect()
      const api = window.api.browserView
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        api.setDevtoolsLayout(null)
        return
      }
      api.setDevtoolsLayout({
        tabId,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      })
    })
  }, [tabId])

  useEffect(() => {
    report()
    const el = ref.current
    const ro = el ? new ResizeObserver(() => report()) : null
    if (el) ro?.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', report)
      cancelAnimationFrame(rafRef.current)
      window.api.browserView.setDevtoolsLayout(null)
    }
  }, [report])

  return <div ref={ref} className="h-full w-full" data-devtools-native={tabId} />
}

/**
 * 停靠区的上沿：拖动改高度。拖动期间原生 view 全部让位（store.dockResizing），页面区换成截图 ——
 * 它们画在 DOM 之上，鼠标一拖过页面，外壳就收不到 mousemove 了。
 */
function DockResizeEdge({
  height,
  onHeight,
  tabId
}: {
  height: number
  onHeight: (height: number, commit: boolean) => void
  tabId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const store = useBrowserTabsStore.getState()
    const startY = e.clientY
    const startH = height
    let last = startH
    store.setDockResizing(true)
    // 页面区先空着，截图到了再顶上（与站点信息气泡同一个做法）
    store.setPageCover({ tabId, snapshot: '' })
    void window.api.browserView
      .capture(tabId, Math.max(480, window.innerWidth))
      .catch(() => '')
      .then((snapshot) => {
        const s = useBrowserTabsStore.getState()
        if (s.dockResizing && s.pageCover?.tabId === tabId) s.setPageCover({ tabId, snapshot })
      })
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent): void => {
      last = clampDockHeight(startH + (startY - ev.clientY), window.innerHeight)
      onHeight(last, false)
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const s = useBrowserTabsStore.getState()
      s.setDockResizing(false)
      s.setPageCover(null)
      onHeight(last, true)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className="absolute -top-[3px] inset-x-0 h-[6px] z-10 cursor-row-resize group"
      onMouseDown={onMouseDown}
      title={t('browser.devtools.resize')}
      data-devtools-resize
    >
      <div className="absolute inset-x-0 top-[3px] h-px group-hover:bg-accent/40 group-active:bg-accent/60 transition-colors" />
    </div>
  )
}
