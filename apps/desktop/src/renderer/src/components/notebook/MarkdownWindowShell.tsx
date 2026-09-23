import { useEffect, useMemo } from 'react'
import { ChatHostProvider, useChatStore } from '@shuvix/chat-ui'
import { useSettingsStore } from '../../stores/settingsStore'
import { useAppInit } from '../../hooks/useAppInit'
import { useSettingsChatHost } from '../../host/settingsChatHost'
import { SessionRuntime } from '../../host/SessionRuntime'
import { NotebookSessionView } from './NotebookSessionView'
import { useCoEditing } from './coEdit/useCoEditing'
import { CoEditIndicator } from './coEdit/CoEditIndicator'

/**
 * `#markdown-window?sessionId=…&path=…` —— path 是文件的**绝对路径**（读写、监听都按它走；
 * 相对图片也只有文档路径是绝对路径时才解析得出来）
 */
function parseHash(): { sessionId: string | null; path: string | null } {
  const hash = window.location.hash
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return { sessionId: null, path: null }
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  return { sessionId: params.get('sessionId'), path: params.get('path') }
}

/**
 * 从系统打开的 md 窗口根组件（主进程 markdownWindowService 建窗并建好内存会话）。
 *
 * - 会话 id 与笔记本路径从 URL hash 取（同步可用）；会话不在侧栏列表里（内存会话不进任何列表），
 *   所以不能像主窗口那样从 store 的会话列表里找它，路径也就由主进程直接给
 * - 界面就是笔记本会话本身：live preview 编辑器 + 底部输入卡片（对话在卡片的抽屉里），
 *   没有侧栏、没有顶栏 —— 文件名在系统标题栏上
 * - 协作编辑（useCoEditing）：会话的根档案是 `coedit`，agent 经 doc_* 工具直接在这个编辑器的缓冲上改 ——
 *   写参数时就有虚影，执行时一次落下，不进 ⌘Z；外部写盘三方合并，不重挂载编辑器
 * - 复用主窗口的初始化钩子（每个 BrowserWindow 是独立的 Zustand 实例）：模型选择、发送都要
 *   提供商与模型目录
 */
export function MarkdownWindowShell(): React.JSX.Element {
  const { sessionId, path } = useMemo(() => parseHash(), [])
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()

  useAppInit()
  const chatHost = useSettingsChatHost()
  // 协作编辑：agent 的 doc_* 工具在这个编辑器里执行（虚影预览 → 一次落下 → 看见后淡出的痕迹）
  const coEdit = useCoEditing(sessionId ?? '')

  // 输入卡片按 store 里的 activeSessionId 发送 —— 单次写入
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
      <div className="relative flex h-full flex-col bg-bg-primary" data-markdown-window="">
        {sessionId && path && activeSessionId === sessionId ? (
          <>
            <NotebookSessionView
              path={path}
              sessionId={sessionId}
              editorHandleRef={coEdit.editorRef}
              extraExtensions={coEdit.extensions}
              onExternalChange={coEdit.onExternalChange}
            />
            <CoEditIndicator state={coEdit.indicator} onReveal={coEdit.reveal} />
          </>
        ) : null}
      </div>
    </ChatHostProvider>
  )
}
