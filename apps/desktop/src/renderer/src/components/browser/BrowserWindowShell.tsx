import { useEffect, useState } from 'react'
import i18next from 'i18next'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  DEVTOOLS_HEIGHT_SETTING,
  VIEW_MODE_SETTING,
  type BrowserViewMode
} from '../../stores/browserTabsStore'
import { useBrowserTabsBridge } from '../../host/useBrowserTabsBridge'
import { BrowserTabStrip } from './BrowserTabStrip'
import { BrowserToolbar } from './BrowserToolbar'
import { AgentInfobar } from './AgentInfobar'
import { BrowserSinglePage } from './BrowserSinglePage'
import { BrowserWall } from './BrowserWall'
import { BrowserDevtoolsDock } from './BrowserDevtoolsDock'
import { DOCK_DEFAULT_HEIGHT, clampDockHeight } from './dockHeight'
import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINE_SETTING, searchEngineOf } from './omnibox'

/**
 * 浏览器独立窗口根组件（hash #browser-window）—— 照 Chrome 的样子（2026-10-16 用户裁定）：
 *
 *   标签条（就是标题栏）
 *   工具条：后退 / 前进 / 刷新、地址栏、视图切换、⋮
 *   提示条：选中的那页正接着 agent 时才有
 *   页面区：单页视图（缺省，只显示选中的那页）或平铺墙（第二种视图）
 *   停靠区：选中的那页开着 DevTools 时才有（原生 DevTools / agent 的 devtool，见 BrowserDevtoolsDock）
 *
 * - 最小应用初始化：仅加载设置（主题 / 字号 / 语言 / 搜索引擎 / 视图），不加载会话 / 提供商 —— 与 widget
 *   窗口同款
 * - tab 状态经 useBrowserTabsBridge 镜像主进程真源；页面本体是主进程挂在本窗口上的 WebContentsView，
 *   本窗口只负责上报布局表
 * - 关窗只是隐藏（主进程 browserWindowService），tab 与页面状态都留着
 * - 键盘快捷键全在主进程（before-input-event，见 services/browser/shortcuts.ts）：焦点在页面里还是在
 *   外壳上都一样，agent 的 CDP 按键碰不到
 */
export function BrowserWindowShell(): React.JSX.Element {
  const { theme, darkTheme, lightTheme, fontSize } = useSettingsStore()
  const [engine, setEngine] = useState(DEFAULT_SEARCH_ENGINE)
  const [viewMode, setViewMode] = useState<BrowserViewMode>('single')
  const [dockHeight, setDockHeight] = useState(DOCK_DEFAULT_HEIGHT)

  useBrowserTabsBridge()

  // ========== 最小应用初始化：设置 + 通知主进程（applyZoom）==========
  useEffect(() => {
    const loadSettings = async (): Promise<void> => {
      const settings = await window.api.settings.getAll()
      useSettingsStore.getState().loadSettings(settings)
      setEngine(searchEngineOf(settings[SEARCH_ENGINE_SETTING]))
      setViewMode(settings[VIEW_MODE_SETTING] === 'wall' ? 'wall' : 'single')
      const savedHeight = Number(settings[DEVTOOLS_HEIGHT_SETTING])
      if (savedHeight > 0) setDockHeight(savedHeight)
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

  /** 停靠区改高度：拖动中只改界面，松手记进设置（所有页共用一个高度） */
  const changeDockHeight = (height: number, commit: boolean): void => {
    setDockHeight(height)
    if (commit)
      void window.api.settings.set({ key: DEVTOOLS_HEIGHT_SETTING, value: String(height) })
  }

  /** 切视图：当场换，并记进设置（下次开窗还是这个视图） */
  const changeViewMode = (mode: BrowserViewMode): void => {
    setViewMode(mode)
    void window.api.settings.set({ key: VIEW_MODE_SETTING, value: mode })
  }

  return (
    <div
      className="flex flex-col h-full bg-bg-primary text-text-primary"
      data-browser-window
      data-view-mode={viewMode}
    >
      <BrowserTabStrip />
      <BrowserToolbar engine={engine} viewMode={viewMode} onViewMode={changeViewMode} />
      <AgentInfobar />
      <div className="flex-1 min-h-0">
        {viewMode === 'wall' ? (
          <BrowserWall engine={engine} />
        ) : (
          <BrowserSinglePage engine={engine} />
        )}
      </div>
      <BrowserDevtoolsDock
        height={clampDockHeight(dockHeight, window.innerHeight)}
        onHeight={changeDockHeight}
      />
    </div>
  )
}
