import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench } from 'lucide-react'
import { WidgetIcon } from './WidgetIcon'
import {
  CELL_HEIGHT,
  DOTS_HEIGHT,
  HOME_PAD_TOP,
  HOME_PAD_X,
  ICON_SIZE,
  homeGrid,
  moveItem,
  paginate,
  slotAt
} from './homeLayout'

/** 横向拖动超过这么多才算翻页手势（以下仍是点击） */
const SWIPE_SLOP = 8
/** 松手时拖过一页宽度的这个比例，或速度够快，就翻页 */
const SWIPE_RATIO = 0.18
const SWIPE_VELOCITY = 0.45
/** 长按进入「整理图标」 */
const LONG_PRESS_MS = 450
/** 整理时拖着图标停在左右边缘多久翻页 */
const EDGE_FLIP_MS = 550
const EDGE_ZONE = 22
/** 触控板 / 滚轮累计多少算一次翻页，翻完锁多久 */
const WHEEL_THRESHOLD = 50
const WHEEL_LOCK_MS = 420
/** 翻页的动效（与打开应用同一条曲线） */
export const IOS_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
const PAGE_MS = 380

interface IconDrag {
  id: string
  pointerId: number
  /** 指针相对主屏左上角 */
  x: number
  y: number
  /** 指针按下点相对图标格左上角 */
  offsetX: number
  offsetY: number
}

/**
 * Widget 面板的主屏 —— 像手机主屏一样分页的图标网格，不滚动。
 *
 * - 网格按面板尺寸排（`homeGrid`），放不下的进下一页；底部页码点，可点。
 * - 翻页：横向拖动（鼠标 / 触摸，首尾页有回弹）、触控板 / 滚轮、点页码点。
 * - 点图标 → `onLaunch(id, 图标元素)`；右键 → `onContextMenu`。
 * - 「整理图标」（长按图标，或菜单项 → `editing`）：图标抖动，拖动重排、拖到左右边缘停一下翻页，
 *   松手即 `onReorder(新顺序)`；「完成」、Esc 或点空白处退出。
 * - `revealId`：切到这个图标所在的页（无动效）—— 应用关回主屏前，先让它的图标露出来好缩回去。
 */
