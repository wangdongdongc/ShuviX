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
        if (event.action === 'open' && event.url) {
          let url = event.url
          if (getSessionChannelApi()?.app?.platform === 'web') {
            url = `${window.location.origin}/shuvix/browser/${event.sessionId}/`
          }
          const browser = useBrowserStore.getState()
          browser.open(url)
          browser.setActiveTab('browser')
        } else if (event.action === 'close') {
          useBrowserStore.getState().setUrl('about:blank')
        }
      }
    })
    return unsub
  }, [])
}
