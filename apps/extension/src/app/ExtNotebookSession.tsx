import { NotebookSession, MediaUrlProvider, usePopupContextMenu } from '@shuvix/app-shell'
import { extMediaResolver } from './RightPanel'

/**
 * 扩展端笔记本会话正文 —— 包一层共享 NotebookSession 并注入扩展能力：
 * 外链经 window.open；右键菜单经 usePopupContextMenu 接到内置 DOM 弹层（与侧栏同一套渲染器）。
 * 须在 <ContextMenuProvider> 之内渲染（usePopupContextMenu 读其渲染器）。
 * 图片内嵌经 MediaUrlProvider 走扩展 blob: 解析。
 */
export function ExtNotebookSession({
  path,
  sessionId
}: {
  path: string
  sessionId: string
}): React.JSX.Element {
  const popupContextMenu = usePopupContextMenu()

  return (
    <MediaUrlProvider value={extMediaResolver}>
      <NotebookSession
        key={sessionId}
        path={path}
        sessionId={sessionId}
        caps={{
          openExternal: (u) => window.open(u, '_blank'),
          popupContextMenu
        }}
      />
    </MediaUrlProvider>
  )
}
