import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore, type DarkThemeId, type LightThemeId } from '../../stores/settingsStore'
import {
  SettingsSection,
  SettingsRow,
  InlineSelect,
  SegmentedControl,
  InlineSlider,
  Toggle
} from './SettingsPrimitives'

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

type ThemeMode = 'dark' | 'light' | 'system'
type Lang = 'zh' | 'en' | 'ja'

/** 通用设置（卡片式分组，所有修改即时保存） */
export function GeneralSettings(): React.JSX.Element {
  const { t, i18n: i18nInstance } = useTranslation()
  const i18nLang = (i18nInstance.language || 'zh') as Lang
  const {
    theme,
    darkTheme,
    lightTheme,
    fontSize,
    uiZoom,
    focusMode,
    setTheme,
    setDarkTheme,
    setLightTheme,
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

  // 从可用模型中提取已启用的 provider 列表（去重）
  const enabledProviderIds = [...new Set(availableModels.map((m) => m.providerId))]

  // 标题模型自愈：当用户在提供商设置里禁用了原模型/提供商后，保存的 titleProvider/titleModel
  // 可能不再出现在 availableModels 中。原生 <select> 会显示首项但 value 仍是旧值，导致点击
  // 首项不触发 onChange — 用户感知为"无法选择"。这里检测失配并自动回退。
  //
  // 注意：只在 availableModels 已加载（非空）时执行校验，否则启动早期会把合法配置误清空。
  useEffect(() => {
    if (!titleProvider) return
    if (availableModels.length === 0) return
    const providerModels = availableModels.filter((m) => m.providerId === titleProvider)
    if (providerModels.length === 0) {
      setTitleProvider('')
      setTitleModel('')
      window.api.settings.set({ key: 'general.titleProvider', value: '' })
      window.api.settings.set({ key: 'general.titleModel', value: '' })
      return
    }
    if (!providerModels.some((m) => m.modelId === titleModel)) {
      const fallback = providerModels[0].modelId
      setTitleModel(fallback)
      window.api.settings.set({ key: 'general.titleModel', value: fallback })
    }
  }, [titleProvider, titleModel, availableModels, setTitleProvider, setTitleModel])

  const handleProviderChange = (newProvider: string): void => {
    // 空字符串表示「无」—— 清空默认 provider + model
    if (!newProvider) {
      setActiveProvider('')
      setActiveModel('')
      window.api.settings.set({ key: 'general.defaultProvider', value: '' })
      window.api.settings.set({ key: 'general.defaultModel', value: '' })
      return
    }
    setActiveProvider(newProvider)
    window.api.settings.set({ key: 'general.defaultProvider', value: newProvider })
    const firstModel = availableModels.find((m) => m.providerId === newProvider)
    if (firstModel) {
      setActiveModel(firstModel.modelId)
      window.api.settings.set({ key: 'general.defaultModel', value: firstModel.modelId })
    }
  }

  const handleModelChange = (modelId: string): void => {
    setActiveModel(modelId)
    window.api.settings.set({ key: 'general.defaultModel', value: modelId })
  }

  const handleTitleProviderChange = (newProvider: string): void => {
    // 空字符串表示「无」—— 清空 provider + model
    if (!newProvider) {
      setTitleProvider('')
      setTitleModel('')
      window.api.settings.set({ key: 'general.titleProvider', value: '' })
      window.api.settings.set({ key: 'general.titleModel', value: '' })
      return
    }
    setTitleProvider(newProvider)
    window.api.settings.set({ key: 'general.titleProvider', value: newProvider })
    const firstModel = availableModels.find((m) => m.providerId === newProvider)
    if (firstModel) {
      setTitleModel(firstModel.modelId)
      window.api.settings.set({ key: 'general.titleModel', value: firstModel.modelId })
    }
  }

  const handleTitleModelChange = (modelId: string): void => {
    setTitleModel(modelId)
    window.api.settings.set({ key: 'general.titleModel', value: modelId })
  }

  const handleThemeChange = (mode: ThemeMode): void => {
    setTheme(mode)
    localStorage.setItem('theme', mode)
    window.api.settings.set({ key: 'general.theme', value: mode })
  }

  const handleDarkThemeChange = (id: DarkThemeId): void => {
    setDarkTheme(id)
    localStorage.setItem('darkTheme', id)
    window.api.settings.set({ key: 'general.darkTheme', value: id })
  }

  const handleLightThemeChange = (id: LightThemeId): void => {
    setLightTheme(id)
    localStorage.setItem('lightTheme', id)
    window.api.settings.set({ key: 'general.lightTheme', value: id })
  }

  const handleLangChange = (lng: Lang): void => {
    i18nInstance.changeLanguage(lng)
    window.api.settings.set({ key: 'general.language', value: lng })
  }

  const handleFocusModeToggle = (): void => {
    const next = !focusMode
    setFocusMode(next)
    window.api.settings.set({ key: 'appearance.focusMode', value: next ? 'true' : 'false' })
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-5">
      {/* 语言 */}
      <SettingsSection title={t('settings.languageGroup')}>
        <SettingsRow
          title={t('settings.language')}
          control={
            <SegmentedControl<Lang>
              value={i18nLang}
              onChange={handleLangChange}
              options={[
                { value: 'zh', label: '中文' },
                { value: 'en', label: 'English' },
                { value: 'ja', label: '日本語' }
              ]}
            />
          }
        />
      </SettingsSection>

      {/* 外观 */}
      <SettingsSection title={t('settings.appearanceGroup')}>
        <SettingsRow
          title={t('settings.themeMode')}
          control={
            <SegmentedControl<ThemeMode>
              value={theme}
              onChange={handleThemeChange}
              options={[
                { value: 'light', label: t('settings.themeLight') },
                { value: 'dark', label: t('settings.themeDark') },
                { value: 'system', label: t('settings.themeSystem') }
              ]}
            />
          }
        />
        <SettingsRow
          title={t('settings.darkThemeVariant')}
          control={
            <InlineSelect
              value={darkTheme}
              onChange={(v) => handleDarkThemeChange(v as DarkThemeId)}
            >
              {DARK_THEMES.map((th) => (
                <option key={th.id} value={th.id}>
                  {t(th.labelKey)}
                </option>
              ))}
            </InlineSelect>
          }
        />
        <SettingsRow
          title={t('settings.lightThemeVariant')}
          control={
            <InlineSelect
              value={lightTheme}
              onChange={(v) => handleLightThemeChange(v as LightThemeId)}
            >
              {LIGHT_THEMES.map((th) => (
                <option key={th.id} value={th.id}>
                  {t(th.labelKey)}
                </option>
              ))}
            </InlineSelect>
          }
        />
        <SettingsRow
          title={t('settings.fontSize')}
          control={
            <InlineSlider
              value={fontSize}
              min={12}
              max={20}
              step={1}
              onChange={(v) => {
                setFontSize(v)
                window.api.settings.set({ key: 'general.fontSize', value: String(v) })
              }}
              suffix="px"
            />
          }
        />
        <SettingsRow
          title={t('settings.uiZoom')}
          control={
            <InlineSlider
              value={uiZoom}
              min={80}
              max={150}
              step={10}
              onChange={(v) => {
                setUiZoom(v)
                window.api.settings.set({ key: 'general.uiZoom', value: String(v) })
              }}
              suffix="%"
            />
          }
        />
        <SettingsRow
          title={t('settings.focusMode')}
          description={t('settings.focusModeDesc')}
          control={<Toggle on={focusMode} onClick={handleFocusModeToggle} />}
        />
      </SettingsSection>

      {/* 默认模型 */}
      <SettingsSection
        title={t('settings.defaultModelGroup')}
        description={t('settings.defaultModelGroupDesc')}
      >
        <SettingsRow
          title={t('settings.defaultProviderRow')}
          control={
            <InlineSelect value={activeProvider} onChange={handleProviderChange}>
              <option value="">{t('settings.defaultModelNone')}</option>
              {enabledProviderIds.map((pid) => {
                const m = availableModels.find((am) => am.providerId === pid)
                return (
                  <option key={pid} value={pid}>
                    {m?.providerName || pid}
                  </option>
                )
              })}
            </InlineSelect>
          }
        />
        {activeProvider && (
          <SettingsRow
            title={t('settings.defaultModelRow')}
            control={
              <InlineSelect value={activeModel} onChange={handleModelChange}>
                {availableModels
                  .filter((m) => m.providerId === activeProvider)
                  .map((m) => (
                    <option key={m.id} value={m.modelId}>
                      {m.modelId}
                    </option>
                  ))}
              </InlineSelect>
            }
          />
        )}
      </SettingsSection>

      {/* 标题生成模型 */}
      <SettingsSection
        title={t('settings.titleModelSection')}
        footer={t('settings.titleModelHint')}
      >
        <SettingsRow
          title={t('settings.titleModelProvider')}
          control={
            <InlineSelect value={titleProvider} onChange={handleTitleProviderChange}>
              <option value="">{t('settings.titleModelNone')}</option>
              {enabledProviderIds.map((pid) => {
                const m = availableModels.find((am) => am.providerId === pid)
                return (
                  <option key={pid} value={pid}>
                    {m?.providerName || pid}
                  </option>
                )
              })}
            </InlineSelect>
          }
        />
        {titleProvider && (
          <SettingsRow
            title={t('settings.titleModelModel')}
            control={
              <InlineSelect value={titleModel} onChange={handleTitleModelChange}>
                {availableModels
                  .filter((m) => m.providerId === titleProvider)
                  .map((m) => (
                    <option key={m.id} value={m.modelId}>
                      {m.modelId}
                    </option>
                  ))}
              </InlineSelect>
            }
          />
        )}
      </SettingsSection>
    </div>
  )
}
