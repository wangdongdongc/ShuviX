import { useCallback, useEffect, useRef, useState } from 'react'
import { useBrowserTabsStore, type BrowserTabInfo } from '../../stores/browserTabsStore'
import { BrowserCard, type BrowserCardProps } from './BrowserCard'
import { NewTabPage } from './PageFaces'
import { useDialogOverlay } from './useDialogOverlay'
import type { SearchEngineId } from './omnibox'
import { CARD_MIN_H, CARD_TARGET_H, CARD_TARGET_W, MAX_COLS, cardZoomFor } from './tabUtils'

/** 卡片挂上真页面后隔多久抓一张快照（滚动时顶替用） */
const SNAPSHOT_DELAY = 700

/**
 * 浏览器窗口的第二种视图：平铺墙（同时看几页 —— 看几个 agent 各自在干什么）。缺省是单页视图
 * （BrowserSinglePage），用户在工具条上切换（2026-10-16 用户裁定：墙留作第二种视图）。
 *
 * 每个 tab 是一张卡片（卡片头 + 页面）；后退 / 前进 / 地址栏在窗口顶上，作用于选中的那张。页面本体是
 * 主进程的 WebContentsView，叠在本组件给出的 placeholder 矩形上方。本组件把**布局表**（tabId → 矩形 +
 * 页面缩放）同步给主进程，表里有谁谁就显示，主进程不需要知道任何布局规则。
 *
 * 三条硬约束都源自「原生 view 画在 DOM 之上、不跟着 DOM 滚、也不能被裁剪」——
 * 与窗口形态无关，搬进独立窗口后一条都没少：
 * - 行高按墙高**整除**，配合 scroll-snap，停下时永远是整数行卡片铺满；
 * - 只有**完整落在滚动视口内**的卡片才挂真页面，露出一半的那张换成 DOM 快照图；
 * - 页面缩放按卡片宽度算（窗口里卡片通常够宽，cardZoomFor 自然回到 1）。
 *
 * 列数/行数由窗口尺寸自动算：一个 tab 就铺满整窗，多了才分格。
 */
export function BrowserWall({ engine }: { engine: SearchEngineId }): React.JSX.Element {
  const tabs = useBrowserTabsStore((s) => s.tabs)
  const activeTabId = useBrowserTabsStore((s) => s.activeTabId)
  const createTab = useBrowserTabsStore((s) => s.createTab)
  const closeTab = useBrowserTabsStore((s) => s.closeTab)
  const activateTab = useBrowserTabsStore((s) => s.activateTab)
  const navigateTab = useBrowserTabsStore((s) => s.navigateTab)
  const hasDialogOverlay = useDialogOverlay()

  const contentRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const [size, setSize] = useState({ width: 0, height: 0 })
  /** 当前挂着真页面的 tab（其余卡片显示快照/占位） */
  const [liveIds, setLiveIds] = useState<string[]>([])
  /** tabId → 最近一次抓到的画面 dataURL */
  const [snapshots, setSnapshots] = useState<Record<string, string>>({})

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
      for (const [tabId, el] of cardEls.current) {
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
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

  // 选中的 tab 变了（用户点了一张、按了 ⌘1–9 / Ctrl+Tab、新开了一张）：把它那一格滚进视口。
  // 新 tab 追加在墙尾，不滚的话刚开的那页常常落在看不见的地方。agent 的动作不改选中，所以墙不会跟着
  // agent 跳。block: 'nearest' —— 已经完整可见就不动。
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
    snapshot: snapshots[tab.id],
    onActivate: () => activateTab(tab.id),
    onClose: () => handleCloseTab(tab.id),
    onNavigate: (target: string) => navigateTab(tab.id, target),
    registerPlaceholder: (el: HTMLDivElement | null) => registerCard(tab.id, el)
  })

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-primary overflow-hidden" data-browser-wall>
      <div ref={contentRef} className="flex-1 min-h-0 relative">
        {tabs.length === 0 ? (
          <NewTabPage engine={engine} onNavigate={(url) => createTab(url)} />
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
    </div>
  )
}
