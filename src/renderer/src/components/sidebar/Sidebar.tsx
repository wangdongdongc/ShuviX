import { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MessageSquarePlus,
  MessageSquare,
  Settings,
  Trash2,
  Settings2,
  FolderClosed,
  FolderOpen,
  Globe,
  MessageCircle,
  RotateCcw,
  ArrowUpCircle,
  Archive,
  MoreHorizontal,
  PictureInPicture2
} from 'lucide-react'
import { useChatStore, selectAllPendingCounts } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUpdateStore } from '../../stores/updateStore'
import { usePinChatStore } from '../../stores/pinChatStore'
import { ProjectEditDialog } from './ProjectEditDialog'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { SessionConfigDialog } from '../chat/SessionConfigDialog'
import { AnimatedCollapse } from '../common/AnimatedCollapse'
import { CalendarView } from './CalendarView'
import type { Session } from '../../stores/chatStore'
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
  const focusMode = useSettingsStore((s) => s.focusMode)
  /** 专注模式生效条件：开关打开 + 已选中会话 → 淡化未选中区域 */
  const dim = focusMode && !!activeSessionId

  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
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

  // 加载项目列表（创建/编辑后也会刷新）+ 监听后端 project:changed 事件
  useEffect(() => {
    void reloadProjects() // eslint-disable-line react-hooks/set-state-in-effect
    const unsubscribe = window.api.project.onChanged(() => {
      void reloadProjects()
    })
    return unsubscribe
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
    setCollapsedGroups(initial) // eslint-disable-line react-hooks/set-state-in-effect
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

  /** 切换会话；若该会话已悬浮，则同时把悬浮窗拉到前台 */
  const handleSelectSession = (id: string): void => {
    setActiveSessionId(id)
    if (pinnedSessionIds.has(id)) {
      void window.api.pinChat.focus(id)
    }
  }

  /** 删除会话（有消息时先确认） */
  const handleDelete = async (id: string): Promise<void> => {
    const msgs = await window.api.message.list(id)
    if (msgs.length > 0) {
      setDeletingSessionId(id)
      return
    }
    await doDelete(id)
  }

  /** 执行删除 */
  const doDelete = async (id: string): Promise<void> => {
    await window.api.session.delete(id)
    useChatStore.getState().removeSession(id)
    setDeletingSessionId(null)
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

  /** 渲染单个会话项 */
  const renderSessionItem = (session: Session): React.JSX.Element => {
    // 仅当会话位于活动项目组、且不是当前选中会话时才逐项淡化；
    // 非活动项目组已由外层 groupDim 统一淡化，避免 opacity 叠加导致过透明。
    const sessionGroupKey = session.projectId || TEMP_GROUP_KEY
    const sessionDim = dim && activeGroupKey === sessionGroupKey
    return (
      <div
        key={session.id}
        onClick={() => handleSelectSession(session.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          showContextMenu(
            [
              { id: 'session-config', label: t('sessionConfig.title') },
              { id: 'sep', label: '', type: 'separator' },
              { id: 'delete-session', label: t('sidebar.deleteSession') }
            ],
            (actionId) => {
              if (actionId === 'session-config') setConfiguringSessionId(session.id)
              if (actionId === 'delete-session') handleDelete(session.id)
            }
          )
        }}
        className={`group relative flex items-center gap-1.5 pl-2.5 pr-1.5 py-0.5 cursor-pointer transition-opacity duration-200 ${
          activeSessionId === session.id
            ? 'bg-bg-active/80 text-text-primary'
            : `text-text-secondary hover:bg-bg-hover/50 hover:text-text-primary ${sessionDim ? 'opacity-30 hover:opacity-100' : ''}`
        }`}
      >
        {pinnedSessionIds.has(session.id) ? (
          <PictureInPicture2
            size={11}
            className={`flex-shrink-0 ${
              sessionStreams[session.id]?.isStreaming ? 'text-accent animate-pulse' : 'text-accent'
            }`}
          />
        ) : (
          <MessageSquare
            size={11}
            fill={
              activeSessionId === session.id || sessionStreams[session.id]?.isStreaming
                ? 'currentColor'
                : 'none'
            }
            className={`flex-shrink-0 ${
              sessionStreams[session.id]?.isStreaming
                ? 'text-accent animate-pulse'
                : activeSessionId === session.id
                  ? 'text-accent'
                  : 'text-text-tertiary/40'
            }`}
          />
        )}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[13px] group-hover:pr-6">
          <span className="truncate">{session.title}</span>
          {sharedSessionIds.has(session.id) && <Globe size={10} className="text-accent shrink-0" />}
          {telegramBindings.has(session.id) && (
            <MessageCircle size={10} className="text-blue-500 shrink-0" />
          )}
          {/* 待处理用户输入提醒:脉冲圆点 + 计数 */}
          {allPendingCounts[session.id] > 0 && (
            <span className="flex items-center gap-1 ml-auto shrink-0">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-400" />
              </span>
              <span className="text-[9px] text-amber-400 font-semibold tabular-nums">
                {allPendingCounts[session.id]}
              </span>
            </span>
          )}
        </div>
        <div className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setConfiguringSessionId(session.id)
            }}
            className="p-0.5 rounded hover:bg-bg-active text-text-tertiary hover:text-text-secondary"
            title={t('sessionConfig.title')}
          >
            <Settings2 size={11} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              handleDelete(session.id)
            }}
            className="p-0.5 rounded hover:bg-bg-active text-text-tertiary hover:text-error"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
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
        <div
          key={groupKey}
          className={`transition-opacity duration-200 ${groupDim ? 'opacity-30 hover:opacity-100' : ''}`}
        >
          {showDividerAbove && <div className="mx-4 my-2 border-t border-border-secondary/30" />}
          <div
            className={`mb-0.5 rounded-md ${activeGroupKey === groupKey ? 'bg-bg-primary/30' : ''}`}
          >
            <div
              className="relative flex items-center w-full px-1.5 py-0.5 text-[12px] group/header"
              onContextMenu={(e) => {
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
              <button
                onClick={() => collapseToggle(groupKey)}
                className={`flex items-center gap-1.5 flex-1 min-w-0 transition-colors group-hover/header:pr-7 ${
                  activeGroupKey === groupKey
                    ? 'text-text-primary'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {isTemp ? (
                  <MessageCircle size={12} className="flex-shrink-0" />
                ) : collapsed ? (
                  <FolderClosed size={12} className="flex-shrink-0" />
                ) : (
                  <FolderOpen size={12} className="flex-shrink-0" />
                )}
                <span className="truncate font-medium uppercase tracking-wider">{groupLabel}</span>
              </button>
              <div className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity duration-100">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleNewChat(isTemp ? null : groupKey)
                  }}
                  className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/50 hover:text-text-secondary"
                  title={t('sidebar.newChat')}
                >
                  <MessageSquarePlus size={11} />
                </button>
                {!isTemp && (
                  <button
                    onClick={() => setEditingProjectId(groupKey)}
                    className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary/50 hover:text-text-secondary"
                    title={t('sidebar.editProject')}
                  >
                    <Settings2 size={12} />
                  </button>
                )}
              </div>
            </div>
            <AnimatedCollapse open={!collapsed}>
              <div className="ml-1.5 pl-0.5">{groupSessions.map(renderSessionItem)}</div>
            </AnimatedCollapse>
          </div>
        </div>
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
      setShowCreateProject(true)
    })
    return () => {
      cleanupChat()
      cleanupProject()
    }
  }) // 每次 render 重新绑定以捕获最新 sessions/activeSessionId

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
          <>
            {/* 按项目分组展示（项目按名称排序，临时对话始终最后） */}
            {renderGroupedSessions(sortedGroups)}

            {/* 已归档项目 */}
            {archivedProjects.length > 0 && (
              <>
                {sortedGroups.length > 0 && (
                  <div className="mx-4 my-2 border-t border-border-secondary/30" />
                )}
                <div
                  className={`mb-0.5 rounded-md transition-opacity duration-200 ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
                >
                  <div className="flex items-center w-full px-1.5 py-0.5 text-[12px] group/header">
                    <button
                      onClick={() => toggleGroup(ARCHIVED_GROUP_KEY)}
                      className="flex items-center gap-1.5 flex-1 min-w-0 text-text-secondary hover:text-text-primary transition-colors"
                    >
                      <Archive size={11} className="flex-shrink-0" />
                      <span className="truncate font-medium uppercase tracking-wider">
                        {t('sidebar.archivedProjects')}
                      </span>
                    </button>
                  </div>
                  <AnimatedCollapse open={!collapsedGroups.has(ARCHIVED_GROUP_KEY)}>
                    <div className="ml-1.5 pl-0.5">
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
                </div>
              </>
            )}
          </>
        )}
      </div>

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

      {/* 删除会话确认弹窗 */}
      {deletingSessionId && (
        <ConfirmDialog
          title={t('sidebar.confirmDelete')}
          description={
            <>
              {t('sidebar.deleteWarning')}
              <span className="text-error font-medium">{t('sidebar.deleteWarningBold')}</span>
              {t('sidebar.deleteWarningEnd')}
            </>
          }
          confirmText={t('common.delete')}
          cancelText={t('common.cancel')}
          onConfirm={() => doDelete(deletingSessionId)}
          onCancel={() => setDeletingSessionId(null)}
        />
      )}

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

      {/* 新建项目弹窗 */}
      {showCreateProject && (
        <ProjectCreateDialog
          onClose={() => setShowCreateProject(false)}
          onCreated={async (projectId) => {
            // 刷新项目列表
            await reloadProjects()
            // 自动在新项目下创建一个会话
            await handleNewChat(projectId)
          }}
        />
      )}
    </div>
  )
}
