import { useSessionPanelStore } from '@shuvix/app-shell'
import { persistPanelLayout } from './panelLayout'

/**
 * 会话面板 store 的桌面接线 —— 真源在共享 @shuvix/app-shell useSessionPanelStore
 * （状态/钳制宿主无关），本文件只负责桌面专属的宽度持久化：变化回写 panelLayout
 * （启动恢复在 useAppInit）。消费端统一从本文件导入，保证本模块（含订阅）被加载。
 */
export { useSessionPanelStore } from '@shuvix/app-shell'
export type { SessionPanelTool } from '@shuvix/app-shell'

let lastWidth = useSessionPanelStore.getState().width
useSessionPanelStore.subscribe((s) => {
  if (s.width === lastWidth) return
  lastWidth = s.width
  persistPanelLayout({ sessionPanelWidth: s.width })
})
