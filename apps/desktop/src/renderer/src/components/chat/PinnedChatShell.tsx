import { useEffect, useMemo } from 'react'
import { useChatStore } from '@shuvix/chat-ui'
import { useSettingsStore } from '../../stores/settingsStore'
import { useBrowserStore, CHAT_CONTAINER_ATTR } from '../../stores/browserStore'
import { useAppInit } from '../../hooks/useAppInit'
import { ChatHostProvider } from '@shuvix/chat-ui'
import { useSettingsChatHost } from '../../host/settingsChatHost'
import { SessionRuntime } from '../../host/SessionRuntime'
import { ChatView } from './ChatView'
import { RightPanel } from '../browser/RightPanel'
import { BrowserResizeHandle } from '../browser/BrowserResizeHandle'

function parseSessionIdFromHash(): string | null {
  const hash = window.location.hash // 形如 "#pinned-chat?sessionId=xxx"
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return null
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  return params.get('sessionId')
}

/**
 * 悬浮窗口根组件
 *
 * - 从 URL hash 解析 sessionId（同步可用，避免 store 加载竞态）
 * - 复用主窗口的初始化钩子（每个 BrowserWindow 是独立 Zustand 实例，互不影响）
 * - 不渲染 Sidebar；右面板（文件树/终端/widget/sub-agent）按需展开，与主窗独立
 * - 主题 / 字体大小：直接复用 settingsStore，效果与主窗一致
 */
export function PinnedChatShell(): React.JSX.Element {
  const sessionId = useMemo(() => parseSessionIdFromHash(), [])
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()
  const isBrowserOpen = useBrowserStore((s) => s.isOpen)
  const lockedChatWidth = useBrowserStore((s) => s.lockedChatWidth)

  // 初始化钩子（顺序与 App.tsx 主窗口一致）
  useAppInit()
  const chatHost = useSettingsChatHost()

  // 把 URL 里的 sessionId 写入 store —— 单次执行
  useEffect(() => {
    if (sessionId) setActiveSessionId(sessionId)
  }, [sessionId, setActiveSessionId])

  // 字体大小
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}px`)
  }, [fontSize])

  // 主题（与 App.tsx 主窗口逻辑一致）
  useEffect(() => {
    const resolveThemeId = (mode: 'dark' | 'light'): string =>
      mode === 'dark' ? darkTheme : lightTheme
    const applyTheme = (mode: 'dark' | 'light'): void => {
      document.documentElement.setAttribute('data-theme', resolveThemeId(mode))
    }
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyTheme(mq.matches ? 'dark' : 'light')
      const handler = (e: MediaQueryListEvent): void => applyTheme(e.matches ? 'dark' : 'light')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      applyTheme(theme)
      return undefined
    }
  }, [theme, darkTheme, lightTheme])

  return (
    <ChatHostProvider value={chatHost}>
      <SessionRuntime sessionId={activeSessionId} />
      <div className="flex h-full bg-bg-primary">
        <div
          {...{ [CHAT_CONTAINER_ATTR]: true }}
          className="min-w-[320px] bg-bg-primary"
          style={
            lockedChatWidth != null ? { width: lockedChatWidth, flexShrink: 0 } : { flex: '1 1 0%' }
          }
        >
          <ChatView pinnedMode="floating" />
        </div>
        {(isBrowserOpen || lockedChatWidth != null) && <BrowserResizeHandle />}
        {(isBrowserOpen || lockedChatWidth != null) && <RightPanel pinnedMode />}
      </div>
    </ChatHostProvider>
  )
}
