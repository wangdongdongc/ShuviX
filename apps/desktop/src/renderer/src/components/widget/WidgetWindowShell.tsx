import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { Wrench, Pin, RotateCw, X } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { isWebHost } from '../../host/hostMedia'
import { WidgetFrame } from './WidgetFrame'

function parseWidgetIdFromHash(): string | null {
  const hash = window.location.hash // 形如 "#widget-window?widgetId=xxx"
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return null
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  return params.get('widgetId')
}

/**
 * Widget 独立窗口根组件（hash #widget-window?widgetId=…）
 *
 * - 从 URL hash 解析 widgetId（同步可用，避免 store 加载竞态）
 * - 最小应用初始化：仅加载设置（主题 / 字号 / 语言），不加载会话 / 提供商
 * - widget 页面由 WidgetFrame 承载（与 Widget 面板里的应用同一个组件：启动、iframe、加载态、重试）
 */
export function WidgetWindowShell(): React.JSX.Element {
  const widgetId = useMemo(() => parseWidgetIdFromHash(), [])
  const { t } = useTranslation()
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()
  const [name, setName] = useState('')
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)

  // ========== 最小应用初始化：设置 + 通知主进程（applyZoom）==========
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

  const onWidget = useCallback((widget: WidgetSummary): void => {
    setName(widget.name)
    document.title = widget.name
  }, [])

  // 改名同步标题栏；删除 / 归档时主进程会直接关窗，这里无需处理
  useEffect(() => {
    if (!widgetId) return undefined
    return window.api.events.subscribe((event) => {
      if (event.type !== 'widget.changed') return
      void window.api.widget.list().then((list) => {
        const w = list.find((x) => x.id === widgetId)
        if (w) onWidget(w)
      })
    })
  }, [widgetId, onWidget])

  // ========== 窗口操作 ==========
  useEffect(() => {
    // 浏览器标签页没有「始终置顶」
    if (!widgetId || isWebHost) return
    void window.api.widgetWindow.getAlwaysOnTop(widgetId).then((r) => setAlwaysOnTop(r.alwaysOnTop))
  }, [widgetId])

  const toggleAlwaysOnTop = useCallback(async (): Promise<void> => {
    if (!widgetId) return
    const res = await window.api.widgetWindow.setAlwaysOnTop({ id: widgetId, value: !alwaysOnTop })
    setAlwaysOnTop(res.alwaysOnTop)
  }, [widgetId, alwaysOnTop])

  const closeWindow = useCallback((): void => {
    // 浏览器标签页：关掉自己（脚本开的标签页才关得掉；关不掉就留着，用户自己关）
    if (isWebHost) {
      window.close()
      return
    }
    if (widgetId) void window.api.widgetWindow.close(widgetId)
  }, [widgetId])

  // ========== 外观（与 PinnedChatShell 一致）==========
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}px`)
  }, [fontSize])

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

  // ========== 渲染 ==========
  const iconBtn =
    'p-1.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors'

  // hash 缺 widgetId（不应发生）—— 直接渲染错误占位，不进入加载流程
  if (!widgetId) {
    return (
      <div className="flex items-center justify-center h-full bg-bg-primary">
        <span className="text-[12px] text-text-tertiary">missing widgetId</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-bg-primary text-text-primary">
      {/* 自绘标题栏：整条可拖拽，按钮区豁免 */}
      <div className="titlebar-drag flex-shrink-0 flex items-center gap-2 h-9 px-3 border-b border-border-secondary/40 select-none">
        <Wrench size={13} className="flex-shrink-0 text-violet-400" />
        <span className="flex-1 min-w-0 truncate text-[12px] font-medium">{name || ' '}</span>
        <div className="titlebar-no-drag flex items-center gap-0.5">
          {!isWebHost && (
            <button
              onClick={() => void toggleAlwaysOnTop()}
              className={`${iconBtn} ${alwaysOnTop ? 'text-violet-400 hover:text-violet-400' : ''}`}
              title={
                alwaysOnTop ? t('widgets.windowAlwaysOnTopOff') : t('widgets.windowAlwaysOnTopOn')
              }
            >
              <Pin size={13} className={alwaysOnTop ? 'fill-current' : ''} />
            </button>
          )}
          <button
            onClick={() => setReloadNonce((v) => v + 1)}
            className={iconBtn}
            title={t('widgets.windowReload')}
          >
            <RotateCw size={13} />
          </button>
          <button
            onClick={closeWindow}
            className="p-1.5 rounded hover:bg-error/15 text-text-tertiary hover:text-error transition-colors"
            title={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* 内容区：跨源 iframe 承载 widget 页面 */}
      <WidgetFrame
        widgetId={widgetId}
        title={name}
        reloadNonce={reloadNonce}
        onWidget={onWidget}
        className="flex-1 min-h-0"
      />
    </div>
  )
}
