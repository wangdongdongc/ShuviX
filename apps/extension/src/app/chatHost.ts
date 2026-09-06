/**
 * 扩展宿主状态 —— 把 settingsStore 组装成 chat-ui 的 ChatHostValue（外观 / 当前选中模型）。
 * 仿桌面 settingsChatHost.ts，但数据源为 chrome.storage；不提供 voice（扩展暂不支持朗读）。
 *
 * 模型「目录」(providers/availableModels)已收进 chat-ui modelCatalogStore（经 ChatApi.provider 拉取 +
 * 订阅 providers.changed），此处只注入当前会话的选中模型镜像。
 */
import { useEffect, useState, useCallback } from 'react'
import type { ChatHostValue } from '@shuvix/chat-ui'
import { settingsStore } from '../storage/settingsStore'
import { useAppearance } from './appearanceStore'

export function useExtensionChatHost(): ChatHostValue {
  const appearance = useAppearance()
  const [activeProvider, setActiveProviderState] = useState('')
  const [activeModel, setActiveModelState] = useState('')

  useEffect(() => {
    void (async () => {
      // 初始活跃 = 设置中的默认模型（未配则首个已启用模型）。打开会话后由 useSessionInit
      // 同步成该会话自己的模型。activeProvider/activeModel 仅是当前会话的内存镜像，不持久化。
      const configured = await settingsStore.getConfiguredDefault()
      const def = settingsStore.getDefaultSelection()
      setActiveProviderState(configured.provider || def.provider)
      setActiveModelState(configured.model || def.model)
    })()
  }, [])

  // 仅内存镜像（驱动 ModelPicker 显示当前会话模型）；不落盘——切换会话模型不应改动默认模型。
  // 每会话的模型由 ModelPicker 经 session.updateModelConfig 持久化（与桌面一致）。
  const setActiveProvider = useCallback((id: string) => {
    setActiveProviderState(id)
  }, [])

  const setActiveModel = useCallback((id: string) => {
    setActiveModelState(id)
  }, [])

  return {
    appearance: {
      theme: appearance.theme,
      darkTheme: appearance.darkTheme,
      lightTheme: appearance.lightTheme,
      fontSize: appearance.fontSize,
      focusMode: appearance.focusMode
    },
    models: { activeProvider, activeModel, setActiveProvider, setActiveModel }
    // 不提供 voice —— 扩展暂不支持朗读，据此隐藏语音 UI
  }
}
