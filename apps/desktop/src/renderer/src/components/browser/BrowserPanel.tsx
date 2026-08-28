import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { useBrowserStore, type BrowserTabInfo } from '../../stores/browserStore'
import { BrowserCard, type BrowserCardProps } from './BrowserCard'
import { CARD_MIN_H, CARD_TARGET_H, cardZoomFor } from './tabUtils'

/** 卡片挂上真页面后隔多久抓一张快照（滚动时顶替用） */
const SNAPSHOT_DELAY = 700

/**
 * Browser 侧边面板 —— 纵向卡片墙
 *
 * 每个 tab 是一张自带迷你工具条的卡片；页面本体是主进程的 WebContentsView，叠在本组件
 * 给出的 placeholder 矩形上方。本组件把**布局表**（tabId → 矩形 + 页面缩放）同步给主进程，
 * 表里有谁谁就显示，主进程不需要知道任何布局规则。
 * tab 状态（url/title/isLoading/loadError）是主进程真源的镜像（useBrowserTabsBridge）。
 *
 * 三条硬约束都源自「原生 view 画在 DOM 之上、不跟着 DOM 滚、也不能被裁剪」：
 * - 卡片高度按面板高度**整除**，配合 scroll-snap，停下时永远是整数张卡片铺满；
 * - 只有**完整落在滚动视口内**的卡片才挂真页面，露出一半的那张换成 DOM 快照图；
 * - 页面缩放按卡片宽度算，让小卡片显示缩略全景（对 agent 透明，CDP 坐标是 CSS px）。
 */
