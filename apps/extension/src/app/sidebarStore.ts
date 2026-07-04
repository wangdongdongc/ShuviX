/**
 * 扩展侧栏 —— store 已抽到共享 useSidebarStore（@shuvix/app-shell），各组件直接用它。
 * 本文件只剩扩展专属的「持久化接线 + 边界常量」：chrome.storage 启动水合 + 变化回存。
 *
 * 宽度供共享 SidebarResizeHandle 拖拽，展开供 ChatHeader 折叠按钮。Side Panel 较窄，折叠会话列表可让满宽。
 */
import { useSidebarStore } from '@shuvix/app-shell'

export const SIDEBAR_MIN_WIDTH = 160
export const SIDEBAR_MAX_WIDTH = 360
const DEFAULT_WIDTH = 220
const KEY = 'sidebarLayout'

/** 从 chrome.storage 载入（首屏渲染前调用）+ 订阅共享 store 变化回存 */
export async function initSidebar(): Promise<void> {
  let saved: { isOpen?: boolean; width?: number } | undefined
  try {
    const obj = await chrome.storage.local.get(KEY)
    saved = obj[KEY]
  } catch {
    /* 用默认 */
  }
  useSidebarStore.setState({
    isOpen: saved?.isOpen ?? true,
    width: saved?.width ?? DEFAULT_WIDTH
  })
  useSidebarStore.subscribe((s) => {
    void chrome.storage.local.set({ [KEY]: { isOpen: s.isOpen, width: s.width } }).catch(() => {})
  })
}
