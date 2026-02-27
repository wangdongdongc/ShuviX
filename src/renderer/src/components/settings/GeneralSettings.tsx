import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../../stores/settingsStore'

/** 通用设置（所有修改即时保存） */
export function GeneralSettings(): React.JSX.Element {
  const { t, i18n: i18nInstance } = useTranslation()
  const i18nLang = i18nInstance.language
  const { systemPrompt, theme, fontSize, uiZoom, setSystemPrompt, setTheme, setFontSize, setUiZoom, availableModels, activeProvider, activeModel, setActiveProvider, setActiveModel } = useSettingsStore()
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

  /** 系统提示词失焦时保存 */
  const handleSystemPromptBlur = (): void => {
    if (localSystemPrompt !== systemPrompt) {
      setSystemPrompt(localSystemPrompt)
      window.api.settings.set({ key: 'general.systemPrompt', value: localSystemPrompt })
    }
  }

  return (
    <div className="flex-1 px-5 py-5 space-y-6">
      {/* 主题 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.theme')}</label>
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
              {th === 'dark' ? t('settings.themeDark') : th === 'light' ? t('settings.themeLight') : t('settings.themeSystem')}
            </button>
          ))}
        </div>
      </div>

      {/* 语言 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.language')}</label>
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
      </div>

      {/* 字体大小 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {t('settings.fontSize')} <span className="text-text-tertiary font-normal ml-1">{fontSize}px</span>
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
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {t('settings.uiZoom')} <span className="text-text-tertiary font-normal ml-1">{uiZoom}%</span>
        </label>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-text-tertiary">50%</span>
          <input
            type="range"
            min={50}
            max={200}
            step={10}
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

      {/* 默认 Provider */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.defaultProvider')}</label>
        <select
          value={activeProvider}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
        >
          {enabledProviderIds.map((pid) => {
            const m = availableModels.find((am) => am.providerId === pid)
            return (
              <option key={pid} value={pid}>{m?.providerName || pid}</option>
            )
          })}
        </select>
      </div>

      {/* 默认模型 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.defaultModel')}</label>
        <select
          value={activeModel}
          onChange={(e) => handleModelChange(e.target.value)}
          className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none cursor-pointer"
        >
          {availableModels
            .filter((m) => m.providerId === activeProvider)
            .map((m) => (
              <option key={m.id} value={m.modelId}>{m.modelId}</option>
            ))}
        </select>
      </div>

      {/* 系统提示词 */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-2">{t('settings.systemPrompt')}</label>
        <textarea
          value={localSystemPrompt}
          onChange={(e) => setLocalSystemPrompt(e.target.value)}
          onBlur={handleSystemPromptBlur}
          rows={4}
          className="w-full bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-primary placeholder:text-text-tertiary outline-none resize-none focus:border-accent/50 transition-colors leading-relaxed"
          placeholder={t('settings.systemPromptPlaceholder')}
        />
      </div>
    </div>
  )
}
