import { useEffect } from 'react'
import { getSessionChannelApi, useAppEvent, useChatStore } from '@shuvix/chat-ui'
import { usePreviewRequestBridge } from '@shuvix/app-shell'
import { extractChartMermaid } from '@shuvix/chat-protocol/chartFileContract'
import { renderMermaid } from '@shuvix/atomic-editor'
import { useBrowserStore } from '../stores/browserStore'

/** 悬浮聊天窗口（#pinned-chat）：无 app 级右侧面板，预览经 PreviewOverlay 覆盖层展示 */
const isPinnedWindow = window.location.hash.startsWith('#pinned-chat')

/**
 * 宿主右侧面板桥。
 *
 * 右侧面板（app 级：浏览器/Preview/Widget）属于宿主外壳（不在可复用的对话框 @shuvix/chat-ui 内），
 * 因此把"开/切右面板"的反应留在宿主侧：
 *   - browser_event 订阅 agent 事件开/关浏览器面板；
 *   - filePreviewRequest（preview 工具 / Files 面板点击 / 笔记本 wiki-link）经共享
 *     usePreviewRequestBridge 落为预览目标，主窗再展开右侧面板并切到 preview tab
 *     （悬浮窗由 PreviewOverlay 按目标自动露出，不动窗口宽度；WebUI 只读端不承接）。
 * （子智能体揭示信号 subAgentRevealRequest 已随 Sub-agent 移入会话面板，由 ChatView 消费。）
 *
 * 服务端项目若有自己的预览面板，会用它自己的等价桥替换本文件。
 */
export function useRightPanelBridge(): void {
  const isWeb = getSessionChannelApi().app.platform === 'web'

  // 预览请求 → 目标落入共享 usePreviewPanelStore（WebUI 只读端不承接）
  usePreviewRequestBridge(!isWeb)

  // 主窗：预览目标就绪后展开右侧面板并切到 preview tab（悬浮窗覆盖层自动露出，无需动面板）
  const filePreviewRequest = useChatStore((s) => s.filePreviewRequest)
  useEffect(() => {
    if (!filePreviewRequest || isWeb || isPinnedWindow) return
    const browser = useBrowserStore.getState()
    browser.open()
    browser.setActiveTab('preview')
  }, [filePreviewRequest, isWeb])

  // 图表渲染验证请求（preview 工具经主进程 broker 发起）：用与 ChartView 同一管线跑
  // mermaid，结果经 IPC 回执。不依赖面板开合/会话活跃；多窗口先到先得（broker 对号入座）。
  // 验证只关心「能否渲染成功」，固定 default 主题（与明暗展示无关）。
  useAppEvent('preview.validateChart', (e) => {
    if (isWeb || !window.api?.preview) return
    void (async () => {
      try {
        const r = await getSessionChannelApi().files.read({
          sessionId: e.sessionId,
          path: e.absPath
        })
        const mermaid = r.kind === 'text' ? extractChartMermaid(r.content) : null
        if (!mermaid) {
          await window.api.preview.reportRender({
            validationId: e.validationId,
            ok: false,
            error: 'chart source is not extractable (contract violated or file unreadable)'
          })
          return
        }
        const res = await renderMermaid(mermaid, { theme: 'default' })
        await window.api.preview.reportRender({
          validationId: e.validationId,
          ok: !!res.svg && !res.error,
          error: res.error
        })
      } catch (err) {
        await window.api.preview
          .reportRender({
            validationId: e.validationId,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
          .catch(() => {})
      }
    })()
  })
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
