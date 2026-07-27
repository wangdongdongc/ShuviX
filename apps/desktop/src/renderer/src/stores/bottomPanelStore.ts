import { create } from 'zustand'
import { persistPanelLayout } from './panelLayout'

/** 底部面板（终端）高度边界 */
const BOTTOM_MIN = 120
const BOTTOM_MAX = 800

/**
 * 底部面板 store —— 承载终端的底部栏（主窗口专属，位于聊天区 + 右侧面板之下）。
 * 开关 / 高度持久化到 window.panelLayout（bottomOpen / bottomHeight），由 useAppInit 恢复。
 */
interface BottomPanelState {
  isOpen: boolean
  /** 面板高度（px） */
  height: number

  toggle: () => void
  open: () => void
  close: () => void
  setHeight: (height: number) => void
}

export const useBottomPanelStore = create<BottomPanelState>((set, get) => ({
  isOpen: false,
  height: 260,

  toggle: () => {
    const isOpen = !get().isOpen
    set({ isOpen })
    persistPanelLayout({ bottomOpen: isOpen })
  },
  open: () => {
    if (get().isOpen) return
    set({ isOpen: true })
    persistPanelLayout({ bottomOpen: true })
  },
  close: () => {
    if (!get().isOpen) return
    set({ isOpen: false })
    persistPanelLayout({ bottomOpen: false })
  },
  setHeight: (height) => {
    const clamped = Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, height))
    set({ height: clamped })
    persistPanelLayout({ bottomHeight: clamped })
  }
}))
