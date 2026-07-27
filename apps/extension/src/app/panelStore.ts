/**
 * 会话面板的扩展持久化接线 —— 真源在共享 useSessionPanelStore（@shuvix/app-shell，
 * 状态/钳制宿主无关），本文件只负责扩展专属的宽度持久化：chrome.storage 启动水合 + 变化回存。
 * （旧的右侧面板已被会话面板取代：Files/Sub-agent 悬浮卡片挂在 ChatBody 正文区内。）
 */
import { useSessionPanelStore, SESSION_PANEL_MIN_W, SESSION_PANEL_MAX_W } from '@shuvix/app-shell'

const KEY = 'sessionPanelLayout'

/** 从 chrome.storage 载入（首屏渲染前调用）+ 订阅共享 store 变化回存 */
export async function initPanel(): Promise<void> {
  let saved: { width?: number } | undefined
  try {
    const obj = await chrome.storage.local.get(KEY)
    saved = obj[KEY]
  } catch {
    /* 用默认 */
  }
  if (saved?.width) {
    useSessionPanelStore.setState({
      width: Math.max(SESSION_PANEL_MIN_W, Math.min(SESSION_PANEL_MAX_W, saved.width))
    })
  }
  let lastWidth = useSessionPanelStore.getState().width
  useSessionPanelStore.subscribe((s) => {
    if (s.width === lastWidth) return
    lastWidth = s.width
    void chrome.storage.local.set({ [KEY]: { width: s.width } }).catch(() => {})
  })
}
