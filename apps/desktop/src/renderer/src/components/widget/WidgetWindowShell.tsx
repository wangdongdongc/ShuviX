import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { Wrench, Pin, RotateCw, X, Loader2 } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'

function parseWidgetIdFromHash(): string | null {
  const hash = window.location.hash // 形如 "#widget-window?widgetId=xxx"
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return null
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  return params.get('widgetId')
}

type LoadPhase =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string }

/**
 * Widget 独立窗口根组件（hash #widget-window?widgetId=…）
 *
 * - 从 URL hash 解析 widgetId（同步可用，避免 store 加载竞态）
 * - 最小应用初始化：仅加载设置（主题 / 字号 / 语言），不加载会话 / 提供商
 * - 挂载时调 widget.open：懒启动 server + 注册构建 + 拿 URL —— URL 永远现取不持久化，
 *   天然规避 server 随机端口在重启后过期的问题
 * - 内容用跨源 iframe 承载（127.0.0.1 在 renderer CSP frame-src 白名单内）；
 *   preload 只注入顶层 shell，widget 的 agent 生成代码拿不到 window.api
 */
export function WidgetWindowShell(): React.JSX.Element {
  const widgetId = useMemo(() => parseWidgetIdFromHash(), [])
  const { t } = useTranslation()
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()
  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' })
  const [name, setName] = useState('')
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const openedRef = useRef(false)

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

  // ========== 打开 / 重载 widget ==========

  /**
   * initial=true 走 widget.open（计一次打开）；重载 / 重试走 startWidget（不计数）。
   * setState 全部收在 .then 回调里（异步续体），loading 态由调用方（事件 handler）负责
   */
  const startWidget = useCallback(
    (initial: boolean): void => {
      if (!widgetId) return
      const req = initial
        ? window.api.widget.open(widgetId)
        : window.api.widget.startWidget(widgetId)
      void req.then((res) => {
        if (!res.success) {
          setPhase({ status: 'error', message: res.error })
          return
        }
        if ('widget' in res) {
          setName(res.widget.name)
          document.title = res.widget.name
        }
        if (!res.url) {
          setPhase({ status: 'error', message: t('widgets.serverStopped') })
          return
        }
        // URL 可能因 server 重启换端口 —— 每次都重挂 iframe
        setReloadToken((v) => v + 1)
        setPhase({ status: 'ready', url: res.url })
      })
    },
    [widgetId, t]
  )

  /** 重载 / 重试入口（事件 handler 里同步置 loading，再走异步流程） */
  const reloadWidget = useCallback((): void => {
    setPhase({ status: 'loading' })
    startWidget(false)
  }, [startWidget])

  useEffect(() => {
    // StrictMode 下 effect 会双跑 —— ref 防止 widget.open 重复计数 / 重复构建
    if (openedRef.current) return
    openedRef.current = true
    startWidget(true)
  }, [startWidget])

  // 改名同步标题；删除 / 归档时主进程会直接关窗，这里无需处理
  useEffect(() => {
    if (!widgetId) return undefined
    return window.api.events.subscribe((event) => {
      if (event.type !== 'widget.changed') return
      void window.api.widget.list().then((list) => {
        const w = list.find((x) => x.id === widgetId)
        if (w) {
          setName(w.name)
          document.title = w.name
        }
      })
    })
  }, [widgetId])

  // ========== 窗口操作 ==========
  useEffect(() => {
    if (!widgetId) return
    void window.api.widgetWindow.getAlwaysOnTop(widgetId).then((r) => setAlwaysOnTop(r.alwaysOnTop))
  }, [widgetId])

  const toggleAlwaysOnTop = useCallback(async (): Promise<void> => {
    if (!widgetId) return
    const res = await window.api.widgetWindow.setAlwaysOnTop({ id: widgetId, value: !alwaysOnTop })
    setAlwaysOnTop(res.alwaysOnTop)
  }, [widgetId, alwaysOnTop])

  const closeWindow = useCallback((): void => {
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
          <button
            onClick={() => void toggleAlwaysOnTop()}
            className={`${iconBtn} ${alwaysOnTop ? 'text-violet-400 hover:text-violet-400' : ''}`}
            title={
              alwaysOnTop ? t('widgets.windowAlwaysOnTopOff') : t('widgets.windowAlwaysOnTopOn')
            }
          >
            <Pin size={13} className={alwaysOnTop ? 'fill-current' : ''} />
          </button>
          <button onClick={reloadWidget} className={iconBtn} title={t('widgets.windowReload')}>
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
      <div className="flex-1 min-h-0 relative">
        {phase.status === 'ready' && (
          <iframe
            key={reloadToken}
            src={phase.url}
            title={name}
            className="absolute inset-0 w-full h-full border-0"
          />
        )}
        {phase.status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
              <Loader2 size={14} className="animate-spin" />
              <span>{t('widgets.windowStarting')}</span>
            </div>
          </div>
        )}
        {phase.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div className="text-center max-w-sm">
              <p className="text-[12px] text-text-secondary mb-1">
                {t('widgets.windowStartFailed')}
              </p>
              <p className="text-[11px] text-text-tertiary/70 break-all mb-3">{phase.message}</p>
              <button
                onClick={reloadWidget}
                className="px-3 py-1 rounded-md text-[11px] bg-bg-tertiary/80 hover:bg-bg-hover text-text-secondary transition-colors"
              >
                {t('widgets.windowRetry')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
