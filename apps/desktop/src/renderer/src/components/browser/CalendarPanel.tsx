import { useState } from 'react'
import { getChatApi, useChatStore, type Session } from '@shuvix/chat-ui'
import {
  CalendarView,
  ProjectSessionGroups,
  SessionConfigDialog,
  useProjects,
  useSessionDelete
} from '@shuvix/app-shell'
import { useBrowserStore } from '../../stores/browserStore'
import { usePinChatStore } from '../../stores/pinChatStore'

/**
 * 日历面板 —— Right panel 的 Calendar tab 内容（原侧栏日历视图迁移至此，左侧栏只保留
 * 项目视图）。月历 + 选中日的项目-会话分组，宽度跟随面板（CalendarView 按容器宽自适应；
 * 面板拖宽没有侧栏那样的 isResizing 态，重 layout 优化不适用）。
 * 会话点击/删除/配置与侧栏同款语义；两个对话框在本面板内自持。
 */
export function CalendarPanel(): React.JSX.Element {
  const { projects } = useProjects()
  const width = useBrowserStore((s) => s.width)
  const pinnedSessionIds = usePinChatStore((s) => s.pinnedSessionIds)
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const { requestDelete: handleDelete, deleteDialog } = useSessionDelete()
  const [configuringSessionId, setConfiguringSessionId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  /** 选中会话；若已悬浮则同时把悬浮窗拉到前台（同侧栏） */
  const handleSelect = (id: string): void => {
    setActiveSessionId(id)
    if (pinnedSessionIds.has(id)) void window.api.pinChat.focus(id)
  }

  const handleNewChat = async (projectId: string | null): Promise<void> => {
    const session = await getChatApi().session.create({ projectId: projectId ?? null })
    useChatStore.getState().setSessions(await getChatApi().session.list())
    setActiveSessionId(session.id)
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary overflow-hidden">
      <div className="flex-1 overflow-y-auto pl-2 pr-2 py-1 no-scrollbar">
        <CalendarView
          width={width}
          renderGroupedSessionsForDay={(daySessions: Session[]) => (
            <ProjectSessionGroups
              projects={projects}
              sessionsOverride={daySessions}
              hideEmptyGroups
              collapsed={collapsed}
              onToggleGroup={(key) =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(key)) next.delete(key)
                  else next.add(key)
                  return next
                })
              }
              onNewChat={(pid) => void handleNewChat(pid)}
              onSelect={handleSelect}
              onDelete={handleDelete}
              onConfigureSession={setConfiguringSessionId}
              caps={{ pin: true }}
              pinnedSessionIds={pinnedSessionIds}
            />
          )}
        />
      </div>
      {configuringSessionId && (
        <SessionConfigDialog
          sessionId={configuringSessionId}
          onClose={() => setConfiguringSessionId(null)}
        />
      )}
      {deleteDialog}
    </div>
  )
}
