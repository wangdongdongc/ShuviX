/**
 * 扩展右侧面板 —— store 已抽到共享 usePanelStore（@shuvix/app-shell），各组件直接用它。
 * 本文件只剩扩展专属的「持久化接线 + 边界/类型常量」：chrome.storage 启动水合 + 变化回存。
 *
 * 扩展只用 files + subagent 两个 tab（terminal 无 pty、browser 无 WebContentsView、widget 暂不搬）。
 */
import { usePanelStore } from '@shuvix/app-shell'

export type PanelTab = 'files' | 'subagent'

export const PANEL_MIN_WIDTH = 220
export const PANEL_MAX_WIDTH = 520
const DEFAULT_WIDTH = 300
const KEY = 'rightPanelLayout'

/** 从 chrome.storage 载入（首屏渲染前调用）+ 订阅共享 store 变化回存 */
export async function initPanel(): Promise<void> {
  let saved: { isOpen?: boolean; width?: number; activeTab?: PanelTab } | undefined
  try {
    const obj = await chrome.storage.local.get(KEY)
    saved = obj[KEY]
  } catch {
    /* 用默认 */
  }
  usePanelStore.setState({
    isOpen: saved?.isOpen ?? false,
    width: saved?.width ?? DEFAULT_WIDTH,
    activeTab: saved?.activeTab ?? 'files'
  })
  usePanelStore.subscribe((s) => {
    void chrome.storage.local
      .set({ [KEY]: { isOpen: s.isOpen, width: s.width, activeTab: s.activeTab } })
      .catch(() => {})
  })
}
