import { useMemo } from 'react'
import type { ChatHostValue } from '@shuvix/chat-ui'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * 桌面/WebUI 宿主：把 settingsStore 适配成 chat-ui 需要的 ChatHostValue。
 *
 * 对话框（@shuvix/chat-ui）不直接依赖 settingsStore，而是消费这里组装出的注入值。
 * 服务端项目会用各自的实现（浏览器本地配置 + ChatApi.provider.*）替换本文件。
 */
export function useSettingsChatHost(): ChatHostValue {
  const theme = useSettingsStore((s) => s.theme)
  const darkTheme = useSettingsStore((s) => s.darkTheme)
  const lightTheme = useSettingsStore((s) => s.lightTheme)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const focusMode = useSettingsStore((s) => s.focusMode)

  // 模型「目录」已收进 chat-ui modelCatalogStore；这里只注入当前会话选中模型镜像
  const activeProvider = useSettingsStore((s) => s.activeProvider)
  const activeModel = useSettingsStore((s) => s.activeModel)
  const setActiveProvider = useSettingsStore((s) => s.setActiveProvider)
  const setActiveModel = useSettingsStore((s) => s.setActiveModel)

  const voiceSttLanguage = useSettingsStore((s) => s.voiceSttLanguage)
  const voiceTtsEnabled = useSettingsStore((s) => s.voiceTtsEnabled)

  return useMemo<ChatHostValue>(
    () => ({
      appearance: { theme, darkTheme, lightTheme, fontSize, focusMode },
      models: {
        activeProvider,
        activeModel,
        setActiveProvider,
        setActiveModel
      },
      voice: { sttLanguage: voiceSttLanguage, ttsEnabled: voiceTtsEnabled }
    }),
    [
      theme,
      darkTheme,
      lightTheme,
      fontSize,
      focusMode,
      activeProvider,
      activeModel,
      setActiveProvider,
      setActiveModel,
      voiceSttLanguage,
      voiceTtsEnabled
    ]
  )
}
