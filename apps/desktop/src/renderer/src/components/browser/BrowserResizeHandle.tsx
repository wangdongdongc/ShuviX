import { useCallback, useRef } from 'react'
import { useBrowserStore } from '../../stores/browserStore'

const MIN_W = 320
const MAX_W = 960

/**
 * 右侧面板左侧的拖拽分隔条（名字是历史遗留：浏览器曾是右侧面板的第一个页签）
 * 作为独立 flex 子元素放在 ChatView 和 RightPanel 之间，不受 iframe 事件干扰
 */
export function BrowserResizeHandle(): React.JSX.Element {
  const width = useBrowserStore((s) => s.width)
  const setWidth = useBrowserStore((s) => s.setWidth)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startW: width }
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
      className="flex-shrink-0 w-px bg-border-secondary/50 cursor-col-resize relative group z-10"
      onMouseDown={onMouseDown}
    >
      {/* 透明宽击中区域：只往面板一侧扩 6px。左侧紧贴着对话列的滚动条（4px），往左扩就把它整条盖住、
          鼠标永远落在拖拽上（会话面板的拖拽条同理只放在卡片内侧，见 app-shell SessionPanel 的 ResizeHandle） */}
      <div className="absolute inset-y-0 left-0 -right-[6px]" />
      {/* 可见高亮仅 1px 宽 */}
      <div className="absolute inset-y-0 left-0 w-px group-hover:bg-accent/40 group-active:bg-accent/60 transition-colors" />
    </div>
  )
}
