import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Settings,
  Trash2,
  FolderClosed,
  FolderPlus,
  RotateCcw,
  ArrowUpCircle,
  Archive,
  MoreHorizontal,
  ChevronUp
} from 'lucide-react'
import { useChatStore, selectAllPendingCounts } from '@shuvix/chat-ui'
import { SessionItem, SessionGroup, useSessionDelete, useFocusDim } from '@shuvix/app-shell'
import { useUpdateStore } from '../../stores/updateStore'
import { usePinChatStore } from '../../stores/pinChatStore'
import { ProjectEditDialog } from './ProjectEditDialog'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SessionConfigDialog } from '../chat/SessionConfigDialog'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { CalendarView } from './CalendarView'
import type { Session } from '@shuvix/chat-ui'
import { useContextMenu } from '../../hooks/useContextMenu'

/**
 * 侧边栏 — 会话列表 + 新建对话 + 设置入口
 * 按项目（Project）分组展示
 */
const TEMP_GROUP_KEY = '__no_project__'
const ARCHIVED_GROUP_KEY = '__archived_projects__'

export function Sidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const showContextMenu = useContextMenu()
  const {
    sessions,
    activeSessionId,
    setActiveSessionId,
    sessionStreams,
    sharedSessionIds,
    telegramBindings
  } = useChatStore()
  const updateEvent = useUpdateStore((s) => s.updateEvent)
  const hasUpdate = updateEvent?.type === 'available' || updateEvent?.type === 'ready'
  const pinnedSessionIds = usePinChatStore((s) => s.pinnedSessionIds)
  /** 专注模式生效条件：开关打开 + 已选中会话 → 淡化未选中区域（共享 useFocusDim） */
  const { dim } = useFocusDim()

  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  // 删除会话全流程（检查/确认框/删除/移除）走共享 useSessionDelete，桌面/扩展同一套
  const { requestDelete: handleDelete, deleteDialog } = useSessionDelete()
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null)
  const [configuringSessionId, setConfiguringSessionId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set([TEMP_GROUP_KEY])
  )
  // 日历视图独立维护折叠状态——默认全展开（空 Set），与项目视图互不影响
  const [calendarCollapsedGroups, setCalendarCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  )
  const [viewMode, setViewMode] = useState<'projects' | 'calendar'>('projects')
  const initialCollapseApplied = useRef(false)

  // ---------- 数据源：项目列表 + 会话列表 ----------

  /** 所有项目（独立查询，不依赖 sessions） */
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [archivedProjects, setArchivedProjects] = useState<Array<{ id: string; name: string }>>([])

  const reloadProjects = async (): Promise<void> => {
    const [activeList, archivedList] = await Promise.all([
      window.api.project.list(),
      window.api.project.listArchived()
    ])
    setProjects(activeList.map((p) => ({ id: p.id, name: p.name })))
    setArchivedProjects(archivedList.map((p) => ({ id: p.id, name: p.name })))
  }

  // 加载项目列表（创建/编辑后也会刷新）+ 订阅 AppEvent 'project.changed'
  useEffect(() => {
    void reloadProjects()
    return window.api.events.subscribe((e) => {
      if (e.type === 'project.changed') void reloadProjects()
    })
  }, [editingProjectId])

  /** 项目 id → 名称 快查表 */
  const projectNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of projects) map[p.id] = p.name
    return map
  }, [projects])

  // 首次加载项目后，将所有项目组默认折叠
  useEffect(() => {
    if (initialCollapseApplied.current || projects.length === 0) return
    initialCollapseApplied.current = true
    const initial = new Set<string>(projects.map((p) => p.id))
    initial.add(TEMP_GROUP_KEY)
    if (archivedProjects.length > 0) initial.add(ARCHIVED_GROUP_KEY)
    setCollapsedGroups(initial)
  }, [projects, archivedProjects])

  // ---------- 分组逻辑：项目为骨架，会话填入 ----------

  // 当前活动会话所属的项目组 key
  const activeGroupKey = useMemo(() => {
    if (!activeSessionId) return null
    const s = sessions.find((s) => s.id === activeSessionId)
    return s?.projectId || TEMP_GROUP_KEY
  }, [activeSessionId, sessions])

  // 按项目分组：先为每个项目建空组，再将会话分配进去，最后追加临时对话组
  const computeGroups = (input: Session[]): Array<[string, Session[]]> => {
    const map = new Map<string, Session[]>()
    for (const p of projects) map.set(p.id, [])
    const tempSessions: Session[] = []
    for (const s of input) {
      if (s.projectId && map.has(s.projectId)) map.get(s.projectId)!.push(s)
      else if (!s.projectId) tempSessions.push(s)
    }
    const sorted = Array.from(map.entries()).sort(([a], [b]) => {
      const nameA = (projectNames[a] || '').toLowerCase()
      const nameB = (projectNames[b] || '').toLowerCase()
      return nameA.localeCompare(nameB, 'zh-CN')
    })
    if (tempSessions.length > 0) sorted.push([TEMP_GROUP_KEY, tempSessions])
    return sorted
  }
  const sortedGroups = useMemo(
    () => computeGroups(sessions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, projects, projectNames]
  )

  /** 恢复归档项目 */
  const handleRestoreProject = async (projectId: string): Promise<void> => {
    await window.api.project.update({ id: projectId, archived: false })
    await reloadProjects()
  }

  /** 删除归档项目（含所有关联会话和消息） */
  const doDeleteProject = async (projectId: string): Promise<void> => {
    // 如果当前活跃会话属于该项目，先切走
    const store = useChatStore.getState()
    const activeSession = store.sessions.find((s) => s.id === store.activeSessionId)
    if (activeSession?.projectId === projectId) {
      const other = store.sessions.find((s) => s.projectId !== projectId)
      if (other) store.setActiveSessionId(other.id)
    }
    await window.api.project.delete({ id: projectId })
    // 刷新会话列表（已级联删除的会话需要从 store 移除）
    const allSessions = await window.api.session.list()
    store.setSessions(allSessions)
    setDeletingProjectId(null)
    await reloadProjects()
  }

  /** 在指定项目下创建新会话 */
  const handleNewChat = async (projectId?: string | null): Promise<void> => {
    const session = await window.api.session.create(projectId ?? null)
    const allSessions = await window.api.session.list()
    useChatStore.getState().setSessions(allSessions)
    setActiveSessionId(session.id)
    // 自动展开所在项目组
    const groupKey = projectId ?? TEMP_GROUP_KEY
    setCollapsedGroups((prev) => {
      if (!prev.has(groupKey)) return prev
      const next = new Set(prev)
      next.delete(groupKey)
      return next
    })
  }

  /** 打开文件夹并将其创建为项目（若已存在同路径项目则直接复用），随后新建会话 */
  const handleOpenFolder = async (): Promise<void> => {
    const folder = await window.electron.ipcRenderer.invoke('dialog:openDirectory')
    if (!folder) return
    const existing = (await window.api.project.list()).find((p) => p.path === folder)
    const projectId = existing?.id ?? (await window.api.project.create({ path: folder })).id
    // 防止「首次加载项目默认折叠」副作用在导航后把新项目组重新折叠
    initialCollapseApplied.current = true
    await reloadProjects()
    await handleNewChat(projectId)
  }

  /** 切换会话；若该会话已悬浮，则同时把悬浮窗拉到前台 */
  const handleSelectSession = (id: string): void => {
    setActiveSessionId(id)
    if (pinnedSessionIds.has(id)) {
      void window.api.pinChat.focus(id)
    }
  }

  /** 切换分组折叠状态 */
  const toggleGroup = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 切换日历视图分组折叠状态（独立于项目视图） */
  const toggleCalendarGroup = (key: string): void => {
    setCalendarCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 全局 pending 输入计数(供脉冲指示器) */
  const allPendingCounts = useChatStore(selectAllPendingCounts)

  /** 渲染单个会话项（复用共享 SessionItem，注入桌面专属能力：pin/分享/Telegram/配置/右键菜单） */
  const renderSessionItem = (session: Session): React.JSX.Element => {
    // 仅当会话位于活动项目组、且不是当前选中会话时才逐项淡化；
    // 非活动项目组已由外层 groupDim 统一淡化，避免 opacity 叠加导致过透明。
    const sessionGroupKey = session.projectId || TEMP_GROUP_KEY
    const sessionDim = dim && activeGroupKey === sessionGroupKey
    return (
      <SessionItem
        key={session.id}
        session={session}
        active={activeSessionId === session.id}
        isStreaming={sessionStreams[session.id]?.isStreaming}
        pendingCount={allPendingCounts[session.id]}
        dim={sessionDim}
        isPinned={pinnedSessionIds.has(session.id)}
        isShared={sharedSessionIds.has(session.id)}
        isTelegramBound={telegramBindings.has(session.id)}
        onSelect={handleSelectSession}
        onDelete={handleDelete}
        onConfigure={(id) => setConfiguringSessionId(id)}
        onContextMenu={(id, e) => {
          e.preventDefault()
          e.stopPropagation()
          showContextMenu(
            [
              { id: 'session-config', label: t('sessionConfig.title') },
              { id: 'sep', label: '', type: 'separator' },
              { id: 'delete-session', label: t('sidebar.deleteSession') }
            ],
            (actionId) => {
              if (actionId === 'session-config') setConfiguringSessionId(id)
              if (actionId === 'delete-session') handleDelete(id)
            }
          )
        }}
      />
    )
  }

  /**
   * 渲染按项目分组的会话列表（项目视图 + 日历视图共用）
   * - hideEmptyGroups: 日历视图下传 true，过滤掉当日无会话的项目组
   */
  const renderGroupedSessions = (
    groups: Array<[string, Session[]]>,
    options: {
      hideEmptyGroups?: boolean
      collapseState?: { collapsed: Set<string>; toggle: (key: string) => void }
    } = {}
  ): React.ReactNode => {
    const visible = options.hideEmptyGroups ? groups.filter(([, s]) => s.length > 0) : groups
    const collapseSet = options.collapseState?.collapsed ?? collapsedGroups
    const collapseToggle = options.collapseState?.toggle ?? toggleGroup
    return visible.map(([groupKey, groupSessions], idx) => {
      const collapsed = collapseSet.has(groupKey)
      const isTemp = groupKey === TEMP_GROUP_KEY
      const groupLabel = isTemp
        ? t('sidebar.tempChats')
        : projectNames[groupKey] || t('sidebar.unnamedProject')
      const showDividerAbove = isTemp && idx > 0
      // 非活动项目组在专注模式下整组淡化（含 header + 折叠内会话）；
      // 活动项目组保持原状，由 renderSessionItem 内的逐项 dim 处理非选中会话。
      const groupDim = dim && activeGroupKey !== groupKey
      return (
        <SessionGroup
          key={groupKey}
          label={groupLabel}
          variant={isTemp ? 'temp' : 'project'}
          collapsed={collapsed}
          onToggle={() => collapseToggle(groupKey)}
          onNewChat={() => handleNewChat(isTemp ? null : groupKey)}
          active={activeGroupKey === groupKey}
          dim={groupDim}
          showDividerAbove={showDividerAbove}
          onEdit={isTemp ? undefined : () => setEditingProjectId(groupKey)}
          onHeaderContextMenu={(e: React.MouseEvent) => {
            e.preventDefault()
            e.stopPropagation()
            const items = [
              { id: 'new-chat', label: t('sidebar.newChat') },
              ...(!isTemp ? [{ id: 'edit-project', label: t('sidebar.editProject') }] : [])
            ]
            showContextMenu(items, (actionId) => {
              if (actionId === 'new-chat') handleNewChat(isTemp ? null : groupKey)
              if (actionId === 'edit-project') setEditingProjectId(groupKey)
            })
          }}
        >
          {groupSessions.map(renderSessionItem)}
        </SessionGroup>
      )
    })
  }

  // 监听菜单栏「新建对话 / 新建项目」
  useEffect(() => {
    const cleanupChat = window.api.app.onNewChat(() => {
      const active = sessions.find((s) => s.id === activeSessionId)
      handleNewChat(active?.projectId ?? null)
    })
    const cleanupProject = window.api.app.onNewProject(() => {
      void handleOpenFolder()
    })
    return () => {
      cleanupChat()
      cleanupProject()
    }
  }) // 每次 render 重新绑定以捕获最新 sessions/activeSessionId

  /** 已归档项目：固定在侧栏底部，列表在标题之上 → 点击标题从下向上展开 */
  const renderArchivedSection = (): React.JSX.Element | null => {
    if (archivedProjects.length === 0) return null
    const collapsed = collapsedGroups.has(ARCHIVED_GROUP_KEY)
    return (
      <div
        className={`flex-shrink-0 border-t border-border-secondary/30 px-2 pt-1 transition-opacity duration-200 ${
          dim ? 'opacity-30 hover:opacity-100' : ''
        }`}
      >
        {/* 列表在上：展开时向上生长，最多占一定高度后内部滚动 */}
        <AnimatedCollapse open={!collapsed}>
          <div className="ml-1.5 pl-0.5 max-h-48 overflow-y-auto no-scrollbar">
            {archivedProjects.map((p) => (
              <div
                key={p.id}
                className="group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 text-text-secondary"
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  showContextMenu(
                    [
                      { id: 'restore-project', label: t('sidebar.restoreProject') },
                      { id: 'sep', label: '', type: 'separator' },
                      { id: 'delete-project', label: t('sidebar.deleteProject') }
                    ],
                    (actionId) => {
                      if (actionId === 'restore-project') void handleRestoreProject(p.id)
                      if (actionId === 'delete-project') setDeletingProjectId(p.id)
                    }
                  )
                }}
              >
                <FolderClosed size={11} className="flex-shrink-0" />
                <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[13px] group-hover:pr-6">
                  <span className="truncate">{p.name}</span>
                </div>
                <div className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
                  <button
                    onClick={() => void handleRestoreProject(p.id)}
                    className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/60 hover:text-text-secondary"
                    title={t('sidebar.restoreProject')}
                  >
                    <RotateCcw size={11} className="text-green-400/70" />
                  </button>
                  <button
                    onClick={() => setDeletingProjectId(p.id)}
                    className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/60 hover:text-red-400"
                    title={t('sidebar.deleteProject')}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </AnimatedCollapse>
        {/* 标题在下 */}
        <div className="flex items-center w-full px-1.5 py-0.5 text-[12px] group/header">
          <button
            onClick={() => toggleGroup(ARCHIVED_GROUP_KEY)}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-text-secondary hover:text-text-primary transition-colors"
          >
            <Archive size={11} className="flex-shrink-0" />
            <span className="truncate font-medium uppercase tracking-wider">
              {t('sidebar.archivedProjects')}
            </span>
            <ChevronUp
              size={11}
              className={`ml-auto flex-shrink-0 text-text-tertiary/60 transition-transform ${
                collapsed ? '' : 'rotate-180'
              }`}
            />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-bg-secondary/50">
      {/* 窗口拖拽区 + 标题（macOS 为交通灯留出顶部空间） */}
      <div
        className={`titlebar-drag flex items-center pl-3 pr-2 pb-2 transition-opacity duration-200 ${window.api.app.platform === 'darwin' ? 'pt-10' : 'pt-3'} ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
      >
        <h1 className="text-[13px] font-medium text-text-tertiary tracking-wide uppercase">
          {viewMode === 'calendar' ? t('sidebar.viewCalendar') : t('sidebar.title')}
        </h1>
        <div className="titlebar-no-drag ml-auto flex items-center">
          <button
            onClick={() => void handleOpenFolder()}
            title={t('sidebar.newProject')}
            className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={() =>
              showContextMenu(
                [
                  {
                    id: 'view-projects',
                    label:
                      viewMode === 'projects'
                        ? `✓ ${t('sidebar.viewProjects')}`
                        : `   ${t('sidebar.viewProjects')}`
                  },
                  {
                    id: 'view-calendar',
                    label:
                      viewMode === 'calendar'
                        ? `✓ ${t('sidebar.viewCalendar')}`
                        : `   ${t('sidebar.viewCalendar')}`
                  }
                ],
                (id) => {
                  if (id === 'view-projects') setViewMode('projects')
                  if (id === 'view-calendar') setViewMode('calendar')
                }
              )
            }
            title={t('sidebar.switchView')}
            className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto pl-2 pr-1 py-1 no-scrollbar">
        {viewMode === 'calendar' ? (
          <CalendarView
            renderGroupedSessionsForDay={(daySessions) =>
              renderGroupedSessions(computeGroups(daySessions), {
                hideEmptyGroups: true,
                collapseState: {
                  collapsed: calendarCollapsedGroups,
                  toggle: toggleCalendarGroup
                }
              })
            }
          />
        ) : sessions.length === 0 &&
          Object.keys(projectNames).length === 0 &&
          archivedProjects.length === 0 ? (
          <div className="px-3 py-8 text-center text-text-tertiary text-xs">
            {t('sidebar.emptyHint')}
          </div>
        ) : (
          renderGroupedSessions(sortedGroups)
        )}
      </div>

      {/* 已归档项目：固定在底部，点击从下向上展开（列表在上、标题在下） */}
      {viewMode === 'projects' && renderArchivedSection()}

      {/* 底部操作区 */}
      <div
        className={`flex items-center gap-1 px-2 py-1 border-t border-border-secondary/30 transition-opacity duration-200 ${
          dim ? 'opacity-30 hover:opacity-100' : ''
        }`}
      >
        <button
          onClick={() => window.api.app.openSettings()}
          className="flex items-center gap-2 flex-1 pl-3 pr-2 py-1.5 rounded-md text-[13px] text-text-tertiary hover:bg-bg-hover/60 hover:text-text-secondary transition-colors"
        >
          <Settings size={14} className="text-text-tertiary/70" />
          <span>{t('sidebar.settings')}</span>
        </button>
        {hasUpdate && (
          <button
            onClick={() => window.api.app.openSettings('about')}
            className="flex-shrink-0 p-1.5 rounded-md text-accent/80 hover:bg-accent/10 hover:text-accent transition-colors"
            title={
              updateEvent?.type === 'ready'
                ? t('sidebar.updateReady')
                : t('sidebar.updateAvailable')
            }
          >
            <ArrowUpCircle size={14} />
          </button>
        )}
      </div>

      {/* 项目编辑弹窗 */}
      {editingProjectId && (
        <ProjectEditDialog projectId={editingProjectId} onClose={() => setEditingProjectId(null)} />
      )}

      {/* 会话配置弹窗 */}
      {configuringSessionId && (
        <SessionConfigDialog
          sessionId={configuringSessionId}
          onClose={() => setConfiguringSessionId(null)}
        />
      )}

      {/* 删除会话确认弹窗（共享 useSessionDelete 渲染） */}
      {deleteDialog}

      {/* 删除项目确认弹窗 */}
      {deletingProjectId && (
        <ConfirmDialog
          title={t('sidebar.confirmDeleteProject')}
          description={
            <>
              {t('sidebar.deleteProjectWarning')}
              <span className="text-error font-medium">
                {t('sidebar.deleteProjectWarningBold')}
              </span>
              {t('sidebar.deleteProjectWarningEnd')}
            </>
          }
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => void doDeleteProject(deletingProjectId)}
          onCancel={() => setDeletingProjectId(null)}
        />
      )}
    </div>
  )
}
