import { useState, useEffect } from 'react'
import { useChatHost, useAppEvent } from '@shuvix/chat-ui'
import { AppearanceTab, ModelDefaultsSettings } from '@shuvix/app-shell'
import i18n from '../i18n'
import { useAppearance, setAppearance } from '../appearanceStore'
import { settingsStore } from '../../storage/settingsStore'

/** 扩展外观 tab 绑定层（appearanceStore + chrome.storage；隐藏笔记本主题/缩放）。
 *  默认模型一节复用共享 ModelDefaultsSettings：可用模型现读 settingsStore（保证启用后即刷新），
 *  选中值/持久化走 ChatHost.models（即 session.create 用的默认模型）。
 *  注：「标题生成模型」设置已废弃 —— 自动标题恒随会话当前模型（titleRuntime）。 */
export function ExtAppearanceTab(): React.JSX.Element {
  const a = useAppearance()
  const { models } = useChatHost()
  const [availableModels, setAvailableModels] = useState(() => settingsStore.listAvailableModels())
  // 「默认模型」「标题模型」均为独立持久化项(general.default* / general.title*)，仅设置页写。
  const [defaultSel, setDefaultSel] = useState({ provider: '', model: '' })
  useEffect(() => {
    setAvailableModels(settingsStore.listAvailableModels())
    void settingsStore.getConfiguredDefault().then(setDefaultSel)
  }, [])
  // 提供商/模型变更（同设置页 ProviderTab 启停/增删）→ 刷新可选模型列表
  useAppEvent('providers.changed', () => setAvailableModels(settingsStore.listAvailableModels()))
  const setDefaultProvider = (id: string): void => {
    setDefaultSel((s) => ({ ...s, provider: id }))
    models.setActiveProvider(id) // 同步内存镜像 → 立即反映到 ModelPicker / 欢迎页显示
    void settingsStore.set('general.defaultProvider', id)
  }
  const setDefaultModel = (id: string): void => {
    setDefaultSel((s) => ({ ...s, model: id }))
    models.setActiveModel(id)
    void settingsStore.set('general.defaultModel', id)
  }
  return (
    <>
      <AppearanceTab
        theme={a.theme}
        darkTheme={a.darkTheme}
        lightTheme={a.lightTheme}
        fontSize={a.fontSize}
        focusMode={a.focusMode}
        language={i18n.language}
        caps={{ showLanguage: true, showNotebookTheme: false, showUiZoom: false }}
        onThemeChange={(theme) => setAppearance({ theme })}
        onDarkThemeChange={(darkTheme) => setAppearance({ darkTheme })}
        onLightThemeChange={(lightTheme) => setAppearance({ lightTheme })}
        onFontSizeChange={(fontSize) => setAppearance({ fontSize })}
        onFocusModeToggle={() => setAppearance({ focusMode: !a.focusMode })}
        onLanguageChange={(lng) => {
          void i18n.changeLanguage(lng)
          void settingsStore.set('language', lng)
        }}
      />
      <ModelDefaultsSettings
        availableModels={availableModels}
        defaultProvider={defaultSel.provider}
        defaultModel={defaultSel.model}
        setDefaultProvider={setDefaultProvider}
        setDefaultModel={setDefaultModel}
      />
    </>
  )
}
