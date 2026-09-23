import { create } from 'zustand'

/** 浏览器 tab 的镜像信息（真源在主进程 browserViewService，经 useBrowserTabsBridge 事件同步） */
export interface BrowserTabInfo {
  id: string
  url: string
  title: string
  favicon?: string
  isLoading: boolean
  loadError: { errorCode: number; errorDescription: string; url: string } | null
  /** agent 已通过 CDP 接入此 tab（可观察和操作页面）；桌面 attach 跨轮持久，标识随之常亮 */
  cdpAttached: boolean
  /** agent 开启了请求拦截（Fetch 域）——此 tab 加载的内容可能被修改或替换 */
  cdpIntercepting: boolean
}

/**
 * 浏览器窗口（#browser-window）的 tab store。
 *
 * 只住在浏览器窗口里 —— 主窗口不再镜像 tab（浏览器从右侧面板搬进了自己的窗口）。
 * 状态是主进程的镜像：actions 只发 IPC，`browser-view:tab-*` 事件回填 tabs/activeTabId
 * （见 host/useBrowserTabsBridge.ts），单一数据流。
 */
interface BrowserTabsState {
  /** tab 列表（顺序 = 主进程的插入序） */
  tabs: BrowserTabInfo[]
  /** 当前激活的 tab id —— agent 的 browser 工具默认操作它 */
  activeTabId: string | null

  createTab: (url?: string) => void
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  navigateTab: (id: string, url: string) => void
}

function api(): (typeof window.api)['browserView'] | undefined {
  return window.api?.browserView
}

export const useBrowserTabsStore = create<BrowserTabsState>(() => ({
  tabs: [],
  activeTabId: null,

  createTab: (url) => {
    void api()?.createTab(url)
  },
  closeTab: (id) => {
    void api()?.closeTab(id)
  },
  activateTab: (id) => {
    void api()?.activateTab(id)
  },
  navigateTab: (id, url) => {
    void api()?.navigate(id, url)
  }
}))