export function BrowserPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const width = useBrowserStore((s) => s.width)
  const isOpen = useBrowserStore((s) => s.isOpen)
  const activeTab = useBrowserStore((s) => s.activeTab)
  const tabs = useBrowserStore((s) => s.tabs)
  const activeTabId = useBrowserStore((s) => s.activeTabId)
  const createTab = useBrowserStore((s) => s.createTab)
  const closeTab = useBrowserStore((s) => s.closeTab)
  const activateTab = useBrowserStore((s) => s.activateTab)
  const navigateTab = useBrowserStore((s) => s.navigateTab)

  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // ====== 状态 ======
  const [contentHeight, setContentHeight] = useState(0)
  /** 当前挂着真页面的 tab（其余卡片显示快照/占位） */
  const [liveIds, setLiveIds] = useState<string[]>([])
  /** 当前卡片宽度对应的页面缩放（整数百分比，各卡片同宽故只存一份） */
  const [zoomPercent, setZoomPercent] = useState(100)
  /** tabId → 最近一次抓到的画面 dataURL */
  const [snapshots, setSnapshots] = useState<Record<string, string>>({})

  // 检测是否有对话框覆盖层打开（WebContentsView 在原生层渲染，需要手动让位）
  const [hasDialogOverlay, setHasDialogOverlay] = useState(false)
  useEffect(() => {
    const check = (): void => {
      setHasDialogOverlay(document.querySelector('.dialog-overlay') !== null)
    }
    const mo = new MutationObserver(check)
    mo.observe(document.body, { childList: true, subtree: true })
    check()
    return () => mo.disconnect()
  }, [])

  /** 同屏卡片数：面板高度 ÷ 目标高度，自动取整（用户不用选） */
  const slotCount = Math.max(
    1,
    Math.min(tabs.length || 1, Math.round(contentHeight / CARD_TARGET_H) || 1)
  )
  /**
   * 每张卡片的槽位高度：向下取整让 slotCount 张一定塞得进视口（scroll-snap 才对得齐），
   * 再压上「不超过面板一半」的上限 —— 只有一张 tab 时也不让它铺满整列，
   * 高度与两张纵列时一致。CARD_MIN_H 优先级最高，面板太矮时宁可放不下也不摊成纸片。
   */
  const slotH = Math.max(
    CARD_MIN_H,
    Math.min(Math.floor(contentHeight / slotCount), Math.floor(contentHeight / 2))
  )
  /** 实际能完整露出几张（状态栏「同屏 x/y」的 x） */
  const shownCount = Math.min(tabs.length, Math.max(1, Math.floor(contentHeight / slotH)))

  // ====== 布局同步 ======

  /** 各卡片的页面区（空白页 / 错误页的卡片不注册，它们永远不挂真页面） */
  const cardEls = useRef(new Map<string, HTMLDivElement>())
  const rafRef = useRef(0)

  /** 面板级门：面板关着 / 不在浏览器页签 / 有对话框覆盖层时，所有 view 一起让位 */
  const panelActive = isOpen && activeTab === 'browser' && !hasDialogOverlay

  const syncLayout = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const api = window.api.browserView
      if (!panelActive) {
        api.setVisible(false)
        return
      }
      const clip = scrollRef.current?.getBoundingClientRect()
      const entries: Array<{
        tabId: string
        bounds: { x: number; y: number; width: number; height: number }
        zoom: number
      }> = []
      let cardWidth = 0
      for (const [tabId, el] of cardEls.current) {
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        cardWidth = rect.width
        // 原生 view 不能被裁剪：露出一半的卡片不挂真页面，交给快照图
        if (clip && (rect.top < clip.top - 0.5 || rect.bottom > clip.bottom + 0.5)) continue
        entries.push({
          tabId,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          zoom: cardZoomFor(rect.width)
        })
      }
      api.setLayout(entries)
      api.setVisible(true)

      const ids = entries.map((e) => e.tabId)
      setLiveIds((prev) => (prev.join('|') === ids.join('|') ? prev : ids))
      if (cardWidth > 0) {
        const pct = Math.round(cardZoomFor(cardWidth) * 100)
        setZoomPercent((prev) => (prev === pct ? prev : pct))
      }
    })
  }, [panelActive])

  const registerCard = useCallback((tabId: string, el: HTMLDivElement | null): void => {
    if (el) cardEls.current.set(tabId, el)
    else cardEls.current.delete(tabId)
  }, [])

  /** 卡片集合 / 各卡片是否要显示页面（空白、错误都不显示）变化时都要重排 */
  const layoutKey = tabs
    .map((tab) => `${tab.id}:${tab.loadError ? 'e' : ''}${tab.url === 'about:blank' ? 'b' : ''}`)
    .join('|')

  useEffect(() => {
    syncLayout()
  }, [layoutKey, slotH, width, syncLayout])

  // 内容区尺寸变化（拖拽面板 / 窗口 resize）
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setContentHeight(Math.round(entry.contentRect.height))
      syncLayout()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncLayout])

  // 窗口 resize 时同步（捕捉 x 位置变化，尺寸不变时 ResizeObserver 不触发）
  useEffect(() => {
    window.addEventListener('resize', syncLayout)
    return () => window.removeEventListener('resize', syncLayout)
  }, [syncLayout])

  // 挂上真页面 + 静置一会儿后抓快照，供滚动时顶替（loading 结束也重抓一张）
  const liveKey = liveIds.join('|')
  const loadingKey = tabs.map((tab) => (tab.isLoading ? '1' : '0')).join('')
  useEffect(() => {
    if (liveIds.length === 0) return
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        for (const id of liveIds) {
          const data = await window.api.browserView.capture(id)
          if (cancelled || !data) continue
          setSnapshots((prev) => ({ ...prev, [id]: data }))
        }
      })()
    }, SNAPSHOT_DELAY)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [liveIds, liveKey, loadingKey, slotH])

  // ====== 操作 ======

  /** 关 tab 时连它的快照一起丢掉 */
  const handleCloseTab = useCallback(
    (tabId: string) => {
      closeTab(tabId)
      setSnapshots((prev) =>
        tabId in prev
          ? Object.fromEntries(Object.entries(prev).filter(([id]) => id !== tabId))
          : prev
      )
    },
    [closeTab]
  )

  const cardProps = (tab: BrowserTabInfo): BrowserCardProps => ({
    tab,
    isActive: tab.id === activeTabId,
    live: liveIds.includes(tab.id),
    zoomPercent,
    snapshot: snapshots[tab.id],
    onActivate: () => activateTab(tab.id),
    onClose: () => handleCloseTab(tab.id),
    onNavigate: (target: string) => navigateTab(tab.id, target),
    onOpenExternal: () => {
      if (tab.url && tab.url !== 'about:blank') window.open(tab.url, '_blank')
    },
    registerPlaceholder: (el: HTMLDivElement | null) => registerCard(tab.id, el)
  })

  const anyLoading = tabs.some((tab) => tab.isLoading)

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      {/* ====== 面板级工具栏（导航等都在各卡片自己身上） ====== */}
      <div className="titlebar-drag flex-shrink-0 flex items-center gap-1 px-1.5 min-h-8 border-b border-border-secondary/30">
        <div className="titlebar-no-drag flex items-center flex-shrink-0">
          <button
            onClick={() => createTab()}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
            title={t('browser.newTab')}
          >
            <Plus size={12} />
          </button>
        </div>
        {tabs.length > 0 && (
          <span className="flex-1 min-w-0 truncate text-[10px] text-text-tertiary opacity-60">
            {t('browser.gridCount', { shown: shownCount, total: tabs.length })}
          </span>
        )}
      </div>

      {/* ====== 卡片墙 ====== */}
      <div ref={contentRef} className="flex-1 min-h-0 relative">
        {tabs.length === 0 ? (
          <div className="flex items-center justify-center h-full select-none">
            <p className="text-xs text-text-tertiary/40">{t('panel.urlPlaceholder')}</p>
          </div>
        ) : (
          /* 整列可滚，scroll-snap 保证停下时是整数张卡片铺满 */
          <div
            ref={scrollRef}
            onScroll={syncLayout}
            className="h-full overflow-y-auto snap-y snap-mandatory wall-scrollbar"
          >
            {tabs.map((tab) => (
              <div key={tab.id} style={{ height: slotH }} className="snap-start px-1 pb-1">
                <BrowserCard {...cardProps(tab)} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ====== 底部状态栏 ====== */}
      <div className="flex-shrink-0 flex items-center justify-end gap-1.5 px-2.5 h-6 border-t border-border-secondary/30 bg-bg-secondary/40 text-[10px] text-text-tertiary select-none">
        {anyLoading && (
          <span className="h-1 w-1 rounded-full flex-shrink-0 bg-accent animate-pulse" />
        )}
        <span className="tabular-nums opacity-60">
          {contentHeight} x {width}
        </span>
      </div>
    </div>
  )
}
