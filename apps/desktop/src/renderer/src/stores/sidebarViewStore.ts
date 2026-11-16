import { create } from 'zustand'
import { toSidebarView, type SidebarView } from '@shuvix/app-shell'

/**
 * 侧栏此刻是哪种视图（会话 / 收件箱 / 日历）—— 桌面侧栏顶上的切换与手机会话页标题旁的切换共用。
 * 记在这台设备上（localStorage）：下次打开还是上次看的那一种；读不出、认不得的值回到会话视图。
 */
const STORAGE_KEY = 'shuvix.sidebarView'

function readStored(): SidebarView {
  try {
    return toSidebarView(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return 'sessions'
  }
}

interface SidebarViewState {
  view: SidebarView
  setView: (view: SidebarView) => void
}

export const useSidebarViewStore = create<SidebarViewState>((set) => ({
  view: readStored(),
  setView: (view) => {
    set({ view })
    try {
      window.localStorage.setItem(STORAGE_KEY, view)
    } catch {
      // 存不了（隐私窗口之类）：这次照样切，只是下次不记得
    }
  }
}))
