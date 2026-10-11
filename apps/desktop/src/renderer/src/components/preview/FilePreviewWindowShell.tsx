import { useEffect, useMemo } from 'react'
import i18next from 'i18next'
import { ChatHostProvider, MediaUrlProvider, shuvixPreviewResolver } from '@shuvix/chat-ui'
import { FilePreview } from '@shuvix/app-shell'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSettingsChatHost } from '../../host/settingsChatHost'
import { useFilePreviewBridge } from '../../host/useFilePreviewBridge'

/** `#file-preview?sessionId=…&path=…&openedBy=…` —— path 是文件的绝对（真实）路径 */
function parseHash(): { sessionId: string | null; path: string | null; agent: boolean } {
  const hash = window.location.hash
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return { sessionId: null, path: null, agent: false }
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  return {
    sessionId: params.get('sessionId'),
    path: params.get('path'),
    agent: params.get('openedBy') === 'agent'
  }
}

/**
 * 文件预览窗口根组件（主进程 previewWindowService 建窗；md 不进这里，进协作编辑窗口）。
 *
 * - 整个窗口就是共享的 FilePreview（文本 / 代码、图片、PDF、音视频、Office、电子书），没有侧栏、
 *   没有输入卡片；文件名在系统标题栏上，所以不放关闭按钮
 * - 最小应用初始化：只加载设置（主题 / 字号 / 语言），不加载会话 / 提供商 —— 预览不建会话，
 *   读文件借的是发起请求那一刻的会话 id
 * - 媒体 / PDF / 电子书经 shuvix-preview:// 协议；内容里的 [[双链]]（.mdx 等只读 live-preview）
 *   经 useFilePreviewBridge 再开窗
 */
export function FilePreviewWindowShell(): React.JSX.Element {
  const { sessionId, path, agent } = useMemo(() => parseHash(), [])
  const { theme, darkTheme, lightTheme, fontSize, notebookTheme } = useSettingsStore()
  const chatHost = useSettingsChatHost()
  useFilePreviewBridge(sessionId ?? undefined)

  // 最小应用初始化：设置 + 通知主进程（applyZoom）
  useEffect(() => {
    const loadSettings = async (): Promise<void> => {
      const settings = await window.api.settings.getAll()
      useSettingsStore.getState().loadSettings(settings)
      const savedLang = settings['general.language']
      if (savedLang && savedLang !== i18next.language) {
        void i18next.changeLanguage(savedLang)
      }
    }
    void loadSettings().then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => window.api.app.windowReady())
      })
    })
    return window.api.events.subscribe((event) => {
      if (event.type === 'settings.changed') void loadSettings()
    })
  }, [])

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

  const caps = useMemo(
    () => ({
      notebookTheme,
      openExternal: (url: string) => void window.api.app.openExternal(url)
    }),
    [notebookTheme]
  )

  return (
    <ChatHostProvider value={chatHost}>
      <MediaUrlProvider value={shuvixPreviewResolver}>
        <div className="h-full" data-file-preview-window="">
          {sessionId && path ? (
            <FilePreview
              path={path}
              sessionId={sessionId}
              caps={caps}
              openedBy={agent ? 'agent' : 'user'}
            />
          ) : null}
        </div>
      </MediaUrlProvider>
    </ChatHostProvider>
  )
}
