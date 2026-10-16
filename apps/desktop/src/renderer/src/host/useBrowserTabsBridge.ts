import { useEffect } from 'react'
import { useBrowserTabsStore, type BrowserTabInfo } from '../stores/browserTabsStore'

/**
 * 浏览器 tab 状态桥 —— 主进程 tab 真源 → useBrowserTabsStore 镜像。
 *
 * 订阅 `browser-view:*` 事件，按 tabId 更新 store.tabs / activeTabId；
 * mount 时先订阅再 listTabs() 水合（按 id merge，防止水合窗口内丢事件），
 * 这样 renderer 重载（HMR / 刷新）后也能恢复主进程仍存活的 tab 列表。
 * 挂在浏览器窗口（#browser-window）的根组件上 —— 主窗口不镜像 tab。
 */
export function useBrowserTabsBridge(): void {
  useEffect(() => {
    const api = window.api?.browserView
    if (!api) return

    const updateTab = (tabId: string, patch: Partial<BrowserTabInfo>): void => {
      useBrowserTabsStore.setState((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
      }))
    }

    const cleanups = [
      api.onTabCreated(({ tabId, url, active }) => {
        useBrowserTabsStore.setState((s) => {
          if (s.tabs.some((t) => t.id === tabId)) return s
          const tab: BrowserTabInfo = {
            id: tabId,
            url,
            title: '',
            isLoading: false,
            loadError: null,
            cdpAttached: false,
            cdpIntercepting: false,
            canGoBack: false,
            canGoForward: false,
            zoomPercent: 100
          }
          return { tabs: [...s.tabs, tab], ...(active ? { activeTabId: tabId } : {}) }
        })
      }),
      api.onTabClosed(({ tabId, activeTabId }) => {
        useBrowserTabsStore.setState((s) => ({
          tabs: s.tabs.filter((t) => t.id !== tabId),
          activeTabId
        }))
      }),
      api.onTabActivated(({ tabId }) => {
        useBrowserTabsStore.setState({ activeTabId: tabId })
      }),
      api.onTabTitleUpdated(({ tabId, title }) => {
        updateTab(tabId, { title })
      }),
      api.onTabFaviconUpdated(({ tabId, favicon }) => {
        updateTab(tabId, { favicon })
      }),
      // agent 的 CDP 接入/请求拦截状态（标签上的圆点、提示条）
      api.onTabCdpState(({ tabId, cdpAttached, cdpIntercepting }) => {
        updateTab(tabId, { cdpAttached, cdpIntercepting })
      }),
      // agent 在这页上动作了一下：记下是哪个会话、什么时候（圆点脉动一会儿）
      api.onTabAgent(({ tabId, sessionId, sessionTitle }) => {
        updateTab(tabId, {
          agentSessionId: sessionId,
          agentSessionTitle: sessionTitle,
          agentActiveAt: Date.now()
        })
      }),
      api.onTabZoom(({ tabId, zoomPercent }) => {
        updateTab(tabId, { zoomPercent })
      }),
      // 用户新开空白页 / ⌘L：光标放进地址栏（只有用户的动作会发它 —— agent 开的空白页不会）
      api.onCommand(({ command }) => {
        if (command === 'focusOmnibox') useBrowserTabsStore.getState().requestOmniboxFocus()
      }),
      api.onDidStartLoading(({ tabId }) => {
        updateTab(tabId, { isLoading: true, loadError: null })
      }),
      // 导航一开始只带地址；提交后还带后退 / 前进与站点缩放 —— 只合并带来的字段
      api.onDidNavigate(({ tabId, url, canGoBack, canGoForward, zoomPercent }) => {
        updateTab(tabId, {
          url,
          ...(canGoBack !== undefined ? { canGoBack } : {}),
          ...(canGoForward !== undefined ? { canGoForward } : {}),
          ...(zoomPercent !== undefined ? { zoomPercent } : {})
        })
      }),
      // 只熄灭 spinner，不碰 loadError：加载失败时 did-fail-load 先到，错误页要留住
      api.onDidStopLoading(({ tabId }) => {
        updateTab(tabId, { isLoading: false })
      }),
      api.onDidFailLoad(({ tabId, errorCode, errorDescription, url, crashed }) => {
        updateTab(tabId, {
          isLoading: false,
          loadError: { errorCode, errorDescription, url, ...(crashed ? { crashed } : {}) }
        })
      })
    ]

    // 水合：按 id merge 进已有镜像（订阅先行，期间到达的事件不丢）
    void api.listTabs().then((list) => {
      useBrowserTabsStore.setState((s) => {
        const existing = new Map(s.tabs.map((t) => [t.id, t]))
        const tabs = list.map(
          (t): BrowserTabInfo =>
            existing.get(t.id) ?? {
              id: t.id,
              url: t.url,
              title: t.title,
              isLoading: t.loading,
              // 窗口晚于崩溃才打开：崩溃事件当时没人收，从快照里补上（原因已经不知道了）
              loadError: t.crashed
                ? { errorCode: 0, errorDescription: 'crashed', url: t.url, crashed: true }
                : null,
              cdpAttached: t.cdpAttached,
              cdpIntercepting: t.cdpIntercepting,
              canGoBack: t.canGoBack,
              canGoForward: t.canGoForward,
              zoomPercent: t.zoomPercent,
              ...(t.agentSessionId
                ? { agentSessionId: t.agentSessionId, agentSessionTitle: t.agentSessionTitle }
                : {})
            }
        )
        const active = list.find((t) => t.active)
        return { tabs, activeTabId: active ? active.id : s.activeTabId }
      })
    })

    return () => cleanups.forEach((c) => c())
  }, [])
}
