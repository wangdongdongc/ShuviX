import { getSessionChannelApi, getHostApi } from '@shuvix/chat-ui'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PictureInPicture2, Pin, PinOff, X } from 'lucide-react'
import { selectActiveBot, useChatStore } from '@shuvix/chat-ui'
import { useBrowserStore } from '../../stores/browserStore'
import { useSidebarStore } from '../../stores/sidebarStore'
import { useBottomPanelStore } from '../../stores/bottomPanelStore'
import { useTerminalStore } from '../../stores/terminalStore'
// 会话面板真源在 @shuvix/app-shell；经桌面接线文件导入以确保宽度持久化订阅被加载
import '../../stores/sessionPanelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  WelcomeView,
  ChatBody,
  FilesPanel,
  MediaUrlProvider,
  PanelToggleButton,
  PreviewPanel,
  SessionConfigDialog,
  SessionPanel,
  SessionToolbar,
  shuvixPreviewResolver,
  StatusBanner,
  useSessionPanelReveal
} from '@shuvix/app-shell'
import { EmptySessionHint } from './WelcomeView'
import { BotMembersBar } from './BotMembersBar'
import { NotebookSessionView } from '../notebook/NotebookSessionView'
import { BotPage } from '../bots/BotPage'

/**
 * 聊天主视图（桌面外壳）—— 经共享 <ChatBody> 渲染顶栏 + 欢迎/笔记本/对话三态，
 * 桌面专属的状态横幅 / 会话配置弹窗 / 悬浮窗占位经其插槽注入。
 *
 * pinnedMode:
 * - undefined: 默认主窗口形态
 * - 'floating': 在悬浮窗口里渲染，header 精简为标题 + 置顶 +（有子代理时）右面板开关 + 关闭 X
 * - 'placeholder': 当前会话已被悬浮，正文替换为占位提示（恢复 / 聚焦悬浮窗）
 */
interface ChatViewProps {
  pinnedMode?: 'floating' | 'placeholder'
}

