import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../stores/browserTabsStore'
import { BrowserCard, type BrowserCardProps } from './BrowserCard'
import { CARD_MIN_H, CARD_TARGET_H, CARD_TARGET_W, MAX_COLS, cardZoomFor } from './tabUtils'

/** 卡片挂上真页面后隔多久抓一张快照（滚动时顶替用） */
const SNAPSHOT_DELAY = 700

/**
 * 浏览器窗口的网格卡片墙
 *
 * 每个 tab 是一张自带迷你工具条的卡片；页面本体是主进程的 WebContentsView，叠在本组件
 * 给出的 placeholder 矩形上方。本组件把**布局表**（tabId → 矩形 + 页面缩放）同步给主进程，
 * 表里有谁谁就显示，主进程不需要知道任何布局规则。
 *
 * 三条硬约束都源自「原生 view 画在 DOM 之上、不跟着 DOM 滚、也不能被裁剪」——
 * 与窗口形态无关，搬进独立窗口后一条都没少：
 * - 行高按墙高**整除**，配合 scroll-snap，停下时永远是整数行卡片铺满；
 * - 只有**完整落在滚动视口内**的卡片才挂真页面，露出一半的那张换成 DOM 快照图；
 * - 页面缩放按卡片宽度算（窗口里卡片通常够宽，cardZoomFor 自然回到 1）。
 *
 * 列数/行数由窗口尺寸自动算：一个 tab 就铺满整窗，多了才分格。
 */
export function BrowserWall(): React.JSX.Element {
  const { t } = useTranslation()
  const tabs = useBrowserTabsStore((s) => s.tabs)
  const activeTabId = useBrowserTabsStore((s) => s.activeTabId)
  const createTab = useBrowserTabsStore((s) => s.createTab)
  const closeTab = useBrowserTabsStore((s) => s.closeTab)
  const activateTab = useBrowserTabsStore((s) => s.activateTab)
  const navigateTab = useBrowserTabsStore((s) => s.navigateTab)

  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const [size, setSize] = useState({ width: 0, height: 0 })
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

  // ====== 网格几何 ======

  const count = tabs.length || 1
  /** 列数：窗口宽度能放几张，但不超过 tab 数与上限 */
  const cols = Math.max(1, Math.min(count, MAX_COLS, Math.round(size.width / CARD_TARGET_W) || 1))
  /** 同屏行数：窗口高度能放几行，但不超过「这些 tab 一共要几行」—— 只有一个 tab 就铺满整窗 */
  const rows = Math.max(
    1,
    Math.min(Math.ceil(count / cols), Math.round(size.height / CARD_TARGET_H) || 1)
  )
  /** 行高：向下取整让 rows 行一定塞得进视口（scroll-snap 才对得齐） */
  const slotH = Math.max(CARD_MIN_H, Math.floor(size.height / rows))
  /** 实际能完整露出几张（状态栏「同屏 x/y」的 x） */
  const shownCount = Math.min(tabs.length, cols * Math.max(1, Math.floor(size.height / slotH)))

  // ====== 布局同步 ======

  /** 各卡片的页面区（空白页 / 错误页的卡片不注册，它们永远不挂真页面） */
  const cardEls = useRef(new Map<string, HTMLDivElement>())
  const rafRef = useRef(0)

  /** 墙级门：有对话框覆盖层时所有 view 一起让位（窗口自身不可见时 Chromium 本就不合成） */
  const wallActive = !hasDialogOverlay

  const syncLayout = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const api = window.api.browserView
      if (!wallActive) {
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
  }, [wallActive])

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
  }, [layoutKey, slotH, cols, syncLayout])

  // 内容区尺寸变化（窗口 resize）
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height)
      })
      syncLayout()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncLayout])

  // 激活 tab 变了（agent 刚开的新 tab、agent 转去操作另一张、用户点了一张）：把它那一格滚进
  // 视口。新 tab 追加在墙尾，不滚的话 agent 刚打开的页面常常落在看不见的地方。
  // block: 'nearest' —— 已经完整可见就不动，免得 agent 在同屏几张之间来回时整墙乱跳。
  useEffect(() => {
    if (!activeTabId) return
    const cell = scrollRef.current?.querySelector(`[data-wall-cell="${activeTabId}"]`)
    cell?.scrollIntoView({ block: 'nearest' })
  }, [activeTabId, cols, slotH])

  // 窗口移动时同步（位置变了尺寸没变，ResizeObserver 不触发，但 view 的屏幕矩形要跟着走）
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
    <div className="flex flex-col h-full min-h-0 bg-bg-primary overflow-hidden">
      <div ref={contentRef} className="flex-1 min-h-0 relative">
        {tabs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 h-full select-none">
            <p className="text-xs text-text-tertiary/50">{t('panel.urlPlaceholder')}</p>
            <button
              onClick={() => createTab()}
              className="px-3 py-1.5 rounded-md text-xs text-text-secondary border border-border-secondary/60 hover:bg-bg-hover/50 transition-colors"
            >
              {t('browser.newTab')}
            </button>
          </div>
        ) : (
          /* 整墙可滚，scroll-snap 保证停下时是整数行卡片铺满 */
          <div
            ref={scrollRef}
            onScroll={syncLayout}
            className="h-full overflow-y-auto snap-y snap-mandatory wall-scrollbar grid"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {tabs.map((tab) => (
              <div
                key={tab.id}
                data-wall-cell={tab.id}
                style={{ height: slotH }}
                className="snap-start p-1 min-w-0"
              >
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
        {tabs.length > 0 && (
          <span className="opacity-60">
            {t('browser.gridCount', { shown: shownCount, total: tabs.length })}
          </span>
        )}
        <span className="tabular-nums opacity-60">
          {size.width} x {size.height}
        </span>
      </div>
    </div>
  )
}
