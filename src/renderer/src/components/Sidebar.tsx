import { useState, useMemo } from 'react'
import { MessageSquarePlus, Settings, Trash2, Pencil, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { SessionEditDialog } from './SessionEditDialog'
import type { Session } from '../stores/chatStore'

/**
 * 侧边栏 — 会话列表 + 新建对话 + 设置入口
 */
/** 判断是否为 ShiroBot 创建的临时目录 */
const TEMP_GROUP_KEY = '__temp__'
function isTempDirectory(p: string): boolean {
  return p.includes('shirobot-sessions')
}

/** 缩短目录路径显示 */
function shortenPath(p: string): string {
  if (!p) return '未分类'
  const parts = p.replace(/\\/g, '/').split('/')
  if (parts.length <= 3) return p
  return `…/${parts.slice(-2).join('/')}`
}

export function Sidebar(): React.JSX.Element {
  const { sessions, activeSessionId, setActiveSessionId, sessionStreams } = useChatStore()
  const [editingSession, setEditingSession] = useState<Session | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; files: string[]; total: number } | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // 按工作目录分组，临时目录统一归类为“临时对话”
  const grouped = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      const key = s.workingDirectory && isTempDirectory(s.workingDirectory)
        ? TEMP_GROUP_KEY
        : (s.workingDirectory || '')
      const arr = map.get(key) || []
      arr.push(s)
      map.set(key, arr)
    }
    return map
  }, [sessions])

  // 是否需要分组显示（多于一个分组 或 唯一分组有多个 session）
  const showGroups = grouped.size > 1

  /** 创建新会话 */
  const handleNewChat = async (): Promise<void> => {
    const settings = useSettingsStore.getState()
    const session = await window.api.session.create({
      provider: settings.activeProvider,
      model: settings.activeModel,
      systemPrompt: settings.systemPrompt
    })
    const allSessions = await window.api.session.list()
    useChatStore.getState().setSessions(allSessions)
    setActiveSessionId(session.id)
  }

  /** 切换会话 */
  const handleSelectSession = (id: string): void => {
    setActiveSessionId(id)
  }

  /** 删除会话（先检查临时目录内容） */
  const handleDelete = async (id: string): Promise<void> => {
    const session = sessions.find((s) => s.id === id)
    if (!session) return

    // 检查工作目录是否非空
    if (session.workingDirectory) {
      const result = await window.api.session.checkDirContents(session.workingDirectory)
      if (result.exists && !result.isEmpty) {
        setDeleteConfirm({ id, files: result.files, total: result.totalCount })
        return
      }
    }
    // 目录为空或不存在，直接删除并清理
    await window.api.session.delete(id, true)
    useChatStore.getState().removeSession(id)
  }

  /** 确认删除（含清理目录） */
  const confirmDelete = async (cleanDir: boolean): Promise<void> => {
    if (!deleteConfirm) return
    await window.api.session.delete(deleteConfirm.id, cleanDir)
    useChatStore.getState().removeSession(deleteConfirm.id)
    setDeleteConfirm(null)
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
      className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg mb-0.5 cursor-pointer transition-colors ${
        activeSessionId === session.id
          ? 'bg-bg-active text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <span className="truncate">{session.title}</span>
          {sessionStreams[session.id]?.isStreaming && (
            <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-accent animate-pulse" title="正在生成" />
          )}
        </div>
        <div className="text-[10px] text-text-tertiary mt-0.5">
          {formatTime(session.updatedAt)}
        </div>
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
          /* 分组展示 */
          Array.from(grouped.entries()).map(([dirKey, groupSessions]) => {
            const collapsed = collapsedGroups.has(dirKey)
            return (
              <div key={dirKey} className="mb-1">
                <button
                  onClick={() => toggleGroup(dirKey)}
                  className="flex items-center gap-1 w-full px-2 py-1.5 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                  <FolderOpen size={10} />
                  <span className="truncate font-medium">
                    {dirKey === TEMP_GROUP_KEY ? '临时对话' : shortenPath(dirKey)}
                  </span>
                  <span className="ml-auto text-text-tertiary">{groupSessions.length}</span>
                </button>
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

      {/* 删除确认弹窗（工作目录非空时） */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-bg-primary border border-border-primary rounded-xl shadow-xl w-[380px] max-w-[90vw] p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-2">删除会话</h3>
            <p className="text-xs text-text-secondary mb-3">
              该会话的工作目录不为空，包含 {deleteConfirm.total} 个文件/文件夹：
            </p>
            <div className="bg-bg-secondary rounded-lg p-2 mb-3 max-h-32 overflow-y-auto">
              {deleteConfirm.files.map((f) => (
                <div key={f} className="text-[10px] text-text-tertiary font-mono truncate py-0.5">
                  {f}
                </div>
              ))}
              {deleteConfirm.total > deleteConfirm.files.length && (
                <div className="text-[10px] text-text-tertiary">…还有 {deleteConfirm.total - deleteConfirm.files.length} 项</div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => confirmDelete(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                仅删除会话
              </button>
              <button
                onClick={() => confirmDelete(true)}
                className="px-3 py-1.5 rounded-lg text-xs bg-error text-white hover:bg-error/90 transition-colors"
              >
                删除会话和目录
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
