import { useState, useMemo, useEffect } from 'react'
import { MessageSquarePlus, Settings, Trash2, Pencil, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { SessionEditDialog } from './SessionEditDialog'
import { ProjectEditDialog } from './ProjectEditDialog'
import type { Session } from '../stores/chatStore'

/**
 * 侧边栏 — 会话列表 + 新建对话 + 设置入口
 * 按项目（Project）分组展示
 */
const TEMP_GROUP_KEY = '__no_project__'

export function Sidebar(): React.JSX.Element {
  const { sessions, activeSessionId, setActiveSessionId, sessionStreams } = useChatStore()
  const [editingSession, setEditingSession] = useState<Session | null>(null)
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // 项目名称缓存：projectId → name
  const [projectNames, setProjectNames] = useState<Record<string, string>>({})

  // 异步加载项目名称
  useEffect(() => {
    window.api.project.list().then((projects) => {
      const map: Record<string, string> = {}
      for (const p of projects) { map[p.id] = p.name }
      setProjectNames(map)
    })
  }, [sessions])

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

  const showGroups = grouped.size > 1

  // 获取当前活跃会话的 projectId（新建对话时继承）
  const activeProjectId = useMemo(() => {
    const active = sessions.find((s) => s.id === activeSessionId)
    return active?.projectId ?? null
  }, [sessions, activeSessionId])

  /** 创建新会话（继承当前项目） */
  const handleNewChat = async (): Promise<void> => {
    const settings = useSettingsStore.getState()
    const session = await window.api.session.create({
      provider: settings.activeProvider,
      model: settings.activeModel,
      systemPrompt: settings.systemPrompt,
      projectId: activeProjectId
    })
    const allSessions = await window.api.session.list()
    useChatStore.getState().setSessions(allSessions)
    setActiveSessionId(session.id)
  }

  /** 切换会话 */
  const handleSelectSession = (id: string): void => {
    setActiveSessionId(id)
  }

  /** 删除会话 */
  const handleDelete = async (id: string): Promise<void> => {
    await window.api.session.delete(id)
    useChatStore.getState().removeSession(id)
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

  /** 格式化时间 */
  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return '今天'
    if (diffDays === 1) return '昨天'
    if (diffDays < 7) return `${diffDays}天前`
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
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
          <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-accent animate-pulse" title="正在生成" />
        )}
        <span className="flex-shrink-0 ml-auto text-[9px] text-text-tertiary group-hover:hidden">
          {formatTime(session.updatedAt)}
        </span>
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
        <h1 className="text-sm font-semibold text-text-primary tracking-tight">ShiroBot</h1>
        <button
          onClick={handleNewChat}
          className="titlebar-no-drag p-1.5 rounded-lg hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
          title="新建对话"
        >
          <MessageSquarePlus size={18} />
        </button>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {sessions.length === 0 ? (
          <div className="px-3 py-8 text-center text-text-tertiary text-xs">
            点击上方按钮开始新对话
          </div>
        ) : showGroups ? (
          /* 按项目分组展示 */
          Array.from(grouped.entries()).map(([groupKey, groupSessions]) => {
            const collapsed = collapsedGroups.has(groupKey)
            const isTemp = groupKey === TEMP_GROUP_KEY
            const groupLabel = isTemp ? '临时对话' : (projectNames[groupKey] || '未命名项目')
            return (
              <div key={groupKey} className="mb-1">
                <div className="flex items-center w-full px-2 py-2 text-xs text-text-secondary group/header">
                  <button
                    onClick={() => toggleGroup(groupKey)}
                    className="flex items-center gap-1.5 flex-1 min-w-0 hover:text-text-primary transition-colors"
                  >
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <FolderOpen size={12} />
                    <span className="truncate font-semibold">{groupLabel}</span>
                    <span className="ml-1 text-[10px] text-text-tertiary font-normal">{groupSessions.length}</span>
                  </button>
                  {/* 项目编辑入口（临时对话组不显示） */}
                  {!isTemp && (
                    <button
                      onClick={() => setEditingProjectId(groupKey)}
                      className="opacity-0 group-hover/header:opacity-100 p-0.5 rounded hover:bg-bg-active text-text-tertiary hover:text-text-secondary transition-all"
                      title="编辑项目"
                    >
                      <Pencil size={9} />
                    </button>
                  )}
                </div>
                {!collapsed && groupSessions.map(renderSessionItem)}
              </div>
            )
          })
        ) : (
          /* 不分组，平铺展示 */
          sessions.map(renderSessionItem)
        )}
      </div>

      {/* 底部设置按钮 */}
      <div className="p-3 border-t border-border-secondary">
        <button
          onClick={() => window.api.app.openSettings()}
          className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
        >
          <Settings size={16} />
          <span>设置</span>
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
    </div>
  )
}
