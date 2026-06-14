import { getChatApi, useChatHost } from '@shuvix/chat-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, Settings2, PictureInPicture2, Pin, PinOff, X } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import { useBrowserStore } from '../../stores/browserStore'
import { useSidebarStore } from '../../stores/sidebarStore'
import { useSessionMeta } from '@shuvix/chat-ui'
import { WelcomeView, EmptySessionHint } from './WelcomeView'
import { StatusBanner } from './StatusBanner'
import { SessionConfigDialog } from './SessionConfigDialog'
import { Conversation } from '@shuvix/chat-ui'

/**
 * 聊天主视图（桌面/WebUI 外壳）—— 标题栏 + 侧边栏/浏览器开关 + 状态横幅 + 会话配置，
 * 正文对话区委托给可复用的 <Conversation>。
 *
 * pinnedMode:
 * - undefined: 默认主窗口形态
 * - 'floating': 在悬浮窗口里渲染，header 精简为标题 + 文件夹 + 关闭 X
 * - 'placeholder': 当前会话已被悬浮，正文替换为占位提示（恢复 / 聚焦悬浮窗）
 */
interface ChatViewProps {
  pinnedMode?: 'floating' | 'placeholder'
}

export function ChatView({ pinnedMode }: ChatViewProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSessionId, sessions } = useChatStore()

  const { projectPath } = useSessionMeta()
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const sessionTitle = activeSession?.title || null

  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [showSessionConfig, setShowSessionConfig] = useState(false)

  const toggleBrowser = useBrowserStore((s) => s.toggle)
  const isBrowserOpen = useBrowserStore((s) => s.isOpen)
  const toggleSidebar = useSidebarStore((s) => s.toggle)
  const isSidebarOpen = useSidebarStore((s) => s.isOpen)

  /** 悬浮窗"始终置顶"状态 —— 仅 floating 模式下使用 */
  const [alwaysOnTop, setAlwaysOnTopState] = useState(true)
  useEffect(() => {
    if (pinnedMode !== 'floating' || !activeSessionId) return
    let cancelled = false
    getChatApi()
      .pinChat.getAlwaysOnTop(activeSessionId)
      .then(({ alwaysOnTop }) => {
        if (!cancelled) setAlwaysOnTopState(alwaysOnTop)
      })
    return () => {
      cancelled = true
    }
  }, [pinnedMode, activeSessionId])
  const handleToggleAlwaysOnTop = useCallback(async () => {
    if (!activeSessionId) return
    const next = !alwaysOnTop
    const { alwaysOnTop: applied } = await getChatApi().pinChat.setAlwaysOnTop({
      sessionId: activeSessionId,
      value: next
    })
    setAlwaysOnTopState(applied)
  }, [activeSessionId, alwaysOnTop])

  const focusMode = useChatHost().appearance.focusMode
  /** 专注模式生效条件：开关打开 + 已选中会话 */
  const dim = focusMode && !!activeSessionId

  /** 开始编辑会话标题 */
  const startEditTitle = (): void => {
    if (!sessionTitle || !activeSessionId) return
    setDraftTitle(sessionTitle)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  /** 提交会话标题修改 */
  const commitEditTitle = async (): Promise<void> => {
    setEditingTitle(false)
    const trimmed = draftTitle.trim()
    if (!trimmed || !activeSessionId || trimmed === sessionTitle) return
    await getChatApi().session.updateTitle({ id: activeSessionId, title: trimmed })
    useChatStore.getState().updateSessionTitle(activeSessionId, trimmed)
  }

  return (
    <div className="relative flex flex-col h-full">
      {/* 窗口拖拽区 + 会话标题栏（单行布局） */}
      <div
        className={`titlebar-drag flex-shrink-0 flex items-center px-2 transition-opacity duration-200 ${getChatApi().app.platform === 'darwin' ? 'h-10' : 'h-8'} ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
      >
        {/* 左侧：会话名 + 会话设置 + 工作目录（容器不加 no-drag，剩余空间可拖动） */}
        <div className="flex items-center gap-0.5 min-w-0 flex-1">
          {sessionTitle &&
            (editingTitle && getChatApi().app.platform !== 'web' ? (
              <input
                ref={titleInputRef}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={() => void commitEditTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitEditTitle()
                  if (e.key === 'Escape') setEditingTitle(false)
                }}
                className="titlebar-no-drag bg-transparent text-xs font-medium text-text-primary outline-none border-b border-accent/50 px-2 py-0.5 min-w-0 flex-shrink"
                autoFocus
              />
            ) : getChatApi().app.platform !== 'web' ? (
              <button
                onClick={startEditTitle}
                className="titlebar-no-drag text-xs font-medium text-text-secondary hover:text-text-primary transition-colors px-2 py-0.5 rounded-md hover:bg-bg-hover/50 truncate min-w-0"
                title={t('common.clickToEdit')}
              >
                {sessionTitle}
              </button>
            ) : (
              <span className="text-xs font-medium text-text-secondary px-2 py-0.5 truncate min-w-0">
                {sessionTitle}
              </span>
            ))}
          {sessionTitle && getChatApi().app.platform !== 'web' && (
            <button
              onClick={() => setShowSessionConfig(true)}
              className="titlebar-no-drag p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors flex-shrink-0"
              title={t('sessionConfig.title')}
            >
              <Settings2 size={12} />
            </button>
          )}
          {projectPath && (
            <button
              onClick={() => getChatApi().app.openFolder(projectPath)}
              className="titlebar-no-drag p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors flex-shrink-0"
              title={projectPath}
            >
              <Folder size={12} />
            </button>
          )}
        </div>

        {/* 右侧：按模式渲染不同按钮簇 */}
        <div className="titlebar-no-drag flex items-center gap-0.5 flex-shrink-0">
          {pinnedMode === 'floating' ? (
            <>
              <button
                onClick={handleToggleAlwaysOnTop}
                className={`p-1 rounded-md transition-colors ${
                  alwaysOnTop
                    ? 'text-accent hover:text-accent hover:bg-accent/10'
                    : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50'
                }`}
                title={
                  alwaysOnTop ? t('pinChat.disableAlwaysOnTop') : t('pinChat.enableAlwaysOnTop')
                }
              >
                {alwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}
              </button>
              <button
                onClick={toggleBrowser}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                title={t('panel.files')}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M15 3v18" />
                  {isBrowserOpen && (
                    <rect
                      x="15"
                      y="3"
                      width="6"
                      height="18"
                      rx="2"
                      fill="currentColor"
                      stroke="none"
                    />
                  )}
                </svg>
              </button>
              <button
                onClick={() => activeSessionId && void getChatApi().pinChat.unpin(activeSessionId)}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                title={t('pinChat.unpin')}
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              {pinnedMode !== 'placeholder' && activeSessionId && (
                <button
                  onClick={() => void getChatApi().pinChat.pin(activeSessionId)}
                  className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                  title={t('pinChat.pin')}
                >
                  <PictureInPicture2 size={14} />
                </button>
              )}
              {getChatApi()?.app?.platform !== 'web' && (
                <button
                  onClick={toggleSidebar}
                  className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <path d="M9 3v18" />
                    {isSidebarOpen && (
                      <rect
                        x="3"
                        y="3"
                        width="6"
                        height="18"
                        rx="2"
                        fill="currentColor"
                        stroke="none"
                      />
                    )}
                  </svg>
                </button>
              )}
              <button
                onClick={toggleBrowser}
                className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M15 3v18" />
                  {isBrowserOpen && (
                    <rect
                      x="15"
                      y="3"
                      width="6"
                      height="18"
                      rx="2"
                      fill="currentColor"
                      stroke="none"
                    />
                  )}
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {activeSessionId && pinnedMode !== 'placeholder' && (
        <StatusBanner sessionId={activeSessionId} />
      )}

      {pinnedMode === 'placeholder' ? (
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="flex flex-col items-center gap-4 text-center max-w-sm">
            <PictureInPicture2 size={36} className="text-text-tertiary/60" />
            <div className="text-sm text-text-secondary">{t('pinChat.placeholderTitle')}</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => activeSessionId && void getChatApi().pinChat.focus(activeSessionId)}
                className="px-3 py-1.5 text-xs rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
              >
                {t('pinChat.focusFloating')}
              </button>
              <button
                onClick={() => activeSessionId && void getChatApi().pinChat.unpin(activeSessionId)}
                className="px-3 py-1.5 text-xs rounded-md bg-bg-hover/60 text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('pinChat.restoreHere')}
              </button>
            </div>
          </div>
        </div>
      ) : !activeSessionId ? (
        <WelcomeView />
      ) : (
        <Conversation
          sessionId={activeSessionId}
          emptyState={<EmptySessionHint sessionId={activeSessionId} />}
        />
      )}

      {/* 会话配置弹窗（WebUI 中不显示） */}
      {getChatApi().app.platform !== 'web' && showSessionConfig && activeSessionId && (
        <SessionConfigDialog
          sessionId={activeSessionId}
          onClose={() => setShowSessionConfig(false)}
        />
      )}
    </div>
  )
}
