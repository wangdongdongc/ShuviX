import { create } from 'zustand'

/** 浏览器 tab 的镜像信息（真源在主进程 browserViewService，经 useBrowserTabsBridge 事件同步） */
export interface BrowserTabInfo {
  id: string
  url: string
  title: string
  favicon?: string
  isLoading: boolean
  /** crashed：页面的渲染进程没了（errorDescription 是原因）—— 显示「页面崩溃了」而不是「无法访问」 */
  loadError: {
    errorCode: number
    errorDescription: string
    url: string
    crashed?: boolean
  } | null
  /** agent 已通过 CDP 接入此 tab（可观察和操作页面）；桌面 attach 跨轮持久，标识随之常亮 */
  cdpAttached: boolean
  /** agent 开启了请求拦截（Fetch 域）——此 tab 加载的内容可能被修改或替换 */
  cdpIntercepting: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 用户在这个站点上调的页面缩放（百分比；100 时地址栏不显示缩放标识） */
  zoomPercent: number
  /** 最近在这页上动作的会话（标签上的圆点颜色、提示条上的会话名） */
  agentSessionId?: string
  agentSessionTitle?: string
  /** 最近一次 agent 动作提示到达的时刻（ms）：圆点据此脉动一会儿 */
  agentActiveAt?: number
}

/** 浏览器窗口的两种视图：单页（Chrome 的样子，缺省）与平铺墙（同时看多页） */
export type BrowserViewMode = 'single' | 'wall'
export const VIEW_MODE_SETTING = 'browser.viewMode'

/**
 * 浏览器窗口（#browser-window）的 tab store。
 *
 * 只住在浏览器窗口里 —— 主窗口不镜像 tab。状态是主进程的镜像：actions 只发 IPC，`browser-view:*` 事件
 * 回填 tabs/activeTabId（见 host/useBrowserTabsBridge.ts），单一数据流。
 * activeTabId 是**用户选中的那一页**：只由用户改，agent 的动作从不改它。
 */
interface BrowserTabsState {
  /** tab 列表（顺序 = 主进程的插入序 = 标签条顺序） */
  tabs: BrowserTabInfo[]
  /** 用户选中的那一页 */
  activeTabId: string | null
  /** 每加一次，地址栏就聚焦一次（⌘L / ⌘T / 新标签页） */
  omniboxFocusNonce: number

  createTab: (url?: string) => void
  closeTab: (id: string) => void
  reopenClosedTab: () => void
  activateTab: (id: string) => void
  navigateTab: (id: string, url: string) => void
  zoomTab: (id: string, direction: 'in' | 'out' | 'reset') => void
  requestOmniboxFocus: () => void
}

function api(): (typeof window.api)['browserView'] | undefined {
  return window.api?.browserView
}

export const useBrowserTabsStore = create<BrowserTabsState>((set) => ({
  tabs: [],
  activeTabId: null,
  omniboxFocusNonce: 0,

  createTab: (url) => {
    void api()?.createTab(url)
  },
  closeTab: (id) => {
    void api()?.closeTab(id)
  },
  reopenClosedTab: () => {
    void api()?.reopenClosedTab()
  },
  activateTab: (id) => {
    void api()?.activateTab(id)
  },
  navigateTab: (id, url) => {
    void api()?.navigate(id, url)
  },
  zoomTab: (id, direction) => {
    void api()?.zoom(id, direction)
  },
  requestOmniboxFocus: () => set((s) => ({ omniboxFocusNonce: s.omniboxFocusNonce + 1 }))
}))

/** 选中的那一页（没有就 null） */
export function selectedTab(
  s: Pick<BrowserTabsState, 'tabs' | 'activeTabId'>
): BrowserTabInfo | null {
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null
}
