import { useEffect } from 'react'
import { getSessionChannelApi, useChatStore } from '@shuvix/chat-ui'
import { usePreviewRequestBridge } from '@shuvix/app-shell'
import { useBrowserStore } from '../stores/browserStore'

/** 悬浮聊天窗口（#pinned-chat）：无 app 级右侧面板，预览经 PreviewOverlay 覆盖层展示 */
const isPinnedWindow = window.location.hash.startsWith('#pinned-chat')

/**
 * 宿主右侧面板桥。
 *
 * 右侧面板（app 级：Preview/Widget/Calendar/Agents）属于宿主外壳（不在可复用的对话框 @shuvix/chat-ui 内），
 * 因此把"开/切右面板"的反应留在宿主侧：
 *   - filePreviewRequest（Files 面板点击 / 笔记本 [[双链]]）经共享
 *     usePreviewRequestBridge 落为预览目标，主窗再展开右侧面板并切到 preview tab
 *     （悬浮窗由 PreviewOverlay 按目标自动露出，不动窗口宽度）。
 * （Sub-agent tab 无自动揭示信号 —— 子会话经工具栏胶囊徽标可见，由用户手动打开。）
 * 浏览器不在这里：它是独立窗口，只由用户从侧栏按钮打开；agent 开 tab 不会把它弄出来（见 browserWindowService）。
 *
 * 服务端项目若有自己的预览面板，会用它自己的等价桥替换本文件。
 */
export function useRightPanelBridge(): void {
  const isWeb = getSessionChannelApi().app.platform === 'web'

  // 预览请求 → 目标落入共享 usePreviewPanelStore
  usePreviewRequestBridge(!isWeb)

  // 主窗：预览目标就绪后展开右侧面板并切到 preview tab（悬浮窗覆盖层自动露出，无需动面板）
  const filePreviewRequest = useChatStore((s) => s.filePreviewRequest)
  useEffect(() => {
    if (!filePreviewRequest || isWeb || isPinnedWindow) return
    const browser = useBrowserStore.getState()
    browser.open()
    browser.setActiveTab('preview')
  }, [filePreviewRequest, isWeb])
}
