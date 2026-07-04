import { create } from 'zustand'
import { useSidebarStore as useSharedSidebarStore } from '@shuvix/app-shell'
import { persistPanelLayout } from './panelLayout'

/**
 * 桌面侧边栏 store —— 现为共享 useSidebarStore（@shuvix/app-shell）之上的薄外层。
 *
 * 通用两态 isOpen/width 真源在共享 store（底部单向镜像过来，使既有消费点零改动）；本 store 自有的是
 * 桌面专属的 isResizing（拖拽中标志，用于禁用过渡动画）+ 把开关/宽度持久化到 panelLayout 的 actions。
 * 侧边栏无原生窗口耦合，故 actions 只是「委托共享 store + 持久化」。
 */
// 默认宽度（240）由共享 store 持有；这里只管边界与持久化
const MIN_WIDTH = 180
const MAX_WIDTH = 400

interface SidebarState {
  /** 面板是否展开（镜像自共享 store） */
  isOpen: boolean
  /** 面板宽度（px，镜像自共享 store） */
  width: number
  /** 是否正在拖拽调整宽度（桌面专属，禁用过渡用） */
  isResizing: boolean

  toggle: () => void
  setWidth: (width: number) => void
  setResizing: (v: boolean) => void
}

const shared = (): ReturnType<typeof useSharedSidebarStore.getState> =>
  useSharedSidebarStore.getState()

export const useSidebarStore = create<SidebarState>((set) => ({
  isOpen: shared().isOpen,
  width: shared().width,
  isResizing: false,

  toggle: () => {
    shared().toggle()
    persistPanelLayout({ sidebarOpen: shared().isOpen })
  },
  setWidth: (width) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width))
    shared().setWidth(clamped)
    persistPanelLayout({ sidebarWidth: clamped })
  },
  setResizing: (v) => set({ isResizing: v })
}))

// 单向镜像：共享 store 的 isOpen/width → 本 store（既有 useSidebarStore 消费点零改动；isResizing 不受影响）
useSharedSidebarStore.subscribe((s) =>
  useSidebarStore.setState({ isOpen: s.isOpen, width: s.width })
)

export { MIN_WIDTH as SIDEBAR_MIN_WIDTH, MAX_WIDTH as SIDEBAR_MAX_WIDTH }
