import { useEffect } from 'react'
import { getSessionChannelApi } from '@shuvix/chat-ui'
import { useChatStore } from '@shuvix/chat-ui'
import { useBrowserStore } from '../stores/browserStore'

/**
 * 宿主右侧面板桥。
 *
 * 浏览器/预览/sub-agent 右面板属于宿主外壳（不在可复用的对话框 @shuvix/chat-ui 内），
 * 因此把"开/切右面板"的反应留在宿主侧：
 *   - 子智能体：订阅共享信号 chatStore.subAgentRevealRequest（事件检测已统一在 useAgentEvents），
 *     收到即开面板 + 切到 subagent 页（与扩展/WebUI 同一信号源，仅"如何显示"各端实现）。
 *   - browser_event：宿主专属（浏览器面板），单独订阅 agent 事件开/关。
 *
 * 服务端项目若有自己的预览面板，会用它自己的等价桥替换本文件。
 */
export function useRightPanelBridge(): void {
  // 子智能体面板：响应共享 reveal 信号（单调 nonce，重复起子代理也会触发）
  const subAgentReveal = useChatStore((s) => s.subAgentRevealRequest)
  useEffect(() => {
    if (!subAgentReveal) return
    const browser = useBrowserStore.getState()
    if (!browser.isOpen) browser.open()
    browser.setActiveTab('subagent')
  }, [subAgentReveal])

  // 浏览器面板：宿主专属事件
  useEffect(() => {
    const unsub = getSessionChannelApi().agent.onEvent((event) => {
      if (event.type === 'browser_event') {
        if (event.action === 'open') {
          const browser = useBrowserStore.getState()
          if (getSessionChannelApi()?.app?.platform === 'web') {
            // web 平台：面板是会话镜像 iframe，与主进程 tab 无关，始终重写 URL
            browser.openAndNavigate(`${window.location.origin}/shuvix/browser/${event.sessionId}/`)
          } else if (event.url) {
            // 旧广播兼容（带 url）：renderer 建 tab / 导航激活 tab
            browser.openAndNavigate(event.url)
          } else if (!browser.isOpen) {
            // 新链路（browser 工具 openTab）：tab 已由主进程建好并经 browser-view:tab-* 镜像，
            // 这里只负责露出右侧面板
            browser.open()
          }
          browser.setActiveTab('browser')
        } else if (event.action === 'close') {
          const { tabs, activeTabId, closeTab, close } = useBrowserStore.getState()
          if (tabs.length === 0) {
            // 新链路（backend 关掉最后一个 tab 后广播）：收起面板
            close()
          } else if (activeTabId) {
            // 旧语义（CLI browser close）：清掉 agent 占用的页面 → 关激活 tab（面板本身不关）
            closeTab(activeTabId)
          }
        }
      }
    })
    return unsub
  }, [])
}
