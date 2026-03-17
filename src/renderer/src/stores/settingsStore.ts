import { create } from 'zustand'

// ProviderInfo / ProviderModelInfo / AvailableModel / ConfigMeta 类型定义在 src/preload/index.d.ts（全局可用）

/** 深色系主题 ID */
export type DarkThemeId = 'dark' | 'github-dark' | 'nord' | 'tokyo-night'
/** 浅色系主题 ID */
export type LightThemeId = 'light' | 'github-light' | 'solarized-light'

interface SettingsState {
  /** 所有提供商列表（含禁用的） */
  providers: ProviderInfo[]
  /** 所有可用模型（已启用提供商 + 已启用模型） */
  availableModels: AvailableModel[]
  /** 当前选择的 provider ID */
  activeProvider: string
  /** 当前选择的模型 ID */
  activeModel: string
  /** 系统提示词 */
  systemPrompt: string
  /** 主题模式 */
  theme: 'dark' | 'light' | 'system'
  /** 深色模式使用的具体主题 */
  darkTheme: DarkThemeId
  /** 浅色模式使用的具体主题 */
  lightTheme: LightThemeId
  /** 字体大小 (px) */
  fontSize: number
  /** UI 缩放比例 (%) */
  uiZoom: number
  /** 语音 STT 后端 */
  voiceSttBackend: 'openai' | 'local'
  /** 语音输入语言 */
  voiceSttLanguage: string
  /** 本地 Whisper 模型 */
  voiceLocalModel: string
  /** TTS 自动朗读开关 */
  voiceTtsEnabled: boolean
  /** TTS 语音角色 */
  voiceTtsVoice: string
  /** TTS 语速 */
  voiceTtsSpeed: number
  /** TTS 模型 */
  voiceTtsModel: string
  /** TTS 后端 */
  voiceTtsBackend: 'openai' | 'qwen3'
  /** Qwen3 语音角色 */
  voiceTtsQwen3Voice: string
  /** Qwen3 语速 */
  voiceTtsQwen3Speed: number
  /** Qwen3 情感指令 */
  voiceTtsQwen3Emotion: string
  /** 设置面板是否打开 */
  isSettingsOpen: boolean
  /** 设置面板当前 Tab */
  activeSettingsTab:
    | 'general'
    | 'providers'
    | 'tools'
    | 'mcp'
    | 'skills'
    | 'voice'
    | 'bindings'
    | 'httpLogs'
    | 'about'
  /** 是否已加载 */
  loaded: boolean
  /** 系统设置 key 元数据（审批弹窗用） */
  settingMeta: Record<string, ConfigMeta>
  /** 项目字段元数据（审批弹窗用） */
  projectFieldMeta: Record<string, ConfigMeta>

  // Actions
  setProviders: (providers: ProviderInfo[]) => void
  setAvailableModels: (models: AvailableModel[]) => void
  setActiveProvider: (provider: string) => void
  setActiveModel: (model: string) => void
  setSystemPrompt: (prompt: string) => void
  setTheme: (theme: 'dark' | 'light' | 'system') => void
  setDarkTheme: (theme: DarkThemeId) => void
  setLightTheme: (theme: LightThemeId) => void
  setFontSize: (size: number) => void
  setUiZoom: (zoom: number) => void
  setIsSettingsOpen: (open: boolean) => void
  setActiveSettingsTab: (
    tab: 'general' | 'providers' | 'tools' | 'mcp' | 'skills' | 'voice' | 'bindings' | 'httpLogs' | 'about'
  ) => void
  loadSettings: (settings: Record<string, string>) => void
  /** 加载配置元数据（启动时调用一次） */
  loadConfigMeta: (
    settingMeta: Record<string, ConfigMeta>,
    projectFieldMeta: Record<string, ConfigMeta>
  ) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  providers: [],
  availableModels: [],
  activeProvider: '',
  activeModel: '',
  systemPrompt: 'You are a helpful assistant.',
  theme: 'dark',
  darkTheme: 'dark',
  lightTheme: 'light',
  fontSize: 14,
  uiZoom: 100,
  voiceSttBackend: 'openai',
  voiceSttLanguage: 'auto',
  voiceLocalModel: 'large-v3-turbo',
  voiceTtsEnabled: false,
  voiceTtsVoice: 'alloy',
  voiceTtsSpeed: 1.0,
  voiceTtsModel: 'tts-1',
  voiceTtsBackend: 'openai',
  voiceTtsQwen3Voice: 'Vivian',
  voiceTtsQwen3Speed: 1.0,
  voiceTtsQwen3Emotion: '',
  isSettingsOpen: false,
  activeSettingsTab: 'general',
  loaded: false,
  settingMeta: {},
  projectFieldMeta: {},

  setProviders: (providers) => set({ providers }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setActiveProvider: (provider) => set({ activeProvider: provider }),
  setActiveModel: (model) => set({ activeModel: model }),
  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),
  setTheme: (theme) => set({ theme }),
  setDarkTheme: (darkTheme) => set({ darkTheme }),
  setLightTheme: (lightTheme) => set({ lightTheme }),
  setFontSize: (size) => set({ fontSize: size }),
  setUiZoom: (zoom) => set({ uiZoom: zoom }),
  setIsSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setActiveSettingsTab: (tab) => set({ activeSettingsTab: tab }),

  loadConfigMeta: (settingMeta, projectFieldMeta) => set({ settingMeta, projectFieldMeta }),

  /** 从 settings 表加载通用设置（不覆盖当前会话的 activeProvider/activeModel） */
  loadSettings: (settings) => {
    const darkTheme = (settings['general.darkTheme'] as DarkThemeId) || 'dark'
    const lightTheme = (settings['general.lightTheme'] as LightThemeId) || 'light'
    set({
      systemPrompt: settings['general.systemPrompt'] || 'You are a helpful assistant.',
      theme: (settings['general.theme'] as 'dark' | 'light' | 'system') || 'dark',
      darkTheme,
      lightTheme,
      fontSize: Number(settings['general.fontSize']) || 14,
      uiZoom: Number(settings['general.uiZoom']) || 100,
      voiceSttBackend: (settings['voice.sttBackend'] as 'openai' | 'local') || 'openai',
      voiceSttLanguage: settings['voice.sttLanguage'] || 'auto',
      voiceLocalModel: settings['voice.localModel'] || 'large-v3-turbo',
      voiceTtsEnabled: settings['voice.tts.enabled'] === 'true',
      voiceTtsVoice: settings['voice.tts.openai.voice'] || 'alloy',
      voiceTtsSpeed: Number(settings['voice.tts.openai.speed']) || 1.0,
      voiceTtsModel: settings['voice.tts.openai.model'] || 'tts-1',
      voiceTtsBackend:
        (settings['voice.tts.backend'] as 'openai' | 'qwen3') || 'openai',
      voiceTtsQwen3Voice: settings['voice.tts.qwen3.voice'] || 'Vivian',
      voiceTtsQwen3Speed: Number(settings['voice.tts.qwen3.speed']) || 1.0,
      voiceTtsQwen3Emotion: settings['voice.tts.qwen3.emotion'] || '',
      loaded: true
    })
    // 同步主题到 localStorage，供 HTML 内联脚本在下次打开时消除闪烁
    localStorage.setItem('theme', settings['general.theme'] || 'dark')
    localStorage.setItem('darkTheme', darkTheme)
    localStorage.setItem('lightTheme', lightTheme)
  }
}))
