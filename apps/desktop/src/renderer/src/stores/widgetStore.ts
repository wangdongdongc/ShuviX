import { create } from 'zustand'
import { useBrowserStore } from './browserStore'

type WidgetItem = WidgetSummary

interface ServerStatus {
  running: boolean
  port: number
  widgetCount: number
  registeredIds: string[]
}

interface WidgetState {
  widgets: WidgetItem[]
  archived: WidgetItem[]
  loaded: boolean
  serverStatus: ServerStatus | null
  /** 正在启动中（loading）的 widget id 集合 */
  startingIds: Set<string>
  reload: () => Promise<void>
  /** 点击卡片 —— 在 Browser tab 的 WebContentsView 中打开该 widget */
  openWidget: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 启动单个 widget —— 仅注册到 server，不打开浏览器 */
  startWidget: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 停止单个 widget —— 从 server 注销 */
  stopWidget: (id: string) => Promise<void>
  renameWidget: (id: string, name: string, description?: string) => Promise<void>
  archiveWidget: (id: string, archived: boolean) => Promise<void>
  deleteWidget: (id: string) => Promise<void>
  stopServer: () => Promise<void>
}

export const useWidgetStore = create<WidgetState>((set, get) => ({
  widgets: [],
  archived: [],
  loaded: false,
  serverStatus: null,
  startingIds: new Set(),

  reload: async () => {
    const [list, archived, status] = await Promise.all([
      window.api.widget.list(),
      window.api.widget.listArchived(),
      window.api.widget.getServerStatus()
    ])
    set({ widgets: list, archived, loaded: true, serverStatus: status })
  },

  openWidget: async (id) => {
    const res = await window.api.widget.open(id)
    if (!res.success) {
      return { success: false, error: res.error }
    }
    // 切到 Browser tab 并加载 widget URL（面板未开则打开；有激活 tab 导航之，无则新建）
    const browser = useBrowserStore.getState()
    browser.openAndNavigate(res.url)
    browser.setActiveTab('browser')
    // 刷新卡片顺序（lastOpenedAt）
    void get().reload()
    return { success: true }
  },

  startWidget: async (id) => {
    // 标记为 loading
    set((s) => {
      const next = new Set(s.startingIds)
      next.add(id)
      return { startingIds: next }
    })
    try {
      const res = await window.api.widget.startWidget(id)
      if (!res.success) {
        return { success: false, error: res.error }
      }
      await get().reload()
      return { success: true }
    } finally {
      set((s) => {
        const next = new Set(s.startingIds)
        next.delete(id)
        return { startingIds: next }
      })
    }
  },

  stopWidget: async (id) => {
    await window.api.widget.stopWidget(id)
    await get().reload()
  },

  renameWidget: async (id, name, description) => {
    await window.api.widget.rename({ id, name, description })
    await get().reload()
  },

  archiveWidget: async (id, archived) => {
    await window.api.widget.setArchived({ id, archived })
    await get().reload()
  },

  deleteWidget: async (id) => {
    await window.api.widget.delete(id)
    await get().reload()
  },

  stopServer: async () => {
    await window.api.widget.stopServer()
    await get().reload()
  }
}))
