import { useState } from 'react'
import { MessageSquarePlus, Settings, Trash2, Pencil, Check, X } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * 侧边栏 — 会话列表 + 新建对话 + 设置入口
 */
export function Sidebar(): React.JSX.Element {
  const { sessions, activeSessionId, setActiveSessionId } = useChatStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  /** 创建新会话 */
  const handleNewChat = async (): Promise<void> => {
    const settings = useSettingsStore.getState()
    const session = await window.api.session.create({
      provider: settings.activeProvider,
      model: settings.activeModel,
      systemPrompt: settings.systemPrompt
    })
    // 刷新会话列表
    const sessions = await window.api.session.list()
    useChatStore.getState().setSessions(sessions)
    setActiveSessionId(session.id)
  }

  /** 切换会话 */
  const handleSelectSession = (id: string): void => {
    if (editingId) return
    setActiveSessionId(id)
  }

  /** 开始编辑会话标题 */
  const handleStartEdit = (id: string, currentTitle: string): void => {
    setEditingId(id)
    setEditTitle(currentTitle)
  }

  /** 保存编辑 */
  const handleSaveEdit = async (): Promise<void> => {
    if (!editingId || !editTitle.trim()) return
    await window.api.session.updateTitle({ id: editingId, title: editTitle.trim() })
    useChatStore.getState().updateSessionTitle(editingId, editTitle.trim())
    setEditingId(null)
  }

  /** 删除会话 */
  const handleDelete = async (id: string): Promise<void> => {
    await window.api.session.delete(id)
    useChatStore.getState().removeSession(id)
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
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => handleSelectSession(session.id)}
              className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg mb-0.5 cursor-pointer transition-colors ${
                activeSessionId === session.id
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {editingId === session.id ? (
                /* 编辑模式 */
                <div className="flex-1 flex items-center gap-1">
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveEdit()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="flex-1 bg-bg-primary border border-border-primary rounded px-2 py-0.5 text-xs text-text-primary outline-none focus:border-accent"
                    autoFocus
                  />
                  <button onClick={handleSaveEdit} className="p-0.5 text-success">
                    <Check size={14} />
                  </button>
                  <button onClick={() => setEditingId(null)} className="p-0.5 text-text-tertiary">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                /* 正常模式 */
                <>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{session.title}</div>
                    <div className="text-[10px] text-text-tertiary mt-0.5">
                      {formatTime(session.updatedAt)}
                    </div>
                  </div>
                  <div className="hidden group-hover:flex items-center gap-0.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleStartEdit(session.id, session.title)
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
                </>
              )}
            </div>
          ))
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
    </div>
  )
}
