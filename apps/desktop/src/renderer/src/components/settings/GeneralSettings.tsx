/**
 * 通用设置（桌面绑定层）—— 外观/语言复用共享 AppearanceTab，默认模型（连同默认思考等级）复用共享
 * ModelDefaultsSettings。本层只负责把 settingsStore 的值/持久化绑进共享组件
 * （存储差异落在此处）。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useSettingsStore,
  type DarkThemeId,
  type LightThemeId,
  type NotebookThemeId
} from '../../stores/settingsStore'
import { AppearanceTab, ModelDefaultsSettings, type ThemeMode } from '@shuvix/app-shell'
import type { SelectableThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import type { AvailableModel } from '@shuvix/chat-protocol/types/provider'
import { NetworkAccessSettings } from './NetworkAccessSettings'

type Lang = 'zh' | 'en' | 'ja'

/** 命令分类模型的设置键（与主进程 commandClassifier.ts 同名） */
const CLASSIFIER_PROVIDER_KEY = 'general.classifierProvider'
const CLASSIFIER_MODEL_KEY = 'general.classifierModel'

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
    defaultThinkingLevel,
    setActiveProvider,
    setActiveModel,
    setDefaultThinkingLevel
  } = useSettingsStore()

  // 命令分类模型：只在这一页用到，不进全局 store —— 打开设置时现取清单与当前值
  const [classifierModels, setClassifierModels] = useState<AvailableModel[]>([])
  const [classifierProvider, setClassifierProvider] = useState('')
  const [classifierModel, setClassifierModel] = useState('')
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.provider.listClassifierModels(),
      window.api.settings.get(CLASSIFIER_PROVIDER_KEY),
      window.api.settings.get(CLASSIFIER_MODEL_KEY)
    ]).then(([models, provider, model]) => {
      if (cancelled) return
      setClassifierModels(models)
      setClassifierProvider(typeof provider === 'string' ? provider : '')
      setClassifierModel(typeof model === 'string' ? model : '')
    })
    return () => {
      cancelled = true
    }
  }, [])
  const persistClassifier = (provider: string, model: string): void => {
    setClassifierProvider(provider)
    setClassifierModel(model)
    window.api.settings.set({ key: CLASSIFIER_PROVIDER_KEY, value: provider })
    window.api.settings.set({ key: CLASSIFIER_MODEL_KEY, value: model })
  }

  /** 仅持久化（store + DB）的单值 setter —— 编排逻辑在共享 ModelDefaultsSettings 内 */
  const persistDefaultProvider = (id: string): void => {
    setActiveProvider(id)
    window.api.settings.set({ key: 'general.defaultProvider', value: id })
  }
  const persistDefaultModel = (id: string): void => {
    setActiveModel(id)
    window.api.settings.set({ key: 'general.defaultModel', value: id })
  }
  const persistDefaultThinkingLevel = (level: SelectableThinkingLevel): void => {
    setDefaultThinkingLevel(level)
    window.api.settings.set({ key: 'general.defaultThinkingLevel', value: level })
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
        defaultThinkingLevel={defaultThinkingLevel}
        setDefaultThinkingLevel={persistDefaultThinkingLevel}
        classifier={{
          models: classifierModels,
          provider: classifierProvider,
          model: classifierModel,
          onChange: persistClassifier
        }}
      />

      <NetworkAccessSettings />
    </div>
  )
}
