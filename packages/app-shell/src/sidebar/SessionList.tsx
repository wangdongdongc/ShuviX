/**
 * SessionList —— 扁平会话列表（新建 + 列表），供扩展整页侧栏用（无项目分组）。
 * 数据读 chat-ui 的 chatStore（sessions/activeSessionId/sessionStreams/pending），与 Conversation 同源。
 */
import { MessageSquarePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore, selectAllPendingCounts } from '@shuvix/chat-ui'
import { SessionItem } from './SessionItem'
import { useContextMenu } from '../contextmenu/ContextMenuProvider'

export interface SessionListProps {
  onNew: () => void
  /** 选中会话（缺省用 chatStore.setActiveSessionId） */
  onSelect?: (id: string) => void
  onDelete?: (id: string) => void
}

export function SessionList({ onNew, onSelect, onDelete }: SessionListProps): React.JSX.Element {
  const { t } = useTranslation()
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const sessionStreams = useChatStore((s) => s.sessionStreams)
  const pendingCounts = useChatStore(selectAllPendingCounts)
  const handleSelect = onSelect ?? setActiveSessionId
  const showContextMenu = useContextMenu()

  // 行动作全在菜单里（右键 / 行尾 ⋮），这里只有删除一项 —— 宿主没注入删除就没有菜单
  const openMenu = (id: string, e: React.MouseEvent): void => {
    void showContextMenu(e, [{ id: 'delete-session', label: t('sidebar.deleteSession') }], () =>
      onDelete?.(id)
    )
  }

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      <div className="p-2">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
        >
          <MessageSquarePlus size={14} />
          {t('sidebar.newChat')}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-text-tertiary">
            {t('sidebar.noSessions')}
          </div>
        ) : (
          sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={activeSessionId === s.id}
              isStreaming={sessionStreams[s.id]?.isStreaming}
              pendingCount={pendingCounts[s.id]}
              autoAllow={s.settings.autoAllow === true}
              onSelect={handleSelect}
              onMenu={onDelete ? openMenu : undefined}
            />
          ))
        )}
      </div>
    </div>
  )
}
