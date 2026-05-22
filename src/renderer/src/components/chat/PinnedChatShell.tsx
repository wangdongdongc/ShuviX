import { useEffect, useMemo } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useAppInit } from '../../hooks/useAppInit'
import { useSessionInit } from '../../hooks/useSessionInit'
import { useAgentEvents } from '../../hooks/useAgentEvents'
import { ChatView } from './ChatView'

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
 * - 不渲染 Sidebar / RightPanel —— 极简画中画
 * - 主题 / 字体大小：直接复用 settingsStore，效果与主窗一致
 */
export function PinnedChatShell(): React.JSX.Element {
  const sessionId = useMemo(() => parseSessionIdFromHash(), [])
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()

  // 初始化钩子（顺序与 App.tsx 主窗口一致）
  useAppInit()
  useSessionInit(activeSessionId)
  useAgentEvents()

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
    <div className="h-full bg-bg-primary">
      <ChatView pinnedMode="floating" />
    </div>
  )
}
