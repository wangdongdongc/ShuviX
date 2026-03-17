import { useCallback, useRef } from 'react'
import { usePreviewStore } from '../../stores/previewStore'

const MIN_W = 320
const MAX_W = 960

/**
 * 预览面板左侧的拖拽分隔条
 * 作为独立 flex 子元素放在 ChatView 和 PreviewPanel 之间，不受 iframe 事件干扰
 */
export function PreviewResizeHandle(): React.JSX.Element {
  const width = usePreviewStore((s) => s.width)
  const setWidth = usePreviewStore((s) => s.setWidth)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: width }
      // 禁用所有 iframe 的 pointer-events，防止拖拽时 iframe 捕获鼠标
      document.querySelectorAll('iframe').forEach((f) => {
        ;(f as HTMLIFrameElement).style.pointerEvents = 'none'
      })
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent): void => {
        if (!dragRef.current) return
        const delta = dragRef.current.startX - ev.clientX
        const newW = Math.max(MIN_W, Math.min(MAX_W, dragRef.current.startW + delta))
        setWidth(newW)
      }
      const onUp = (): void => {
        dragRef.current = null
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
    [width, setWidth]
  )

  return (
    <div
      className="flex-shrink-0 w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors bg-border-primary"
      onMouseDown={onMouseDown}
    />
  )
}