export function ChatView({ pinnedMode }: ChatViewProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSessionId } = useChatStore()
  // bot 档案页（侧栏「Bots」分组点开）：与会话互斥的主区目标，正文经 contentOverride 顶掉
  // 欢迎页 —— 此时 activeSessionId 为空，会话面板 / 横幅 / 成员条随之自然不渲染
  const activeBot = useChatStore(selectActiveBot)
  const [showSessionConfig, setShowSessionConfig] = useState(false)

  const toggleBrowser = useBrowserStore((s) => s.toggle)
  const isBrowserOpen = useBrowserStore((s) => s.isOpen)
  const toggleSidebar = useSidebarStore((s) => s.toggle)
  const isSidebarOpen = useSidebarStore((s) => s.isOpen)
  const isBottomOpen = useBottomPanelStore((s) => s.isOpen)
  /** 顶栏「底部栏（终端）」开关：首次打开且无终端时自动新建一个 */
  const toggleBottomPanel = useCallback(() => {
    const bottom = useBottomPanelStore.getState()
    if (!bottom.isOpen && useTerminalStore.getState().tabs.length === 0) {
      useTerminalStore.getState().createTab(useChatStore.getState().projectPath || undefined)
    }
    bottom.toggle()
  }, [])

  const isWeb = getSessionChannelApi().app.platform === 'web'
  const isMac = getSessionChannelApi().app.platform === 'darwin'

  // 揭示信号 → 会话面板（子智能体注册切 Sub-agent；共享 hook）。
  // 悬浮占位态不响应。文件预览：主窗由右侧面板承接（useRightPanelBridge），
  // 悬浮窗无 app 级右面板 → 会话面板的 Preview 工具页承接（previewInPanel）。
  const isFloating = pinnedMode === 'floating'
  useSessionPanelReveal(!isWeb && pinnedMode !== 'placeholder', isFloating)

  /** 悬浮窗 Preview 工具页的 markdown 宿主能力（主题 / 外链）—— 与右侧面板 Preview tab 同源 */
  const notebookTheme = useSettingsStore((s) => s.notebookTheme)
  const floatingPreviewContent = useMemo(
    () =>
      isFloating ? (
        <PreviewPanel
          notebookCaps={{
            notebookTheme,
            openExternal: (url: string) => void window.api.app.openExternal(url)
          }}
        />
      ) : undefined,
    [isFloating, notebookTheme]
  )

  /** 悬浮窗"始终置顶"状态 —— 仅 floating 模式下使用 */
  const [alwaysOnTop, setAlwaysOnTopState] = useState(true)
  useEffect(() => {
    if (pinnedMode !== 'floating' || !activeSessionId) return
    let cancelled = false
    getHostApi()
      ?.pinChat.getAlwaysOnTop(activeSessionId)
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
    const res = await getHostApi()?.pinChat.setAlwaysOnTop({
      sessionId: activeSessionId,
      value: next
    })
    if (res) setAlwaysOnTopState(res.alwaysOnTop)
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
        <button
          onClick={() => activeSessionId && void getHostApi()?.pinChat.unpin(activeSessionId)}
          className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
          title={t('pinChat.unpin')}
        >
          <X size={14} />
        </button>
      </>
    ) : (
      <>
        {/* 聊天会话：成员胶囊列 + 管理入口（自空,非 bot 会话不渲染） */}
        {!isWeb && pinnedMode !== 'placeholder' && activeSessionId && (
          <BotMembersBar sessionId={activeSessionId} />
        )}
        {!isWeb && pinnedMode !== 'placeholder' && activeSessionId && (
          <button
            onClick={() => void getHostApi()?.pinChat.pin(activeSessionId)}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
            title={t('pinChat.pin')}
          >
            <PictureInPicture2 size={14} />
          </button>
        )}
        {!isWeb && <PanelToggleButton side="left" open={isSidebarOpen} onClick={toggleSidebar} />}
        {/* 底部栏（终端）—— 宿主能力，缺省则隐藏切换按钮 */}
        {!isWeb && (
          <PanelToggleButton
            side="bottom"
            open={isBottomOpen}
            onClick={toggleBottomPanel}
            title={t('panel.terminal')}
          />
        )}
        {/* 右侧面板（浏览器/文件/子代理）属宿主能力，缺省则隐藏切换按钮 */}
        {!isWeb && <PanelToggleButton side="right" open={isBrowserOpen} onClick={toggleBrowser} />}
      </>
    )

  // 悬浮窗 placeholder：会话已被悬浮，正文替换为「聚焦悬浮窗 / 恢复到此处」占位
  const placeholder =
    pinnedMode === 'placeholder' ? (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <PictureInPicture2 size={36} className="text-text-tertiary/60" />
          <div className="text-sm text-text-secondary">{t('pinChat.placeholderTitle')}</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => activeSessionId && void getHostApi()?.pinChat.focus(activeSessionId)}
              className="px-3 py-1.5 text-xs rounded-md bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
            >
              {t('pinChat.focusFloating')}
            </button>
            <button
              onClick={() => activeSessionId && void getHostApi()?.pinChat.unpin(activeSessionId)}
              className="px-3 py-1.5 text-xs rounded-md bg-bg-hover/60 text-text-secondary hover:bg-bg-hover transition-colors"
            >
              {t('pinChat.restoreHere')}
            </button>
          </div>
        </div>
      </div>
    ) : undefined

  return (
    <ChatBody
      headerCaps={{
        windowDrag: true,
        editableTitle: !isWeb,
        sessionConfig: !isWeb,
        // macOS 主窗为 hiddenInset：交通灯常驻窗口左上角。侧边栏展开时它落在侧边栏上（侧边栏的
        // pt-10 已为其留白），收起后顶栏顶到窗口左缘 → 标题会被交通灯压住，故此时改由顶栏留白。
        // 悬浮窗为 frame:false，无交通灯 → 不留。
        macTrafficLights: isMac && !isFloating && !isSidebarOpen
      }}
      headerHeightClassName={isMac ? 'h-10' : 'h-8'}
      onOpenSessionConfig={() => setShowSessionConfig(true)}
      rightActions={rightActions}
      // 会话面板（共享组件）：媒体/PDF 走桌面 shuvix-preview:// 协议，
      // Files 内容注入桌面 caps（.md 预览可「创建笔记本」/ 系统文件管理器打开目录）
      sessionPanel={
        !isWeb ? (
          <MediaUrlProvider value={shuvixPreviewResolver}>
            <SessionPanel
              sessionId={activeSessionId}
              filesContent={<FilesPanel onOpenFolder={(p) => void window.api.app.openFolder(p)} />}
              previewContent={floatingPreviewContent}
            />
          </MediaUrlProvider>
        ) : undefined
      }
      banner={
        // 会话工具栏靠右并入这条横幅：它原先悬浮在正文右上角，会压住右对齐的用户气泡
        activeSessionId && pinnedMode !== 'placeholder' ? (
          <StatusBanner
            sessionId={activeSessionId}
            trailing={
              !isWeb ? (
                <SessionToolbar sessionId={activeSessionId} showPreview={isFloating} />
              ) : undefined
            }
          />
        ) : undefined
      }
      contentOverride={
        placeholder ??
        (activeBot && pinnedMode !== 'floating' ? (
          <BotPage key={JSON.stringify(activeBot)} target={activeBot} />
        ) : undefined)
      }
      welcome={<WelcomeView />}
      renderNotebook={(path, sid) => <NotebookSessionView path={path} sessionId={sid} />}
      conversationEmptyState={(sid) => <EmptySessionHint sessionId={sid} />}
      overlays={
        // 会话配置弹窗
        getSessionChannelApi().app.platform !== 'web' && showSessionConfig && activeSessionId ? (
          <SessionConfigDialog
            sessionId={activeSessionId}
            onClose={() => setShowSessionConfig(false)}
          />
        ) : undefined
      }
    />
  )
}
