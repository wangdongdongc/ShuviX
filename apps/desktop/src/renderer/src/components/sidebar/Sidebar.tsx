import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpCircle } from 'lucide-react'
import { getChatApi, useChatStore, type Session } from '@shuvix/chat-ui'
import {
  Sidebar as SharedSidebar,
  ProjectSessionGroups,
  CalendarView,
  ViewSwitchButton,
  WikiView,
  useProjects,
  useSessionDelete,
  SessionConfigDialog,
  type SidebarViewMode
} from '@shuvix/app-shell'
import { useUpdateStore } from '../../stores/updateStore'
import { usePinChatStore } from '../../stores/pinChatStore'
import { useSidebarStore } from '../../stores/sidebarStore'
import { ProjectEditDialog } from './ProjectEditDialog'

/**
 * 桌面侧边栏 —— 薄封装共享 <Sidebar>，注入桌面专属能力：
 *   - 窗口拖拽 / 置顶徽标 / 分享·Telegram 徽标（caps）
 *   - 打开文件夹走 Electron 目录对话框；置顶会话选中时聚焦悬浮窗
 *   - 会话/分组右键菜单由共享组件统一渲染（桌面经 ContextMenuProvider 注入原生渲染器）
 *   - 会话配置弹窗、项目编辑弹窗；标题行视图切换（项目 / 日历，原生菜单）
 *   - 底部更新提示；日历视图经 bodyOverride 复用 ProjectSessionGroups
 *   - 归档项目的恢复 / 删除已移至「设置 → Projects → 已归档」
 */
export function Sidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const { projects } = useProjects()
  const pinnedSessionIds = usePinChatStore((s) => s.pinnedSessionIds)
  const updateEvent = useUpdateStore((s) => s.updateEvent)
  const hasUpdate = updateEvent?.type === 'available' || updateEvent?.type === 'ready'
  const sidebarWidth = useSidebarStore((s) => s.width)
  const sidebarResizing = useSidebarStore((s) => s.isResizing)
  const { requestDelete: handleDelete, deleteDialog } = useSessionDelete()

  const [viewMode, setViewMode] = useState<SidebarViewMode>('projects')
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [configuringSessionId, setConfiguringSessionId] = useState<string | null>(null)
  const [calendarCollapsed, setCalendarCollapsed] = useState<Set<string>>(() => new Set())

  // 在指定项目下新建会话（日历视图 + 文件夹流程用）
  const handleNewChat = async (projectId: string | null): Promise<void> => {
    const session = await getChatApi().session.create({ projectId: projectId ?? null })
    useChatStore.getState().setSessions(await getChatApi().session.list())
    setActiveSessionId(session.id)
  }

  /** 打开文件夹并创建为项目（已存在同路径则复用），随后新建会话 */
  const handleOpenFolder = async (): Promise<void> => {
    const folder = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (!folder) return
    const existing = (await getChatApi().project.list()).find((p) => p.path === folder)
    const projectId = existing?.id ?? (await getChatApi().project.create({ path: folder })).id
    await handleNewChat(projectId)
  }

  /** 选中会话；若已悬浮则同时把悬浮窗拉到前台 */
  const handleSelectSession = (id: string): void => {
    setActiveSessionId(id)
    if (pinnedSessionIds.has(id)) void window.api.pinChat.focus(id)
  }

  const listWikiFiles = useCallback(() => window.api.wiki.listFiles(), [])

  /** 打开 wiki 笔记：一文件至多一笔记本会话（main 侧去重），刷新列表并选中 */
  const handleOpenWikiNote = useCallback(
    async (relPath: string): Promise<void> => {
      const session = await window.api.wiki.openNote({ path: relPath })
      useChatStore.getState().setSessions(await getChatApi().session.list())
      setActiveSessionId(session.id)
    },
    [setActiveSessionId]
  )

  return (
    <SharedSidebar
      caps={{ windowDrag: true, pin: true }}
      title={
        viewMode === 'calendar'
          ? t('sidebar.viewCalendar')
          : viewMode === 'wiki'
            ? t('sidebar.viewWiki')
            : t('sidebar.title')
      }
      projects={projects}
      pinnedSessionIds={pinnedSessionIds}
      onOpenFolder={handleOpenFolder}
      onOpenSettings={(tab) => void getChatApi().app.openSettings(tab)}
      onSelectSession={handleSelectSession}
      onDeleteSession={handleDelete}
      onConfigureSession={setConfiguringSessionId}
      onEditProject={setEditingProjectId}
      titleActions={
        <ViewSwitchButton
          viewMode={viewMode}
          onChange={setViewMode}
          modes={['projects', 'calendar', 'wiki']}
        />
      }
      footerActions={
        hasUpdate ? (
          <button
            onClick={() => void getChatApi().app.openSettings('about')}
            className="flex-shrink-0 p-1.5 rounded-md text-accent/80 hover:bg-accent/10 hover:text-accent transition-colors"
            title={
              updateEvent?.type === 'ready'
                ? t('sidebar.updateReady')
                : t('sidebar.updateAvailable')
            }
          >
            <ArrowUpCircle size={14} />
          </button>
        ) : undefined
      }
      bodyOverride={
        viewMode === 'wiki' ? (
          <WikiView listFiles={listWikiFiles} onSelectFile={handleOpenWikiNote} />
        ) : viewMode === 'calendar' ? (
          <CalendarView
            width={sidebarWidth}
            isResizing={sidebarResizing}
            renderGroupedSessionsForDay={(daySessions: Session[]) => (
              <ProjectSessionGroups
                projects={projects}
                sessionsOverride={daySessions}
                hideEmptyGroups
                collapsed={calendarCollapsed}
                onToggleGroup={(key) =>
                  setCalendarCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    return next
                  })
                }
                onNewChat={(pid) => void handleNewChat(pid)}
                onSelect={handleSelectSession}
                onDelete={handleDelete}
                onConfigureSession={setConfiguringSessionId}
                caps={{ pin: true }}
                pinnedSessionIds={pinnedSessionIds}
              />
            )}
          />
        ) : undefined
      }
      overlays={
        <>
          {editingProjectId && (
            <ProjectEditDialog
              projectId={editingProjectId}
              onClose={() => setEditingProjectId(null)}
            />
          )}
          {configuringSessionId && (
            <SessionConfigDialog
              sessionId={configuringSessionId}
              onClose={() => setConfiguringSessionId(null)}
            />
          )}
          {deleteDialog}
        </>
      }
    />
  )
}