export function WidgetHome({
  widgets,
  runningIds,
  editing,
  onEditingChange,
  onLaunch,
  onContextMenu,
  onReorder,
  revealId
}: {
  widgets: WidgetSummary[]
  runningIds: ReadonlySet<string>
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onLaunch: (id: string, iconEl: HTMLElement | null) => void
  onContextMenu: (e: React.MouseEvent, widget: WidgetSummary) => void
  onReorder: (ids: string[]) => void
  revealId: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  /**
   * 主屏根元素进 state：空态（没有 widget）时它不在，第一批 widget 来了才挂上 —— 量尺寸、挂 ResizeObserver 必须
   * 跟着这个元素走，只在组件挂载那一刻量一次的话，空面板里来了 widget 网格就永远是 0×0（3 列 × 1 行）
   */
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el
    setRootEl(el)
  }, [])
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [page, setPage] = useState(0)
  const [dragX, setDragX] = useState(0)
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null)
  const [iconDrag, setIconDrag] = useState<IconDrag | null>(null)

  useLayoutEffect(() => {
    if (!rootEl) return undefined
    const measure = (): void => setSize({ width: rootEl.clientWidth, height: rootEl.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(rootEl)
    return () => ro.disconnect()
  }, [rootEl])

  const grid = homeGrid(size.width, size.height)
  const byId = useMemo(() => new Map(widgets.map((w) => [w.id, w])), [widgets])
  const ids = useMemo(
    () => (liveOrder ?? widgets.map((w) => w.id)).filter((id) => byId.has(id)),
    [liveOrder, widgets, byId]
  )
  const pages = paginate(ids, grid.perPage)
  const current = Math.min(page, pages.length - 1)
  const cellWidth = size.width > 0 ? (size.width - HOME_PAD_X * 2) / grid.cols : 0

  // 切到 revealId 所在的页（渲染期按新 prop 调整 state，而不是 effect 里 setState）。revealId 在场期间
  // 翻页不走动效 —— 调用方紧接着要量图标的位置，平移到一半量出来的是错的
  const [revealedFor, setRevealedFor] = useState<string | null>(null)
  if (revealId !== revealedFor) {
    setRevealedFor(revealId)
    const index = revealId ? ids.indexOf(revealId) : -1
    if (index >= 0) setPage(Math.floor(index / grid.perPage))
  }
  const instant = revealId !== null

  // 整理状态里 Esc 退出
  useEffect(() => {
    if (!editing) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 拖到一半按 Esc：拖动一并作废（不落新顺序）
      setIconDrag(null)
      setLiveOrder(null)
      onEditingChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, onEditingChange])

  const goToPage = (next: number): void => setPage(Math.max(0, Math.min(pages.length - 1, next)))

  // ── 翻页手势（指针） ──
  const swipe = useRef<{
    pointerId: number
    startX: number
    startY: number
    startT: number
    moved: boolean
  } | null>(null)
  /**
   * 刚拖过一次 / 刚长按进了整理：吃掉松手后的那下 click —— 别把翻页当成点图标，也别把长按、拖图标的松手
   * 当成「点空白处退出整理」（指针被主屏捕获后，松手的 click 落在主屏根上）
   */
  const suppressClick = useRef(false)
  const swallowNextClick = (): void => {
    suppressClick.current = true
    setTimeout(() => (suppressClick.current = false), 0)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || iconDrag) return
    swipe.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startT: e.timeStamp,
      moved: false
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (iconDrag) {
      moveIconDrag(e)
      return
    }
    const s = swipe.current
    if (!s || s.pointerId !== e.pointerId) return
    const dx = e.clientX - s.startX
    const dy = e.clientY - s.startY
    if (!s.moved) {
      if (Math.abs(dx) < SWIPE_SLOP || Math.abs(dx) < Math.abs(dy)) return
      s.moved = true
      cancelLongPress()
      try {
        rootRef.current?.setPointerCapture(e.pointerId)
      } catch {
        // 指针已经不在了：照样按拖动处理，松手时收尾
      }
    }
    const atEdge = (current === 0 && dx > 0) || (current === pages.length - 1 && dx < 0)
    setDragX(atEdge ? dx * 0.35 : dx)
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    cancelLongPress()
    if (iconDrag) {
      endIconDrag()
      swallowNextClick()
      return
    }
    const s = swipe.current
    swipe.current = null
    if (!s || s.pointerId !== e.pointerId || !s.moved) return
    const dx = e.clientX - s.startX
    const velocity = dx / Math.max(1, e.timeStamp - s.startT)
    const width = size.width || 1
    if (dx < -width * SWIPE_RATIO || velocity < -SWIPE_VELOCITY) goToPage(current + 1)
    else if (dx > width * SWIPE_RATIO || velocity > SWIPE_VELOCITY) goToPage(current - 1)
    setDragX(0)
    swallowNextClick()
  }

  // ── 触控板 / 滚轮翻页 ──
  const wheel = useRef({ acc: 0, lockUntil: 0, idle: 0 as ReturnType<typeof setTimeout> | 0 })
  const onWheel = (e: React.WheelEvent): void => {
    const w = wheel.current
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (w.idle) clearTimeout(w.idle)
    w.idle = setTimeout(() => (w.acc = 0), 180)
    if (e.timeStamp < w.lockUntil) return
    w.acc += delta
    if (Math.abs(w.acc) < WHEEL_THRESHOLD) return
    goToPage(current + (w.acc > 0 ? 1 : -1))
    w.acc = 0
    w.lockUntil = e.timeStamp + WHEEL_LOCK_MS
  }

  // ── 长按进入整理 + 拖动重排 ──
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelLongPress = (): void => {
    if (longPress.current) clearTimeout(longPress.current)
    longPress.current = null
  }

  const beginIconDrag = (
    e: { pointerId: number; clientX: number; clientY: number },
    id: string,
    cell: HTMLElement
  ): void => {
    const root = rootRef.current
    if (!root) return
    const rootRect = root.getBoundingClientRect()
    const cellRect = cell.getBoundingClientRect()
    try {
      root.setPointerCapture(e.pointerId)
    } catch {
      return // 长按到点时指针已经松开了
    }
    swipe.current = null
    setLiveOrder(ids)
    setIconDrag({
      id,
      pointerId: e.pointerId,
      x: e.clientX - rootRect.left,
      y: e.clientY - rootRect.top,
      offsetX: e.clientX - cellRect.left,
      offsetY: e.clientY - cellRect.top
    })
  }

  const onIconPointerDown = (e: React.PointerEvent, id: string): void => {
    if (e.button !== 0) return
    const cell = e.currentTarget as HTMLElement
    const point = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY }
    if (editing) {
      e.stopPropagation()
      beginIconDrag(point, id, cell)
      return
    }
    cancelLongPress()
    longPress.current = setTimeout(() => {
      longPress.current = null
      if (swipe.current?.moved) return
      onEditingChange(true)
      beginIconDrag(point, id, cell)
    }, LONG_PRESS_MS)
  }

  const edgeTimer = useRef<{ dir: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const clearEdge = (): void => {
    if (edgeTimer.current) clearTimeout(edgeTimer.current.timer)
    edgeTimer.current = null
  }

  const moveIconDrag = (e: React.PointerEvent): void => {
    const root = rootRef.current
    if (!iconDrag || !root || e.pointerId !== iconDrag.pointerId) return
    const rect = root.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    setIconDrag({ ...iconDrag, x, y })

    // 停在左右边缘：过一会儿翻页
    const dir = x < EDGE_ZONE ? -1 : x > rect.width - EDGE_ZONE ? 1 : 0
    if (dir === 0) clearEdge()
    else if (!edgeTimer.current || edgeTimer.current.dir !== dir) {
      clearEdge()
      edgeTimer.current = {
        dir,
        timer: setTimeout(() => {
          edgeTimer.current = null
          setPage((p) => Math.max(0, Math.min(pages.length - 1, p + dir)))
        }, EDGE_FLIP_MS)
      }
    }

    // 指针下面是这一页的第几格 → 把拖着的那个挪过去（其余图标随之让位）
    const order = liveOrder ?? ids
    const from = order.indexOf(iconDrag.id)
    if (from < 0 || cellWidth <= 0) return
    const pageStart = current * grid.perPage
    const onPage = Math.max(0, Math.min(grid.perPage, order.length - pageStart))
    const slot = slotAt(x - HOME_PAD_X, y - HOME_PAD_TOP, grid, cellWidth, onPage)
    const to = Math.min(pageStart + slot, order.length - 1)
    if (to !== from) setLiveOrder(moveItem(order, from, to))
  }

  const endIconDrag = (): void => {
    clearEdge()
    const order = liveOrder
    setIconDrag(null)
    setLiveOrder(null)
    if (order && order.join('\n') !== widgets.map((w) => w.id).join('\n')) onReorder(order)
  }

  if (widgets.length === 0) {
    return (
      <div className="flex items-center justify-center h-full select-none px-6">
        <div className="text-center">
          <Wrench size={20} className="text-text-tertiary/30 mx-auto mb-2" />
          <p className="text-[11px] text-text-tertiary/60 leading-relaxed">
            {t('widgets.panelEmptyHint')}
          </p>
        </div>
      </div>
    )
  }

  const dragging = iconDrag ? byId.get(iconDrag.id) : undefined
  const animate = !instant && dragX === 0
  const pageWidthPct = 100 / pages.length

  return (
    <div
      ref={attachRoot}
      data-widget-home=""
      data-editing={editing ? '' : undefined}
      className="relative h-full overflow-hidden select-none touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onClick={(e) => {
        // 整理状态里点空白处退出
        if (editing && !suppressClick.current && e.target === e.currentTarget)
          onEditingChange(false)
      }}
    >
      {/* 页轨道：每页一格宽，按当前页平移；拖动时跟手 */}
      <div
        className="absolute inset-x-0 top-0 flex"
        style={{
          bottom: DOTS_HEIGHT,
          width: `${pages.length * 100}%`,
          transform: `translateX(calc(${-current * pageWidthPct}% + ${dragX}px))`,
          transition: animate ? `transform ${PAGE_MS}ms ${IOS_EASING}` : 'none'
        }}
        onClick={(e) => {
          if (editing && !suppressClick.current && e.target === e.currentTarget)
            onEditingChange(false)
        }}
      >
        {pages.map((pageIds, pageIndex) => (
          <div
            key={pageIndex}
            data-home-page={pageIndex}
            className="h-full grid content-start"
            style={{
              width: `${pageWidthPct}%`,
              gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
              gridAutoRows: CELL_HEIGHT,
              padding: `${HOME_PAD_TOP}px ${HOME_PAD_X}px 0`
            }}
            onClick={(e) => {
              if (editing && !suppressClick.current && e.target === e.currentTarget)
                onEditingChange(false)
            }}
          >
            {pageIds.map((id, i) => {
              const w = byId.get(id)!
              const hidden = iconDrag?.id === id
              return (
                <button
                  key={id}
                  type="button"
                  data-home-slot={id}
                  title={w.description || w.name}
                  className="flex flex-col items-center gap-2 pt-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  style={{ opacity: hidden ? 0 : 1 }}
                  onPointerDown={(e) => onIconPointerDown(e, id)}
                  onClick={(e) => {
                    if (suppressClick.current || editing) return
                    const icon = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(
                      '[data-widget-icon]'
                    )
                    onLaunch(id, icon)
                  }}
                  onContextMenu={(e) => {
                    cancelLongPress()
                    onContextMenu(e, w)
                  }}
                >
                  <span
                    className="relative"
                    style={
                      editing
                        ? {
                            animation: `widget-jiggle 260ms ease-in-out infinite`,
                            animationDelay: `${-((i * 97) % 260)}ms`
                          }
                        : undefined
                    }
                  >
                    <WidgetIcon widget={w} size={ICON_SIZE} />
                    {runningIds.has(id) && (
                      <span
                        data-running=""
                        className="absolute left-1/2 -bottom-[5px] -ml-[2px] w-1 h-1 rounded-full bg-text-tertiary"
                      />
                    )}
                  </span>
                  <span className="w-full px-0.5 truncate text-center text-[11px] leading-tight text-text-secondary">
                    {w.name}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* 页码点 */}
      {pages.length > 1 && (
        <div
          className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5"
          style={{ height: DOTS_HEIGHT }}
        >
          {pages.map((_, i) => (
            <button
              key={i}
              type="button"
              data-home-dot={i}
              aria-label={t('widgets.homePage', { page: i + 1, total: pages.length })}
              aria-current={i === current ? 'page' : undefined}
              onClick={() => goToPage(i)}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === current
                  ? 'bg-text-secondary'
                  : 'bg-text-tertiary/35 hover:bg-text-tertiary/60'
              }`}
            />
          ))}
        </div>
      )}

      {/* 整理状态的「完成」 */}
      {editing && (
        <button
          type="button"
          data-home-done=""
          onClick={() => onEditingChange(false)}
          className="absolute top-1.5 right-2 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-bg-tertiary text-text-primary hover:bg-bg-hover"
        >
          {t('widgets.arrangeDone')}
        </button>
      )}

      {/* 拖着走的那个图标 */}
      {iconDrag && dragging && (
        <div
          className="absolute pointer-events-none flex flex-col items-center gap-2 pt-1"
          style={{
            left: iconDrag.x - iconDrag.offsetX,
            top: iconDrag.y - iconDrag.offsetY,
            width: cellWidth,
            transform: 'scale(1.12)',
            zIndex: 10
          }}
        >
          <WidgetIcon widget={dragging} size={ICON_SIZE} />
          <span className="w-full px-0.5 truncate text-center text-[11px] leading-tight text-text-secondary">
            {dragging.name}
          </span>
        </div>
      )}
    </div>
  )
}
