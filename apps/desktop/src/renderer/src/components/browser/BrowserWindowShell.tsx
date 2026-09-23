import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { Globe, Plus } from 'lucide-react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useBrowserTabsStore } from '../../stores/browserTabsStore'
import { useBrowserTabsBridge } from '../../host/useBrowserTabsBridge'
import { BrowserWall } from './BrowserWall'

/** macOS 交通灯占位：主进程 trafficLightPosition.x = 14，三颗灯约 52px 宽，留足余量 */
const MAC_TRAFFIC_LIGHT_PAD = 78

/**
 * 浏览器独立窗口根组件（hash #browser-window）
 *
 * - 最小应用初始化：仅加载设置（主题 / 字号 / 语言），不加载会话 / 提供商 —— 与 widget 窗口同款
 * - tab 状态经 useBrowserTabsBridge 镜像主进程真源；页面本体是主进程挂在本窗口上的
 *   WebContentsView，本窗口只负责上报布局表（BrowserWall）
 * - 关窗只是隐藏（主进程 browserWindowService），tab 与页面状态都留着
 */
export function BrowserWindowShell(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()
  const tabCount = useBrowserTabsStore((s) => s.tabs.length)
  const createTab = useBrowserTabsStore((s) => s.createTab)
  const isMac = window.api.app.platform === 'darwin'

  useBrowserTabsBridge()

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

  // ========== 外观（与 WidgetWindowShell 一致）==========
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

  return (
    <div className="flex flex-col h-full bg-bg-primary text-text-primary" data-browser-window>
      {/* 标题栏（36px，与主进程 trafficLightPosition 对齐）：整条可拖拽，按钮区豁免 */}
      <div
        className="titlebar-drag flex-shrink-0 flex items-center gap-2 h-9 pr-2 border-b border-border-secondary/40 select-none"
        style={{ paddingLeft: isMac ? MAC_TRAFFIC_LIGHT_PAD : 12 }}
      >
        <Globe size={13} className="flex-shrink-0 text-text-tertiary" />
        <span className="text-[12px] font-medium">{t('panel.browser')}</span>
        {tabCount > 0 && (
          <span className="text-[10px] text-text-tertiary tabular-nums">{tabCount}</span>
        )}
        <div className="flex-1" />
        <div className="titlebar-no-drag flex items-center">
          <button
            onClick={() => createTab()}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors"
            title={t('browser.newTab')}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <BrowserWall />
      </div>
    </div>
  )
}
