import { useCallback, useRef } from 'react'
import { useSidebarStore, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../../stores/sidebarStore'

/**
 * 侧边栏右侧的拖拽分隔条
 * 与 PreviewResizeHandle 对称，拖拽方向为正向（向右变宽）
 */
export function SidebarResizeHandle(): React.JSX.Element {
  const width = useSidebarStore((s) => s.width)
  const setWidth = useSidebarStore((s) => s.setWidth)
  const setResizing = useSidebarStore((s) => s.setResizing)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: width }
      setResizing(true)
      document.querySelectorAll('iframe').forEach((f) => {
        ;(f as HTMLIFrameElement).style.pointerEvents = 'none'
      })
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent): void => {
        if (!dragRef.current) return
        const delta = ev.clientX - dragRef.current.startX
        const newW = Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, dragRef.current.startW + delta)
        )
        setWidth(newW)
      }
      const onUp = (): void => {
        dragRef.current = null
        setResizing(false)
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
    [width, setWidth, setResizing]
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
