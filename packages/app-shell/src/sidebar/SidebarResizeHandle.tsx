import { useCallback, useRef } from 'react'

/**
 * SidebarResizeHandle —— 侧栏右侧拖拽分隔条（桌面/扩展共用）。
 *
 * 纯 prop 驱动：宽度与持久化由宿主拥有（桌面 sidebarStore，扩展 chrome.storage），
 * 本组件只负责拖拽手势与命中区域。拖拽方向为正向（向右变宽）。
 */
export interface SidebarResizeHandleProps {
  /** 当前宽度（px），作为拖拽起点 */
  width: number
  /** 最小宽度（px） */
  min: number
  /** 最大宽度（px） */
  max: number
  /** 拖拽中持续回调（已 clamp 到 [min,max]） */
  onResize: (width: number) => void
  /** 拖拽开始（宿主可据此暂停过渡动画 / 屏蔽 iframe 命中） */
  onResizeStart?: () => void
  /** 拖拽结束 */
  onResizeEnd?: () => void
  /** 反向：手柄在面板左侧（如右侧面板），向左拖变宽。默认 false（手柄在右侧，向右变宽）。 */
  invert?: boolean
}

export function SidebarResizeHandle({
  width,
  min,
  max,
  onResize,
  onResizeStart,
  onResizeEnd,
  invert = false
}: SidebarResizeHandleProps): React.JSX.Element {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: width }
      onResizeStart?.()
      // 拖拽中屏蔽 iframe 命中（嵌入的浏览器/预览面板会吞掉 mousemove）
      document.querySelectorAll('iframe').forEach((f) => {
        ;(f as HTMLIFrameElement).style.pointerEvents = 'none'
      })
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent): void => {
        if (!dragRef.current) return
        const delta = ev.clientX - dragRef.current.startX
        // invert：手柄在面板左侧，向左拖(delta<0)应变宽 → 取反
        const newW = Math.max(
          min,
          Math.min(max, dragRef.current.startW + (invert ? -delta : delta))
        )
        onResize(newW)
      }
      const onUp = (): void => {
        dragRef.current = null
        onResizeEnd?.()
        document.querySelectorAll('iframe').forEach((f) => {
          ;(f as HTMLIFrameElement).style.pointerEvents = ''
        })
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [width, min, max, onResize, onResizeStart, onResizeEnd, invert]
  )

  return (
    <div
      className="flex-shrink-0 w-px bg-border-secondary/50 cursor-col-resize relative group z-10"
      onMouseDown={onMouseDown}
    >
      {/* 透明宽击中区域（左右各扩展 5px） */}
      <div className="absolute inset-y-0 -left-[5px] -right-[5px]" />
      {/* 可见高亮仅 1px 宽 */}
      <div className="absolute inset-y-0 left-0 w-px group-hover:bg-accent/40 group-active:bg-accent/60 transition-colors" />
    </div>
  )
}
