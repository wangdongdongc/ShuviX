import { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquarePlus, Settings, Trash2, Pencil, ChevronDown, ChevronRight, FolderPlus } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { SessionEditDialog } from './SessionEditDialog'
import { ProjectEditDialog } from './ProjectEditDialog'
import { ProjectCreateDialog } from './ProjectCreateDialog'
import type { Session } from '../stores/chatStore'

/**
 * 侧边栏 — 会话列表 + 新建对话 + 设置入口
 * 按项目（Project）分组展示
 */
const TEMP_GROUP_KEY = '__no_project__'

export function Sidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const { sessions, activeSessionId, setActiveSessionId, sessionStreams } = useChatStore()
  const [editingSession, setEditingSession] = useState<Session | null>(null)
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // 项目名称/路径缓存
  const [projectNames, setProjectNames] = useState<Record<string, string>>({})

  // 异步加载项目名称
  useEffect(() => {
    window.api.project.list().then((projects) => {
      const nameMap: Record<string, string> = {}
      for (const p of projects) {
        nameMap[p.id] = p.name
      }
      setProjectNames(nameMap)
    })
  }, [sessions, editingProjectId])

  // 按 projectId 分组
  const grouped = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      const key = s.projectId || TEMP_GROUP_KEY
      const arr = map.get(key) || []
      arr.push(s)
      map.set(key, arr)
    }
    return map
  }, [sessions])

  // 对分组排序：项目按名称升序，临时对话始终放最后
  const sortedGroups = useMemo(() => {
    const entries = Array.from(grouped.entries())
    return entries.sort(([keyA], [keyB]) => {
      if (keyA === TEMP_GROUP_KEY) return 1
      if (keyB === TEMP_GROUP_KEY) return -1
      const nameA = (projectNames[keyA] || '').toLowerCase()
      const nameB = (projectNames[keyB] || '').toLowerCase()
      return nameA.localeCompare(nameB, 'zh-CN')
    })
  }, [grouped, projectNames])

  /** 在指定项目下创建新会话 */
  const handleNewChat = async (projectId?: string | null): Promise<void> => {
    const settings = useSettingsStore.getState()
    const session = await window.api.session.create({
      provider: settings.activeProvider,
      model: settings.activeModel,
      systemPrompt: settings.systemPrompt,
      projectId: projectId ?? null
    })
    const allSessions = await window.api.session.list()
    useChatStore.getState().setSessions(allSessions)
    setActiveSessionId(session.id)
  }

  /** 切换会话 */
  const handleSelectSession = (id: string): void => {
    setActiveSessionId(id)
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

  /** 渲染单个会话项 */
  const renderSessionItem = (session: Session): React.JSX.Element => (
    <div
      key={session.id}
      onClick={() => handleSelectSession(session.id)}
      className={`group flex items-center gap-2 px-3 py-1.5 rounded-lg mb-px cursor-pointer transition-colors ${
        activeSessionId === session.id
          ? 'bg-bg-active text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[11px]">
        <span className="truncate">{session.title}</span>
        {sessionStreams[session.id]?.isStreaming && (
          <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
        )}
      </div>
      <div className="hidden group-hover:flex items-center gap-0.5">
        <button
          onClick={(e) => {
            e.stopPropagation()
            setEditingSession(session)
          }}
          className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-text-secondary"
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            handleDelete(session.id)
          }}
          className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-error"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col h-full bg-bg-secondary border-r border-border-secondary">
      {/* macOS 窗口拖拽区 + 标题 */}
      <div className="titlebar-drag flex items-center justify-between px-4 pt-10 pb-3">
        <h1 className="text-sm font-semibold text-text-primary tracking-tight">{t('sidebar.title')}</h1>
        <button
          onClick={() => setShowCreateProject(true)}
          className="titlebar-no-drag p-1.5 rounded-lg hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
          title={t('sidebar.newProject')}
        >
          <FolderPlus size={18} />
        </button>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {sessions.length === 0 ? (
          <div className="px-3 py-8 text-center text-text-tertiary text-xs">
            {t('sidebar.emptyHint')}
          </div>
        ) : (
          /* 按项目分组展示（项目按名称排序，临时对话始终最后） */
          sortedGroups.map(([groupKey, groupSessions]) => {
            const collapsed = collapsedGroups.has(groupKey)
            const isTemp = groupKey === TEMP_GROUP_KEY
            const groupLabel = isTemp ? t('sidebar.tempChats') : (projectNames[groupKey] || t('sidebar.unnamedProject'))
            return (
              <div key={groupKey} className="mb-2">
                <div className={`flex items-center w-full px-2 py-2 rounded-md text-[13px] group/header ${
                  isTemp
                    ? 'bg-bg-tertiary/30 text-text-tertiary border-l-2 border-border-secondary'
                    : 'bg-bg-tertiary/50 text-text-primary border-l-2 border-accent/60'
                }`}>
                  <button
                    onClick={() => toggleGroup(groupKey)}
                    className="flex items-center gap-2 flex-1 min-w-0 hover:text-text-primary transition-colors"
                  >
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span className={`truncate ${isTemp ? 'font-normal' : 'font-semibold'}`}>{groupLabel}</span>
                  </button>
                  {/* 项目操作按钮 */}
                  <div className="flex items-center gap-1 opacity-0 group-hover/header:opacity-100 transition-all">
                    {/* 新建对话 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleNewChat(isTemp ? null : groupKey)
                      }}
                      className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-text-secondary"
                      title={t('sidebar.newChat')}
                    >
                      <MessageSquarePlus size={13} />
                    </button>
                    {/* 编辑项目（临时对话组不显示） */}
                    {!isTemp && (
                      <button
                        onClick={() => setEditingProjectId(groupKey)}
                        className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-text-secondary"
                        title={t('sidebar.editProject')}
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                  </div>
                </div>
                {!collapsed && (
                  <div className={isTemp
                    ? 'ml-1.5 border-l border-border-secondary/30 pl-1'
                    : 'ml-1.5 border-l border-border-secondary/50 pl-1'
                  }>
                    {groupSessions.map(renderSessionItem)}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* 底部设置按钮 */}
      <div className="p-3 border-t border-border-secondary">
        <button
          onClick={() => window.api.app.openSettings()}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
        >
          <Settings size={16} />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>

      {/* 会话编辑弹窗 */}
      {editingSession && (
        <SessionEditDialog
          session={editingSession}
          onClose={() => setEditingSession(null)}
        />
      )}

      {/* 项目编辑弹窗 */}
      {editingProjectId && (
        <ProjectEditDialog
          projectId={editingProjectId}
          onClose={() => setEditingProjectId(null)}
        />
      )}

      {/* 删除会话确认弹窗 */}
      {deletingSessionId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[340px] max-w-[90vw]">
            <div className="px-5 py-4">
              <h3 className="text-sm font-semibold text-text-primary mb-2">{t('sidebar.confirmDelete')}</h3>
              <p className="text-xs text-text-secondary leading-relaxed">
                {t('sidebar.deleteWarning')}<span className="text-error font-medium">{t('sidebar.deleteWarningBold')}</span>{t('sidebar.deleteWarningEnd')}
              </p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-secondary">
              <button
                onClick={() => setDeletingSessionId(null)}
                className="px-4 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => doDelete(deletingSessionId)}
                className="px-4 py-1.5 rounded-lg text-xs bg-error text-white hover:bg-error/90 transition-colors"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建项目弹窗 */}
      {showCreateProject && (
        <ProjectCreateDialog
          onClose={() => setShowCreateProject(false)}
          onCreated={async (projectId) => {
            // 刷新项目名称缓存
            const projects = await window.api.project.list()
            const map: Record<string, string> = {}
            for (const p of projects) { map[p.id] = p.name }
            setProjectNames(map)
            // 自动在新项目下创建一个会话
            await handleNewChat(projectId)
          }}
        />
      )}
    </div>
  )
}
