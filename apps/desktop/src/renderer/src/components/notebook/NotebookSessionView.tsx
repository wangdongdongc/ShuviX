import { NotebookSession, MediaUrlProvider, shuvixPreviewResolver } from '@shuvix/app-shell'
import { useSettingsStore } from '../../stores/settingsStore'

/**
 * 桌面端笔记本会话中间区正文 —— 包一层 @shuvix/app-shell 的 NotebookView，注入桌面能力
 * （笔记本主题 / 外链 / 原生右键菜单）。顶栏复用 ChatView 的 ChatHeader（本组件不含顶栏）。
 * 图片内嵌经 MediaUrlProvider 走桌面 shuvix-preview:// 协议解析。
 */
export function NotebookSessionView({
  path,
  sessionId
}: {
  path: string
  sessionId: string
}): React.JSX.Element {
  const notebookTheme = useSettingsStore((s) => s.notebookTheme)

  return (
    <MediaUrlProvider value={shuvixPreviewResolver}>
      <NotebookSession
        key={sessionId}
        path={path}
        sessionId={sessionId}
        caps={{
          notebookTheme,
          openExternal: (url) => void window.api.app.openExternal(url),
          popupContextMenu: (request) => window.api.contextMenu.popup(request)
        }}
      />
    </MediaUrlProvider>
  )
}
