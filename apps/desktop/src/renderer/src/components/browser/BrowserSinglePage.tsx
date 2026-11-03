import { useCallback, useEffect, useRef } from 'react'
import { internalPageOfTab, selectedTab, useBrowserTabsStore } from '../../stores/browserTabsStore'
import { NewTabPage, PageErrorView } from './PageFaces'
import { BrowserSettingsPage } from './BrowserSettingsPage'
import { BrowserHistoryPage } from './BrowserHistoryPage'
import { useDialogOverlay } from './useDialogOverlay'
import type { SearchEngineId } from './omnibox'

/**
 * 单页视图（缺省，Chrome 的样子）：页面区只显示选中的那一页，铺满。
 *
 * 布局表里永远只有选中的那一项（或者一项都没有）—— 其余 tab 一律住在停放窗口里，照常可见、照常被 agent
 * 操作（见 stagingWindow.ts），所以「view 永不 setVisible(false)」那些约束在这里一条都不用多管。
 * 缩放不给：主进程按用户在那个站点上调的缩放显示（⌘+ / ⌘−，Chrome 的按站点缩放）。
 * 空白页与错误页不进布局表，位置让给 DOM（新标签页 / 错误页）。
 */
export function BrowserSinglePage({ engine }: { engine: SearchEngineId }): React.JSX.Element {
  const tab = useBrowserTabsStore(selectedTab)
  const navigateTab = useBrowserTabsStore((s) => s.navigateTab)
  const requestOmniboxFocus = useBrowserTabsStore((s) => s.requestOmniboxFocus)
  // 对话框开着：原生页面让位（它会盖住对话框、吃掉鼠标）
  const overlay = useDialogOverlay()
  const pageRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef(0)
  /** 主进程手上已经是什么（布局的 key / 可见性）；一样就不再发，见 syncLayoutNow */
  const sentRef = useRef<{ layout: string | null; visible: boolean | null }>({
    layout: null,
    visible: null
  })

  const internal = tab ? internalPageOfTab(tab) : null
  const isBlank = !tab || !tab.url || tab.url === 'about:blank'
  const showsPage = !!tab && !isBlank && !internal && !tab.loadError
  const tabId = tab?.id ?? null

  const syncLayoutNow = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    const api = window.api.browserView
    const sent = sentRef.current
    if (overlay) {
      if (sent.visible !== false) api.setVisible(false)
      sent.visible = false
      return
    }
    const el = pageRef.current
    const rect = el?.getBoundingClientRect()
    if (!tabId || !showsPage || !rect || rect.width <= 0 || rect.height <= 0) {
      if (sent.layout !== '') api.setLayout([])
      sent.layout = ''
    } else {
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      // 矩形贴着窗口边缘，主进程按「到边缘的距离」摆（layoutAnchors.ts）：距离没变就不用报 —— 拖窗口边框的时候
      // 一条 IPC 都不发，那段时间排版和 IPC 都在跟页面抢帧
      const key = JSON.stringify([
        tabId,
        bounds.x,
        bounds.y,
        viewport.width - bounds.x - bounds.width,
        viewport.height - bounds.y - bounds.height,
        window.devicePixelRatio
      ])
      if (sent.layout !== key) api.setLayout([{ tabId, bounds, viewport }])
      sent.layout = key
    }
    if (sent.visible !== true) api.setVisible(true)
    sent.visible = true
  }, [overlay, tabId, showsPage])

  const syncLayout = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(syncLayoutNow)
  }, [syncLayoutNow])

  useEffect(() => {
    syncLayout()
  }, [syncLayout])

  // 页面区尺寸变化（窗口缩放、提示条出现 / 消失把页面区往下推、拖停靠区）：当场报 —— 布局刚算完、还没画，
  // 原生 view 与 DOM 尽量落在同一帧；隔一帧再报，拖停靠区时页面与停靠区之间会错开一帧闪一下
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => syncLayoutNow())
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncLayoutNow, showsPage])

  // 窗口移动时尺寸没变、ResizeObserver 不触发，但 view 的矩形要跟着走
  useEffect(() => {
    window.addEventListener('resize', syncLayout)
    return () => window.removeEventListener('resize', syncLayout)
  }, [syncLayout])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  return (
    <div className="relative h-full min-h-0 bg-bg-primary" data-browser-single>
      {!tab ? (
        <NewTabPage
          engine={engine}
          onNavigate={(url) => useBrowserTabsStore.getState().createTab(url)}
          onFocusOmnibox={requestOmniboxFocus}
        />
      ) : internal === 'settings' ? (
        <BrowserSettingsPage />
      ) : internal === 'history' ? (
        <BrowserHistoryPage tabId={tab.id} />
      ) : isBlank ? (
        <NewTabPage
          engine={engine}
          onNavigate={(url) => navigateTab(tab.id, url)}
          onFocusOmnibox={requestOmniboxFocus}
        />
      ) : tab.loadError ? (
        <PageErrorView tab={tab} onRetry={(url) => navigateTab(tab.id, url)} />
      ) : (
        /* WebContentsView 占位区域 —— 选中那页的 view 叠放在此 div 上方 */
        <div ref={pageRef} className="absolute inset-0" data-page-area data-browser-page={tab.id} />
      )}
    </div>
  )
}
