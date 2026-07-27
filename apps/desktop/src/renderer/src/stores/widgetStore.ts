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
  reload: () => Promise<void>
  /** 在 Browser tab 的 WebContentsView 中打开该 widget */
  openWidget: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 点击卡片 —— 在独立窗口打开该 widget（已开则聚焦）；启动构建 / URL 由窗口内 shell 处理 */
  openWidgetWindow: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 停止单个 widget —— 退出 app：关闭独立窗口 + 从 server 注销 */
  stopWidget: (id: string) => Promise<void>
  renameWidget: (id: string, name: string, description?: string) => Promise<void>
  archiveWidget: (id: string, archived: boolean) => Promise<void>
  deleteWidget: (id: string) => Promise<void>
}

export const useWidgetStore = create<WidgetState>((set, get) => ({
  widgets: [],
  archived: [],
  loaded: false,
  serverStatus: null,

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

  openWidgetWindow: async (id) => {
    const res = await window.api.widgetWindow.open(id)
    if (!res.success) {
      return { success: false, error: res.error }
    }
    // lastOpenedAt / server 状态的刷新由 shell 侧 widget.open 广播的 widget.changed 驱动
    return { success: true }
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
  }
}))
