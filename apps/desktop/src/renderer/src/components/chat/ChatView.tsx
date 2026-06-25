import { getChatApi } from '@shuvix/chat-ui'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PictureInPicture2, Pin, PinOff, X } from 'lucide-react'
import { useChatStore } from '@shuvix/chat-ui'
import { useBrowserStore } from '../../stores/browserStore'
import { useSidebarStore } from '../../stores/sidebarStore'
import { WelcomeView, ChatHeader, PanelToggleButton } from '@shuvix/app-shell'
import { EmptySessionHint } from './WelcomeView'
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
  const { activeSessionId } = useChatStore()

  const [showSessionConfig, setShowSessionConfig] = useState(false)

  const toggleBrowser = useBrowserStore((s) => s.toggle)
  const isBrowserOpen = useBrowserStore((s) => s.isOpen)
  const toggleSidebar = useSidebarStore((s) => s.toggle)
  const isSidebarOpen = useSidebarStore((s) => s.isOpen)

  const isWeb = getChatApi().app.platform === 'web'

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

  /** 顶栏右侧按钮簇（桌面专属：pin/悬浮/浏览器/侧栏开关），按模式切换 */
  const rightActions =
    pinnedMode === 'floating' ? (
      <>
        <button
          onClick={handleToggleAlwaysOnTop}
          className={`p-1 rounded-md transition-colors ${
            alwaysOnTop
              ? 'text-accent hover:text-accent hover:bg-accent/10'
              : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50'
          }`}
          title={alwaysOnTop ? t('pinChat.disableAlwaysOnTop') : t('pinChat.enableAlwaysOnTop')}
        >
          {alwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}
        </button>
        <PanelToggleButton
          side="right"
          open={isBrowserOpen}
          onClick={toggleBrowser}
          title={t('panel.files')}
        />
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
        {!isWeb && <PanelToggleButton side="left" open={isSidebarOpen} onClick={toggleSidebar} />}
        <PanelToggleButton side="right" open={isBrowserOpen} onClick={toggleBrowser} />
      </>
    )

  return (
    <div className="relative flex flex-col h-full">
      <ChatHeader
        caps={{
          windowDrag: true,
          editableTitle: !isWeb,
          folder: true,
          sessionConfig: !isWeb
        }}
        heightClassName={getChatApi().app.platform === 'darwin' ? 'h-10' : 'h-8'}
        onOpenSessionConfig={() => setShowSessionConfig(true)}
        rightActions={rightActions}
      />

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
