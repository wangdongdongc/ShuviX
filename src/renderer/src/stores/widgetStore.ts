import { create } from 'zustand'
import { useBrowserStore } from './browserStore'

type WidgetItem = WidgetSummary

interface ServerStatus {
  running: boolean
  port: number
  widgetCount: number
}

interface WidgetState {
  widgets: WidgetItem[]
  archived: WidgetItem[]
  loaded: boolean
  serverStatus: ServerStatus | null
  reload: () => Promise<void>
  /** 点击卡片 —— 在 Browser tab 的 WebContentsView 中打开该 widget */
  openWidget: (id: string) => Promise<{ success: boolean; error?: string }>
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
    // 切到 Browser tab 并加载 widget URL
    const browser = useBrowserStore.getState()
    if (!browser.isOpen) {
      browser.open(res.url)
    } else {
      browser.setUrl(res.url)
    }
    browser.setActiveTab('browser')
    // 刷新卡片顺序（lastOpenedAt）
    void get().reload()
    return { success: true }
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
