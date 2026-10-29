import { create } from 'zustand'
import { internalPageOf, type InternalPage } from '../../../shared/browserInternalPages'
import type { DevtoolsDockPanel, DevtoolsDockState } from '../../../shared/browserAgentDevtools'
import type { HistoryTransition } from '../../../shared/browserHistory'

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
  /** 这一页的停靠区（页面下方：原生 DevTools / agent 的 devtool）；关着 = 没有 */
  devtools?: DevtoolsDockState
  /** agent 在这一页上记下的 devtool 调用数（提示条上的「查看 agent 的操作」） */
  agentDevtoolsCalls: number
}

/** 设置页要跳到哪一节（站点信息气泡里的「网站设置」）；nonce 每次请求加一 */
export interface SettingsFocus {
  section: 'search' | 'privacy' | 'certificates'
  /** 网站数据的搜索框预填（那个站点） */
  search?: string
  /** 直接打开这个网站的详情（站点信息气泡里的「网站设置」） */
  site?: string
  nonce: number
}

/**
 * 页面被一个 DOM 弹层盖住的时候（站点信息气泡）：原生页面画在 DOM 之上、会把弹层盖住，所以这段时间
 * 页面区换成它的截图，原生 view 让位（布局表报 setVisible(false)），弹层关掉再换回来。
 */
export interface PageCover {
  tabId: string
  /** 截图（dataURL）；还没抓到时为空串（页面区先空着） */
  snapshot: string
}

/** 浏览器窗口的两种视图：单页（Chrome 的样子，缺省）与平铺墙（同时看多页） */
export type BrowserViewMode = 'single' | 'wall'
export const VIEW_MODE_SETTING = 'browser.viewMode'
/** 停靠区的高度（CSS px；所有页共用一个，照 Chrome） */
export const DEVTOOLS_HEIGHT_SETTING = 'browser.devtoolsHeight'

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
  settingsFocus: SettingsFocus | null
  pageCover: PageCover | null

  /** `transition`：从地址栏开的（typed = 网址、generated = 搜索），记进历史用 */
  createTab: (url?: string, transition?: HistoryTransition) => void
  closeTab: (id: string) => void
  reopenClosedTab: () => void
  activateTab: (id: string) => void
  navigateTab: (id: string, url: string, transition?: HistoryTransition) => void
  zoomTab: (id: string, direction: 'in' | 'out' | 'reset') => void
  /** 打开这一页的停靠区、停在某个页签（用户的动作） */
  openDevtools: (id: string, panel: DevtoolsDockPanel) => void
  closeDevtools: (id: string) => void
  requestOmniboxFocus: () => void
  /** 打开设置页并跳到某一节（站点信息气泡里的「网站设置」） */
  openSettings: (section?: SettingsFocus['section'], search?: string, site?: string) => void
  setPageCover: (cover: PageCover | null) => void
  /** 设置页用掉了跳转请求 */
  clearSettingsFocus: () => void
}

function api(): (typeof window.api)['browserView'] | undefined {
  return window.api?.browserView
}

export const useBrowserTabsStore = create<BrowserTabsState>((set) => ({
  tabs: [],
  activeTabId: null,
  omniboxFocusNonce: 0,
  settingsFocus: null,
  pageCover: null,

  createTab: (url, transition) => {
    if (transition) void api()?.createTab(url, transition)
    else void api()?.createTab(url)
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
  navigateTab: (id, url, transition) => {
    if (transition) void api()?.navigate(id, url, transition)
    else void api()?.navigate(id, url)
  },
  zoomTab: (id, direction) => {
    void api()?.zoom(id, direction)
  },
  openDevtools: (id, panel) => {
    void api()?.openDevtools(id, panel)
  },
  closeDevtools: (id) => {
    void api()?.closeDevtools(id)
  },
  requestOmniboxFocus: () => set((s) => ({ omniboxFocusNonce: s.omniboxFocusNonce + 1 })),
  openSettings: (section, search, site) => {
    void api()?.openInternal('settings')
    if (section) {
      set((s) => ({
        settingsFocus: {
          section,
          ...(search !== undefined ? { search } : {}),
          ...(site !== undefined ? { site } : {}),
          nonce: (s.settingsFocus?.nonce ?? 0) + 1
        }
      }))
    }
  },
  setPageCover: (cover) => set({ pageCover: cover }),
  clearSettingsFocus: () => set({ settingsFocus: null })
}))

/** 这个 tab 是不是内部页面（shuvix://settings …）；是就回页名 */
export function internalPageOfTab(tab: Pick<BrowserTabInfo, 'url'>): InternalPage | null {
  return internalPageOf(tab.url)
}

/** 选中的那一页（没有就 null） */
export function selectedTab(
  s: Pick<BrowserTabsState, 'tabs' | 'activeTabId'>
): BrowserTabInfo | null {
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null
}
