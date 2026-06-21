/**
 * 通用设置（桌面绑定层）—— 外观/语言复用共享 AppearanceTab，默认模型 + 标题模型复用共享
 * ModelDefaultsSettings。本层只负责把 settingsStore 的值/持久化绑进共享组件（存储差异落在此处）。
 */
import { useTranslation } from 'react-i18next'
import {
  useSettingsStore,
  type DarkThemeId,
  type LightThemeId,
  type NotebookThemeId
} from '../../stores/settingsStore'
import { AppearanceTab, ModelDefaultsSettings, type ThemeMode } from '@shuvix/app-shell'

type Lang = 'zh' | 'en' | 'ja'

export function GeneralSettings(): React.JSX.Element {
  const { i18n: i18nInstance } = useTranslation()
  const i18nLang = (i18nInstance.language || 'zh') as Lang
  const {
    theme,
    darkTheme,
    lightTheme,
    notebookTheme,
    fontSize,
    uiZoom,
    focusMode,
    setTheme,
    setDarkTheme,
    setLightTheme,
    setNotebookTheme,
    setFontSize,
    setUiZoom,
    setFocusMode,
    availableModels,
    activeProvider,
    activeModel,
    setActiveProvider,
    setActiveModel,
    titleProvider,
    titleModel,
    setTitleProvider,
    setTitleModel
  } = useSettingsStore()

  /** 仅持久化（store + DB）的单值 setter —— 编排逻辑在共享 ModelDefaultsSettings 内 */
  const persistDefaultProvider = (id: string): void => {
    setActiveProvider(id)
    window.api.settings.set({ key: 'general.defaultProvider', value: id })
  }
  const persistDefaultModel = (id: string): void => {
    setActiveModel(id)
    window.api.settings.set({ key: 'general.defaultModel', value: id })
  }
  const persistTitleProvider = (id: string): void => {
    setTitleProvider(id)
    window.api.settings.set({ key: 'general.titleProvider', value: id })
  }
  const persistTitleModel = (id: string): void => {
    setTitleModel(id)
    window.api.settings.set({ key: 'general.titleModel', value: id })
  }

  return (
    <div className="flex-1">
      <AppearanceTab
        theme={theme}
        darkTheme={darkTheme}
        lightTheme={lightTheme}
        notebookTheme={notebookTheme}
        fontSize={fontSize}
        uiZoom={uiZoom}
        focusMode={focusMode}
        language={i18nLang}
        caps={{ showLanguage: true, showNotebookTheme: true, showUiZoom: true }}
        onThemeChange={(mode: ThemeMode) => {
          setTheme(mode)
          localStorage.setItem('theme', mode)
          window.api.settings.set({ key: 'general.theme', value: mode })
        }}
        onDarkThemeChange={(id) => {
          setDarkTheme(id as DarkThemeId)
          localStorage.setItem('darkTheme', id)
          window.api.settings.set({ key: 'general.darkTheme', value: id })
        }}
        onLightThemeChange={(id) => {
          setLightTheme(id as LightThemeId)
          localStorage.setItem('lightTheme', id)
          window.api.settings.set({ key: 'general.lightTheme', value: id })
        }}
        onNotebookThemeChange={(id) => {
          setNotebookTheme(id as NotebookThemeId)
          window.api.settings.set({ key: 'appearance.notebookTheme', value: id })
        }}
        onFontSizeChange={(v) => {
          setFontSize(v)
          window.api.settings.set({ key: 'general.fontSize', value: String(v) })
        }}
        onUiZoomChange={(v) => {
          setUiZoom(v)
          window.api.settings.set({ key: 'general.uiZoom', value: String(v) })
        }}
        onFocusModeToggle={() => {
          const next = !focusMode
          setFocusMode(next)
          window.api.settings.set({ key: 'appearance.focusMode', value: next ? 'true' : 'false' })
        }}
        onLanguageChange={(lng) => {
          i18nInstance.changeLanguage(lng)
          window.api.settings.set({ key: 'general.language', value: lng })
        }}
      />

      <ModelDefaultsSettings
        availableModels={availableModels}
        defaultProvider={activeProvider}
        defaultModel={activeModel}
        setDefaultProvider={persistDefaultProvider}
        setDefaultModel={persistDefaultModel}
        caps={{ showTitleModel: true }}
        titleProvider={titleProvider}
        titleModel={titleModel}
        setTitleProvider={persistTitleProvider}
        setTitleModel={persistTitleModel}
      />
    </div>
  )
}
