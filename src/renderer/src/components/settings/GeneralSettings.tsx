import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore, type DarkThemeId, type LightThemeId } from '../../stores/settingsStore'

const DARK_THEMES: { id: DarkThemeId; labelKey: string }[] = [
  { id: 'github-dark', labelKey: 'settings.themeGitHubDark' },
  { id: 'dracula', labelKey: 'settings.themeDracula' },
  { id: 'one-dark', labelKey: 'settings.themeOneDark' },
  { id: 'catppuccin-mocha', labelKey: 'settings.themeCatppuccinMocha' },
  { id: 'gruvbox-dark', labelKey: 'settings.themeGruvboxDark' },
  { id: 'nord', labelKey: 'settings.themeNord' },
  { id: 'tokyo-night', labelKey: 'settings.themeTokyoNight' }
]

const LIGHT_THEMES: { id: LightThemeId; labelKey: string }[] = [
  { id: 'github-light', labelKey: 'settings.themeGitHubLight' },
  { id: 'one-light', labelKey: 'settings.themeOneLight' },
  { id: 'catppuccin-latte', labelKey: 'settings.themeCatppuccinLatte' },
  { id: 'solarized-light', labelKey: 'settings.themeSolarizedLight' }
]

/** 通用设置（所有修改即时保存） */
export function GeneralSettings(): React.JSX.Element {
  const { t, i18n: i18nInstance } = useTranslation()
  const i18nLang = i18nInstance.language
  const {
    systemPrompt,
    theme,
    darkTheme,
    lightTheme,
    fontSize,
    uiZoom,
    setSystemPrompt,
    setTheme,
    setDarkTheme,
    setLightTheme,
    setFontSize,
    setUiZoom,
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
  const [localSystemPrompt, setLocalSystemPrompt] = useState(systemPrompt)

  useEffect(() => {
    setLocalSystemPrompt(systemPrompt)
  }, [systemPrompt])

  // 从可用模型中提取已启用的 provider 列表（去重）
  const enabledProviderIds = [...new Set(availableModels.map((m) => m.providerId))]

  /** 切换默认 Provider 时自动选第一个可用模型并即时保存 */
  const handleProviderChange = (newProvider: string): void => {
    setActiveProvider(newProvider)
    window.api.settings.set({ key: 'general.defaultProvider', value: newProvider })
    const firstModel = availableModels.find((m) => m.providerId === newProvider)
    if (firstModel) {
      setActiveModel(firstModel.modelId)
      window.api.settings.set({ key: 'general.defaultModel', value: firstModel.modelId })
    }
  }

  /** 切换默认模型并即时保存 */
  const handleModelChange = (modelId: string): void => {
    setActiveModel(modelId)
    window.api.settings.set({ key: 'general.defaultModel', value: modelId })
  }

  /** 切换标题生成 Provider 时自动选第一个可用模型并即时保存 */
  const handleTitleProviderChange = (newProvider: string): void => {
    setTitleProvider(newProvider)
    window.api.settings.set({ key: 'general.titleProvider', value: newProvider })
    const firstModel = availableModels.find((m) => m.providerId === newProvider)
    if (firstModel) {
      setTitleModel(firstModel.modelId)
      window.api.settings.set({ key: 'general.titleModel', value: firstModel.modelId })
    }
  }

  /** 切换标题生成模型并即时保存 */
  const handleTitleModelChange = (modelId: string): void => {
    setTitleModel(modelId)
    window.api.settings.set({ key: 'general.titleModel', value: modelId })
  }

  /** 清除标题模型配置(不自动生成标题) */
  const handleClearTitleModel = (): void => {
    setTitleProvider('')
    setTitleModel('')
    window.api.settings.set({ key: 'general.titleProvider', value: '' })
    window.api.settings.set({ key: 'general.titleModel', value: '' })
  }

  /** 系统提示词失焦时保存 */
  const handleSystemPromptBlur = (): void => {
    if (localSystemPrompt !== systemPrompt) {
      setSystemPrompt(localSystemPrompt)
      window.api.settings.set({ key: 'general.systemPrompt', value: localSystemPrompt })
    }
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-6">
      {/* ── 主题 ── */}
      <div className="zen-section space-y-4">
        <label className="block text-xs font-medium text-text-primary">{t('settings.theme')}</label>

        {/* 主题模式 */}
        <div className="flex gap-2">
          {(['dark', 'light', 'system'] as const).map((th) => (
            <button
              key={th}
              onClick={() => {
                setTheme(th)
                localStorage.setItem('theme', th)
                window.api.settings.set({ key: 'general.theme', value: th })
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                theme === th
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              {th === 'dark'
                ? t('settings.themeDark')
                : th === 'light'
                  ? t('settings.themeLight')
                  : t('settings.themeSystem')}
            </button>
          ))}
        </div>

        {/* 深色主题变体 */}
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5">
            {t('settings.darkThemeVariant')}
          </label>
          <div className="flex flex-wrap gap-2">
            {DARK_THEMES.map((th) => (
              <button
                key={th.id}
                onClick={() => {
                  setDarkTheme(th.id)
                  localStorage.setItem('darkTheme', th.id)
                  window.api.settings.set({ key: 'general.darkTheme', value: th.id })
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  darkTheme === th.id
                    ? 'bg-accent text-white'
                    : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {t(th.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* 浅色主题变体 */}
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5">
            {t('settings.lightThemeVariant')}
          </label>
          <div className="flex flex-wrap gap-2">
            {LIGHT_THEMES.map((th) => (
              <button
                key={th.id}
                onClick={() => {
                  setLightTheme(th.id)
                  localStorage.setItem('lightTheme', th.id)
                  window.api.settings.set({ key: 'general.lightTheme', value: th.id })
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  lightTheme === th.id
                    ? 'bg-accent text-white'
                    : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {t(th.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── UI ── */}
      <div className="zen-section space-y-4">
        <label className="block text-xs font-medium text-text-primary">
          {t('settings.language')}
        </label>

        {/* 语言 */}
        <div className="flex gap-2">
          {(['zh', 'en', 'ja'] as const).map((lng) => (
            <button
              key={lng}
              onClick={() => {
                i18nInstance.changeLanguage(lng)
                window.api.settings.set({ key: 'general.language', value: lng })
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                (i18nLang || 'zh') === lng
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              }`}
            >
              {lng === 'zh' ? '中文' : lng === 'en' ? 'English' : '日本語'}
            </button>
          ))}
        </div>

        {/* 字体大小 */}
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5">
            {t('settings.fontSize')} <span className="font-normal ml-1">{fontSize}px</span>
          </label>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-text-tertiary">12</span>
            <input
              type="range"
              min={12}
              max={20}
              step={1}
              value={fontSize}
              onChange={(e) => {
                const v = Number(e.target.value)
                setFontSize(v)
                window.api.settings.set({ key: 'general.fontSize', value: String(v) })
              }}
              className="flex-1 h-1.5 bg-bg-tertiary rounded-full appearance-none cursor-pointer accent-accent"
            />
            <span className="text-[10px] text-text-tertiary">20</span>
          </div>
        </div>

        {/* UI 缩放 */}
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1.5">
            {t('settings.uiZoom')} <span className="font-normal ml-1">{uiZoom}%</span>
          </label>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-text-tertiary">50%</span>
            <input
              type="range"
              min={50}
              max={200}
              step={5}
              value={uiZoom}
              onChange={(e) => {
                const v = Number(e.target.value)
                setUiZoom(v)
                window.api.settings.set({ key: 'general.uiZoom', value: String(v) })
              }}
              className="flex-1 h-1.5 bg-bg-tertiary rounded-full appearance-none cursor-pointer accent-accent"
            />
            <span className="text-[10px] text-text-tertiary">200%</span>
          </div>
        </div>
      </div>

      {/* ── 默认模型 ── */}
      <div className="zen-section space-y-4">
        <label className="block text-xs font-medium text-text-primary">
          {t('settings.defaultModel')}
        </label>

        {/* 默认 Provider + 模型 同一行 */}
        <div className="flex gap-2">
          <select
            value={activeProvider}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="zen-select flex-1"
          >
            {enabledProviderIds.map((pid) => {
              const m = availableModels.find((am) => am.providerId === pid)
              return (
                <option key={pid} value={pid}>
                  {m?.providerName || pid}
                </option>
              )
            })}
          </select>
          <select
            value={activeModel}
            onChange={(e) => handleModelChange(e.target.value)}
            className="zen-select flex-[2]"
          >
            {availableModels
              .filter((m) => m.providerId === activeProvider)
              .map((m) => (
                <option key={m.id} value={m.modelId}>
                  {m.modelId}
                </option>
              ))}
          </select>
        </div>

        {/* 系统提示词 */}
        <div>
          <label className="block text-[11px] text-text-tertiary mb-1">
            {t('settings.systemPrompt')}
          </label>
          <textarea
            value={localSystemPrompt}
            onChange={(e) => setLocalSystemPrompt(e.target.value)}
            onBlur={handleSystemPromptBlur}
            rows={4}
            className="zen-textarea leading-relaxed"
            placeholder={t('settings.systemPromptPlaceholder')}
          />
        </div>
      </div>

      {/* ── 标题生成模型 ── */}
      <div className="zen-section space-y-3">
        <label className="block text-xs font-medium text-text-primary">
          {t('settings.titleModelSection')}
        </label>
        <p className="text-[10px] text-text-tertiary leading-relaxed">
          {t('settings.titleModelHint')}
        </p>
        {titleProvider ? (
          <div className="flex gap-2 items-center">
            <select
              value={titleProvider}
              onChange={(e) => handleTitleProviderChange(e.target.value)}
              className="zen-select flex-1"
            >
              {enabledProviderIds.map((pid) => {
                const m = availableModels.find((am) => am.providerId === pid)
                return (
                  <option key={pid} value={pid}>
                    {m?.providerName || pid}
                  </option>
                )
              })}
            </select>
            <select
              value={titleModel}
              onChange={(e) => handleTitleModelChange(e.target.value)}
              className="zen-select flex-[2]"
            >
              {availableModels
                .filter((m) => m.providerId === titleProvider)
                .map((m) => (
                  <option key={m.id} value={m.modelId}>
                    {m.modelId}
                  </option>
                ))}
            </select>
            <button
              onClick={handleClearTitleModel}
              className="px-2 py-1 rounded text-[11px] text-text-tertiary hover:text-error hover:bg-bg-hover transition-colors shrink-0"
              title={t('settings.titleModelClear')}
            >
              {t('settings.titleModelClear')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              // 用第一个可用 provider+model 初始化
              if (enabledProviderIds.length > 0) {
                handleTitleProviderChange(enabledProviderIds[0])
              }
            }}
            className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            {t('settings.titleModelSetup')}
          </button>
        )}
      </div>
    </div>
  )
}
