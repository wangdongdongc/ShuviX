import { NotebookSession, MediaUrlProvider } from '@shuvix/app-shell'
import { useChatStore } from '@shuvix/chat-ui'
import { parseSessionLink } from '@shuvix/chat-protocol/dailyNotes'
import { useSettingsStore } from '../../stores/settingsStore'
import { usePinChatStore } from '../../stores/pinChatStore'
import { hostMediaResolver } from '../../host/hostMedia'
import { useCoEditing } from './coEdit/useCoEditing'
import { CoEditIndicator } from './coEdit/CoEditIndicator'

/**
 * 笔记本里点中的链接：`shuvix://session/<id>[#<entryId>]`（日报里插入的会话）在应用里打开那条会话，
 * 带 entryId 就跳到那条消息；会话已经不在就什么也不做。别的链接照旧交给系统。
 */
function openNotebookLink(url: string): void {
  const target = parseSessionLink(url)
  if (!target) {
    void window.api.app.openExternal(url)
    return
  }
  const store = useChatStore.getState()
  if (!store.sessions.some((s) => s.id === target.sessionId)) return
  store.setActiveSessionId(target.sessionId)
  if (usePinChatStore.getState().pinnedSessionIds.has(target.sessionId)) {
    void window.api.pinChat.focus(target.sessionId)
  }
  if (target.entryId) store.requestScrollToMessage(target.sessionId, target.entryId)
}

/**
 * 桌面端笔记本会话中间区正文 —— 包一层 @shuvix/app-shell 的 NotebookView，注入桌面能力
 * （笔记本主题 / 外链 / 原生右键菜单）。顶栏复用 ChatView 的 ChatHeader（本组件不含顶栏）。
 * 图片内嵌经 MediaUrlProvider 走桌面 shuvix-preview:// 协议解析。
 *
 * 每个笔记本都是协作编辑（useCoEditing）：根档案 `notebook` 的 agent 经 doc_* 工具直接在这个编辑器的
 * 缓冲上改 —— 写参数时就有虚影，执行时一次落下，不进 ⌘Z；外部写盘（含编辑器没开着时 doc_* 落到磁盘上的
 * 改动）三方合并，不重挂载编辑器。钩子的会话 id 只在挂载时取一次：调用方按会话 id 给本组件 key。
 */
export function NotebookSessionView({
  path,
  sessionId
}: {
  path: string
  sessionId: string
}): React.JSX.Element {
  const notebookTheme = useSettingsStore((s) => s.notebookTheme)
  const coEdit = useCoEditing(sessionId)

  return (
    <MediaUrlProvider value={hostMediaResolver}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <NotebookSession
          key={sessionId}
          path={path}
          sessionId={sessionId}
          caps={{
            notebookTheme,
            openExternal: openNotebookLink,
            popupContextMenu: (request) => window.api.contextMenu.popup(request)
          }}
          editorHandleRef={coEdit.editorRef}
          extraExtensions={coEdit.extensions}
          onExternalChange={coEdit.onExternalChange}
        />
        <CoEditIndicator state={coEdit.indicator} onReveal={coEdit.reveal} />
      </div>
    </MediaUrlProvider>
  )
}
