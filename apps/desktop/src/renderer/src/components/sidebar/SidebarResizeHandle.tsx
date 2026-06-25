import { SidebarResizeHandle as SharedSidebarResizeHandle } from '@shuvix/app-shell'
import { useSidebarStore, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../../stores/sidebarStore'

/**
 * 侧边栏右侧拖拽分隔条 —— 复用共享 SidebarResizeHandle，仅把桌面 sidebarStore 接上。
 * 宽度持久化（panelLayout）与过渡动画暂停（isResizing）由 store 负责。
 */
export function SidebarResizeHandle(): React.JSX.Element {
  const width = useSidebarStore((s) => s.width)
  const setWidth = useSidebarStore((s) => s.setWidth)
  const setResizing = useSidebarStore((s) => s.setResizing)

  return (
    <SharedSidebarResizeHandle
      width={width}
      min={SIDEBAR_MIN_WIDTH}
      max={SIDEBAR_MAX_WIDTH}
      onResize={setWidth}
      onResizeStart={() => setResizing(true)}
      onResizeEnd={() => setResizing(false)}
    />
  )
}
