import { useEffect, useState } from 'react'
import i18next from 'i18next'
import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { SegmentedControl } from '../settings/SettingsPrimitives'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCompactLayout } from '../../mobile/useCompactLayout'
import { browserManagerSectionOf, type BrowserManagerSection } from '../../host/hostUrls'
import { BrowserSettingsPage } from './BrowserSettingsPage'
import { BrowserTabsManager } from './BrowserTabsManager'

/**
 * 浏览器管理页（hash `#browser-manager[?section=settings]`）—— 只在 web 客户端里打开：别的设备上的人看不到运行 ShuviX
 * 的那台电脑上的浏览器窗口（无头运行时根本没有），这里给他管理它的两样东西（2026-11-01）：
 *
 *  - 标签页（BrowserTabsManager）：列出、新建（开在后台）、换地址、刷新 / 停止、关闭，agent 正在用的标出来；
 *  - 设置（BrowserSettingsPage，`remote`）：与浏览器窗口里 `shuvix://settings` 同一个组件；读历史不给，无头时
 *    地址栏那几项置灰。
 *
 * 不复用浏览器窗口的外壳：那个外壳围着原生页面视图（布局表、地址栏、停靠区）搭，事件也只推给浏览器窗口。这里也不在
 * 服务端建「设置页」那种内部页面 tab —— 页面就画在这个标签页里。
 * 最小初始化：只加载设置（主题 / 字号 / 语言），与 widget 页同款。
 */
export function BrowserManagerShell(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()
  const compact = useCompactLayout()
  const [section, setSection] = useState<BrowserManagerSection>(() =>
    browserManagerSectionOf(window.location.hash)
  )
  /** 那台电脑在无头运行（问不到 → 当作不是） */
  const [headless, setHeadless] = useState(false)

  // ========== 最小应用初始化：设置 ==========
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
    void window.api.browserView
      .hostInfo()
      .then((info) => setHeadless(info.headless === true))
      .catch(() => undefined)
    return window.api.events.subscribe((event) => {
      if (event.type === 'settings.changed') void loadSettings()
    })
  }, [])

  useEffect(() => {
    document.title = t('browser.manager.title')
  }, [t])

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

  /** 切节：hash 跟着换（刷新 / 复制地址还是这一节），不进历史 */
  const changeSection = (next: BrowserManagerSection): void => {
    setSection(next)
    const hash = next === 'tabs' ? '#browser-manager' : `#browser-manager?section=${next}`
    window.history.replaceState(null, '', hash)
  }

  return (
    <div
      className="flex flex-col h-full bg-bg-primary text-text-primary"
      data-browser-manager
      data-browser-manager-section={section}
      data-headless={headless ? 'true' : undefined}
    >
      <header
        className={`flex-shrink-0 flex items-center gap-3 border-b border-border-secondary/40 ${
          compact ? 'px-3 py-2.5' : 'px-6 py-3'
        }`}
      >
        <Globe size={16} className="text-text-tertiary flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[14px] font-medium leading-tight">{t('browser.manager.title')}</h1>
          {!compact && (
            <p className="text-[11px] text-text-tertiary truncate">
              {t('browser.manager.subtitle')}
            </p>
          )}
        </div>
        <div className="flex-shrink-0" data-browser-manager-nav>
          <SegmentedControl<BrowserManagerSection>
            value={section}
            onChange={changeSection}
            options={[
              { value: 'tabs', label: t('browser.manager.tabs') },
              { value: 'settings', label: t('browser.manager.settings') }
            ]}
          />
        </div>
      </header>
      <div className="relative flex-1 min-h-0">
        {section === 'tabs' ? (
          <BrowserTabsManager headless={headless} compact={compact} />
        ) : (
          <BrowserSettingsPage compact={compact} remote headless={headless} />
        )}
      </div>
    </div>
  )
}
