import { useCallback } from 'react'
import { startPanelDrag } from '@shuvix/app-shell'
import { useBrowserStore } from '../../stores/browserStore'

const MIN_W = 320
const MAX_W = 960

/**
 * 右侧面板左侧的拖拽分隔条（名字是历史遗留：浏览器曾是右侧面板的第一个页签）
 * 作为独立 flex 子元素放在 ChatView 和 RightPanel 之间。往右拖时指针会进到面板里的小组件 iframe 上，
 * 拖动手势因此交给 startPanelDrag（整窗遮罩，iframe 吞不走 mousemove / mouseup）
 */
export function BrowserResizeHandle(): React.JSX.Element {
  const width = useBrowserStore((s) => s.width)
  const setWidth = useBrowserStore((s) => s.setWidth)
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const startW = width
      // 往左拖（delta < 0）变宽
      startPanelDrag(e, {
        axis: 'x',
        onMove: (delta) => setWidth(Math.max(MIN_W, Math.min(MAX_W, startW - delta)))
      })
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
