import { create } from 'zustand'
import { isWebHost } from '../host/hostMedia'
import { sanitizeAuthoredSvg } from '@shuvix/chat-protocol/utils/svgSanitize'

type WidgetItem = WidgetSummary

interface ServerStatus {
  running: boolean
  port: number
  widgetCount: number
  registeredIds: string[]
}

/** 关独立窗口后最多等多久让它真的关掉（关窗会把 widget 从服务上注销，面板得等它注销完再打开） */
const WINDOW_CLOSE_WAIT_MS = 2000

interface WidgetState {
  widgets: WidgetItem[]
  archived: WidgetItem[]
  loaded: boolean
  serverStatus: ServerStatus | null
  /** 此刻开着独立窗口的 widget（浏览器里的 web 客户端恒为空） */
  windowOpen: string[]
  /** 上次选了在独立窗口打开的 widget（点图标时直接开窗口；web 客户端恒为空） */
  preferWindow: string[]
  /** 在 Widget 面板里开着的应用，按打开先后；回到主屏也不关（状态留着），不限个数 */
  panelApps: string[]
  /** 面板此刻显示的应用；null = 主屏 */
  foregroundApp: string | null
  /** 图标原文缓存（已清洗；按 iconMtime 失效） */
  icons: Record<string, { mtime: number; svg: string | null }>

  reload: () => Promise<void>
  ensureIcon: (id: string, mtime: number) => void
  /** 面板里打开（已开着就切到前台） */
  openInPanel: (id: string) => void
  /** 回主屏（应用留在后台） */
  goHome: () => void
  /** 从面板里关掉一个应用（不注销服务；注销由 stopWidget 负责） */
  closePanelApp: (id: string) => void
  /** 用户选了在独立窗口打开：记下偏好、从面板收走、开窗口（已开则聚焦） */
  openInWindow: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 点图标时该开窗口（开着的 / 上次选了窗口）：开或聚焦那个窗口，**不改偏好** —— 偏好只由用户的明确选择改写 */
  focusWindow: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 用户选了在面板里打开：记下偏好；开着独立窗口就先关掉它 */
  chooseOpenInPanel: (id: string) => Promise<void>
  /** 点图标：按「开着窗口 / 上次选了窗口」决定开在哪 —— 返回 'panel' 表示该在面板里打开 */
  launchTarget: (id: string) => 'panel' | 'window'
  setHomeOrder: (ids: string[]) => Promise<void>
  /** 停止单个 widget —— 退出 app：从面板收走 + 关独立窗口 + 从 server 注销 */
  stopWidget: (id: string) => Promise<void>
  renameWidget: (id: string, name: string, description?: string) => Promise<void>
  archiveWidget: (id: string, archived: boolean) => Promise<void>
  deleteWidget: (id: string) => Promise<void>
}

const iconRequests = new Map<string, number>()

/**
 * 图标原文 → 可以内联的标记：按「外来作者」那一档清洗（聊天里 ```svg 同一档 —— 作者是 agent，文件也可能是
 * 从别处拷来的）；清洗不过 → null，图标回落到字
 */
function cleanIcon(raw: string | null): string | null {
  if (!raw) return null
  return sanitizeAuthoredSvg(raw) || null
}

