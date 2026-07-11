import { useEffect } from 'react'
import { useBrowserStore, type BrowserTabInfo } from '../stores/browserStore'

/**
 * 浏览器 tab 状态桥 —— 主进程 tab 真源 → useBrowserStore 镜像。
 *
 * 订阅 `browser-view:tab-*` 与导航事件，按 tabId 更新 store.tabs / activeTabId；
 * mount 时先订阅再 listTabs() 水合（按 id merge，防止水合窗口内丢事件），
 * 这样 renderer 重载（HMR / 刷新）后也能恢复主进程仍存活的 tab 列表。
 * 挂在 App 根常驻组件（与 useRightPanelBridge 并列）。
 */
export function useBrowserTabsBridge(): void {
  useEffect(() => {
    const api = window.api?.browserView
    if (!api) return

    const updateTab = (tabId: string, patch: Partial<BrowserTabInfo>): void => {
      useBrowserStore.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
      }))
    }

    const cleanups = [
      api.onTabCreated(({ tabId, url, active }) => {
        useBrowserStore.setState((s) => {
          if (s.tabs.some((t) => t.id === tabId)) return s
          const tab: BrowserTabInfo = {
            id: tabId,
            url,
            title: '',
            isLoading: false,
            loadError: null
          }
          return { tabs: [...s.tabs, tab], ...(active ? { activeTabId: tabId } : {}) }
        })
      }),
      api.onTabClosed(({ tabId, activeTabId }) => {
        useBrowserStore.setState((s) => ({
          tabs: s.tabs.filter((t) => t.id !== tabId),
          activeTabId
        }))
      }),
      api.onTabActivated(({ tabId }) => {
        useBrowserStore.setState({ activeTabId: tabId })
      }),
      api.onTabTitleUpdated(({ tabId, title }) => {
        updateTab(tabId, { title })
      }),
      api.onTabFaviconUpdated(({ tabId, favicon }) => {
        updateTab(tabId, { favicon })
      }),
      api.onDidStartLoading(({ tabId, url }) => {
        updateTab(tabId, { isLoading: true, loadError: null, url })
      }),
      api.onDidNavigate(({ tabId, url }) => {
        updateTab(tabId, { url })
      }),
      api.onDidFinishLoad(({ tabId }) => {
        updateTab(tabId, { isLoading: false, loadError: null })
      }),
      api.onDidFailLoad(({ tabId, errorCode, errorDescription, url }) => {
        updateTab(tabId, { isLoading: false, loadError: { errorCode, errorDescription, url } })
      })
    ]

    // 水合：按 id merge 进已有镜像（订阅先行，期间到达的事件不丢）
    void api.listTabs().then((list) => {
      useBrowserStore.setState((s) => {
        const existing = new Map(s.tabs.map((t) => [t.id, t]))
        const tabs = list.map(
          (t): BrowserTabInfo =>
            existing.get(t.id) ?? {
              id: t.id,
              url: t.url,
              title: t.title,
              isLoading: false,
              loadError: null
            }
        )
        const active = list.find((t) => t.active)
        return { tabs, activeTabId: active ? active.id : s.activeTabId }
      })
    })

    return () => cleanups.forEach((c) => c())
  }, [])
}
