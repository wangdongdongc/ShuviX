import { useCallback, useEffect, useRef } from 'react'
import { selectedTab, useBrowserTabsStore } from '../../stores/browserTabsStore'
import { NewTabPage, PageErrorView } from './PageFaces'
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
  const overlay = useDialogOverlay()
  const pageRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef(0)

  const isBlank = !tab || !tab.url || tab.url === 'about:blank'
  const showsPage = !!tab && !isBlank && !tab.loadError
  const tabId = tab?.id ?? null

  const syncLayout = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const api = window.api.browserView
      if (overlay) {
        api.setVisible(false)
        return
      }
      const el = pageRef.current
      const rect = el?.getBoundingClientRect()
      if (!tabId || !showsPage || !rect || rect.width <= 0 || rect.height <= 0) {
        api.setLayout([])
      } else {
        api.setLayout([
          {
            tabId,
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          }
        ])
      }
      api.setVisible(true)
    })
  }, [overlay, tabId, showsPage])

  useEffect(() => {
    syncLayout()
  }, [syncLayout])

  // 页面区尺寸变化（窗口缩放、提示条出现 / 消失把页面区往下推）
  useEffect(() => {
    const el = pageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => syncLayout())
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncLayout, showsPage])

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
        />
      ) : isBlank ? (
        <NewTabPage engine={engine} onNavigate={(url) => navigateTab(tab.id, url)} />
      ) : tab.loadError ? (
        <PageErrorView tab={tab} onRetry={(url) => navigateTab(tab.id, url)} />
      ) : (
        /* WebContentsView 占位区域 —— 选中那页的 view 叠放在此 div 上方 */
        <div ref={pageRef} className="absolute inset-0" data-page-area data-browser-page={tab.id} />
      )}
    </div>
  )
}
