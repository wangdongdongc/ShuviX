/**
 * 扩展宿主状态 —— 把 settingsStore 组装成 chat-ui 的 ChatHostValue（外观 / 模型 / 语音）。
 * 仿桌面 settingsChatHost.ts，但数据源为 chrome.storage。
 */
import { useEffect, useState, useCallback } from 'react'
import type { ChatHostValue } from '@shuvix/chat-ui'
import type { ProviderInfo, AvailableModel } from '@shuvix/chat-protocol/types/provider'
import { settingsStore } from '../storage/settingsStore'
import { useAppearance } from './appearanceStore'

export function useExtensionChatHost(): ChatHostValue {
  const appearance = useAppearance()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([])
  const [activeProvider, setActiveProviderState] = useState('anthropic')
  const [activeModel, setActiveModelState] = useState('claude-opus-4-8')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setProviders(settingsStore.listProviders())
    setAvailableModels(settingsStore.listAvailableModels())
    void (async () => {
      const p = (await settingsStore.get('activeProvider')) || 'anthropic'
      const m = (await settingsStore.get('activeModel')) || 'claude-opus-4-8'
      setActiveProviderState(p)
      setActiveModelState(m)
      setLoaded(true)
    })()
  }, [])

  const setActiveProvider = useCallback((id: string) => {
    setActiveProviderState(id)
    void settingsStore.set('activeProvider', id)
  }, [])

  const setActiveModel = useCallback((id: string) => {
    setActiveModelState(id)
    void settingsStore.set('activeModel', id)
  }, [])

  return {
    appearance: {
      theme: appearance.theme,
      darkTheme: appearance.darkTheme,
      lightTheme: appearance.lightTheme,
      fontSize: appearance.fontSize,
      focusMode: appearance.focusMode
    },
    models: {
      loaded,
      providers,
      availableModels,
      activeProvider,
      activeModel,
      setActiveProvider,
      setActiveModel
    },
    voice: { sttLanguage: 'auto', ttsEnabled: false }
  }
}