export const useWidgetStore = create<WidgetState>((set, get) => ({
  widgets: [],
  archived: [],
  loaded: false,
  serverStatus: null,
  windowOpen: [],
  preferWindow: [],
  panelApps: [],
  foregroundApp: null,
  icons: {},

  reload: async () => {
    const [list, archived, status] = await Promise.all([
      window.api.widget.list(),
      window.api.widget.listArchived(),
      window.api.widget.getServerStatus()
    ])
    const windows = await window.api.widgetWindow.status(list.map((w) => w.id))
    const active = new Set(list.map((w) => w.id))
    // 面板里开着的应用：已删 / 已归档 / 被开到独立窗口里的，从面板收走（同一个 widget 只开在一处）
    const keep = (id: string): boolean => active.has(id) && !windows.open.includes(id)
    const { panelApps, foregroundApp } = get()
    set({
      widgets: list,
      archived,
      loaded: true,
      serverStatus: status,
      windowOpen: windows.open,
      preferWindow: windows.preferWindow,
      panelApps: panelApps.filter(keep),
      foregroundApp: foregroundApp && keep(foregroundApp) ? foregroundApp : null
    })
  },

  ensureIcon: (id, mtime) => {
    if (get().icons[id]?.mtime === mtime || iconRequests.get(id) === mtime) return
    iconRequests.set(id, mtime)
    void window.api.widget
      .getIcon(id)
      .then(({ svg }) => {
        set((s) => ({ icons: { ...s.icons, [id]: { mtime, svg: cleanIcon(svg) } } }))
      })
      .catch(() => undefined) // 取不到就先显示字；下次渲染再试
      .finally(() => {
        if (iconRequests.get(id) === mtime) iconRequests.delete(id)
      })
  },

  openInPanel: (id) => {
    set((s) => ({
      panelApps: s.panelApps.includes(id) ? s.panelApps : [...s.panelApps, id],
      foregroundApp: id
    }))
  },

  goHome: () => set({ foregroundApp: null }),

  closePanelApp: (id) =>
    set((s) => ({
      panelApps: s.panelApps.filter((x) => x !== id),
      foregroundApp: s.foregroundApp === id ? null : s.foregroundApp
    })),

  openInWindow: async (id) => {
    if (!isWebHost) {
      void window.api.widgetWindow.setPreferWindow({ id, value: true })
      set((s) => ({
        preferWindow: s.preferWindow.includes(id) ? s.preferWindow : [...s.preferWindow, id]
      }))
    }
    get().closePanelApp(id)
    const res = await window.api.widgetWindow.open(id)
    if (!res.success) return { success: false, error: res.error }
    return { success: true }
  },

  focusWindow: async (id) => {
    get().closePanelApp(id)
    const res = await window.api.widgetWindow.open(id)
    if (!res.success) return { success: false, error: res.error }
    return { success: true }
  },

  chooseOpenInPanel: async (id) => {
    if (isWebHost) return
    void window.api.widgetWindow.setPreferWindow({ id, value: false })
    set((s) => ({ preferWindow: s.preferWindow.filter((x) => x !== id) }))
    // 现问一次（缓存的 windowOpen 可能还没跟上刚开的窗口）
    const { open: openNow } = await window.api.widgetWindow.status([])
    if (!openNow.includes(id)) return
    await window.api.widgetWindow.close(id)
    // 关窗会把 widget 从服务上注销（closed 回调里的 stopWidget）：等它真的关掉，面板再去注册，
    // 否则晚到的注销会把面板刚拿到的那份撤掉
    const deadline = Date.now() + WINDOW_CLOSE_WAIT_MS
    while (Date.now() < deadline) {
      const { open } = await window.api.widgetWindow.status([])
      if (!open.includes(id)) break
      await new Promise((r) => setTimeout(r, 50))
    }
    set((s) => ({ windowOpen: s.windowOpen.filter((x) => x !== id) }))
  },

  launchTarget: (id) => {
    if (isWebHost) return 'panel'
    const { windowOpen, preferWindow } = get()
    return windowOpen.includes(id) || preferWindow.includes(id) ? 'window' : 'panel'
  },

  setHomeOrder: async (ids) => {
    // 先在本地按新顺序排好（拖动松手后不等一来一回），再落盘；落盘后的 widget.changed 再对一次账
    const byId = new Map(get().widgets.map((w) => [w.id, w]))
    const reordered = ids.map((id) => byId.get(id)).filter((w): w is WidgetItem => !!w)
    const rest = get().widgets.filter((w) => !ids.includes(w.id))
    set({ widgets: [...reordered, ...rest] })
    await window.api.widget.setHomeOrder(ids)
  },

  stopWidget: async (id) => {
    get().closePanelApp(id)
    await window.api.widget.stopWidget(id)
    await get().reload()
  },

  renameWidget: async (id, name, description) => {
    await window.api.widget.rename({ id, name, description })
    await get().reload()
  },

  archiveWidget: async (id, archived) => {
    if (archived) get().closePanelApp(id)
    await window.api.widget.setArchived({ id, archived })
    await get().reload()
  },

  deleteWidget: async (id) => {
    get().closePanelApp(id)
    await window.api.widget.delete(id)
    await get().reload()
  }
}))
