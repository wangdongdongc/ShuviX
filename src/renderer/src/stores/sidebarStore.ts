import { create } from 'zustand'
import { persistPanelLayout } from './panelLayout'

const DEFAULT_WIDTH = 240
const MIN_WIDTH = 180
const MAX_WIDTH = 400

interface SidebarState {
  /** 面板是否展开 */
  isOpen: boolean
  /** 面板宽度（px） */
  width: number

  toggle: () => void
  setWidth: (width: number) => void
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  isOpen: true,
  width: DEFAULT_WIDTH,

  toggle: () => {
    const isOpen = !get().isOpen
    set({ isOpen })
    persistPanelLayout({ sidebarOpen: isOpen })
  },
  setWidth: (width) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width))
    set({ width: clamped })
    persistPanelLayout({ sidebarWidth: clamped })
  }
}))

export { MIN_WIDTH as SIDEBAR_MIN_WIDTH, MAX_WIDTH as SIDEBAR_MAX_WIDTH }
