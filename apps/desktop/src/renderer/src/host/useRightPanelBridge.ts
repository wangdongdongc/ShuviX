import { useEffect } from 'react'
import { getChatApi } from '@shuvix/chat-ui'
import { useChatStore } from '@shuvix/chat-ui'
import { useBrowserStore } from '../stores/browserStore'

/**
 * 宿主右侧面板桥。
 *
 * 浏览器/预览/sub-agent 右面板属于宿主外壳（不在可复用的对话框 @shuvix/chat-ui 内），
 * 因此把 agent 事件里"开/切右面板"的反应留在宿主侧单独订阅：
 *   - sub_session_register：归属当前会话时自动开面板 + 切到 subagent 页
 *   - browser_event：开/关浏览器面板
 *
 * 服务端项目若有自己的预览面板，会用它自己的等价桥替换本文件。
 */
export function useRightPanelBridge(): void {
  useEffect(() => {
    const unsub = getChatApi().agent.onEvent((event) => {
      if (event.type === 'sub_session_register') {
        if (event.parentSessionId === useChatStore.getState().activeSessionId) {
          const browser = useBrowserStore.getState()
          if (!browser.isOpen) browser.open()
          browser.setActiveTab('subagent')
        }
      } else if (event.type === 'browser_event') {
        if (event.action === 'open' && event.url) {
          let url = event.url
          if (getChatApi()?.app?.platform === 'web') {
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
