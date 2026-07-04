import { create } from 'zustand'

/**
 * 共享侧边栏视图状态（桌面 / 扩展共用）—— 只含通用两态 isOpen / width。
 *
 * 与 usePanelStore 同思路：刻意极简、零宿主耦合。持久化（桌面 panelLayout / 扩展 chrome.storage）、
 * 宽度边界钳制由各宿主在 store 外接；桌面专属的 isResizing（拖拽中标志）留在桌面外层，不入共享 store。
 */
export interface SidebarStoreState {
  /** 侧栏是否展开 */
  isOpen: boolean
  /** 侧栏宽度（px）；钳制由各端 resize handle / 宿主包装负责 */
  width: number

  setOpen: (open: boolean) => void
  toggle: () => void
  setWidth: (width: number) => void
}

export const useSidebarStore = create<SidebarStoreState>((set) => ({
  isOpen: true,
  width: 240,

  setOpen: (open) => set({ isOpen: open }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  setWidth: (width) => set({ width })
}))
