import { create } from 'zustand'

/**
 * 共享右侧面板视图状态（桌面 / 扩展 / WebUI 共用）—— 只含通用三态 isOpen / activeTab / width。
 *
 * 刻意极简、零宿主耦合：持久化、宽度边界钳制、原生窗口宽度 / WebContentsView 坐标同步等都由各宿主
 * 在 store 之外接（扩展 chrome.storage；桌面 panelLayout + 原生窗口；WebUI 不持久化）。activeTab 用
 * string 以容纳各端不同的 tab 集合（桌面 browser/terminal/widget 专属；扩展 / WebUI 仅 files/subagent）。
 *
 * 这样「右侧面板的视图状态管理」随面板组件（PanelTabBar / FilesPanel / SubAgentPanel）一起作为共享代码，
 * 三端行为天然一致；面板的自动揭示也能据此收敛（见 usePanelReveal）。
 */
export interface PanelStoreState {
  /** 面板是否展开 */
  isOpen: boolean
  /** 当前激活的 tab（各端集合不同，故为 string） */
  activeTab: string
  /** 面板宽度（px）；钳制由各端 resize handle / 宿主包装负责 */
  width: number

  setOpen: (open: boolean) => void
  toggle: () => void
  setActiveTab: (tab: string) => void
  /** 确保展开并切到 tab（不 toggle）—— 文件预览 / 子代理揭示用 */
  showTab: (tab: string) => void
  /** 切到 tab：已展开且同 tab 则收起（点按 toggle 语义） */
  openTab: (tab: string) => void
  setWidth: (width: number) => void
}

export const usePanelStore = create<PanelStoreState>((set, get) => ({
  isOpen: false,
  activeTab: 'files',
  width: 320,

  setOpen: (open) => set({ isOpen: open }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  setActiveTab: (tab) => set({ activeTab: tab }),
  showTab: (tab) => {
    if (get().isOpen && get().activeTab === tab) return
    set({ isOpen: true, activeTab: tab })
  },
  openTab: (tab) =>
    set((s) =>
      s.isOpen && s.activeTab === tab ? { isOpen: false } : { isOpen: true, activeTab: tab }
    ),
  setWidth: (width) => set({ width })
}))
