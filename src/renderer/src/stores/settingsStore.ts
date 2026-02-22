import { create } from 'zustand'

/** 提供商信息（来自 DB） */
export interface ProviderInfo {
  id: string
  name: string
  apiKey: string
  baseUrl: string
  apiProtocol: 'openai-completions' | 'anthropic-messages' | 'google-generative-ai'
  isBuiltin: number
  isEnabled: number
  sortOrder: number
}

/** 模型信息（来自 DB） */
export interface ProviderModelInfo {
  id: string
  providerId: string
  modelId: string
  isEnabled: number
  sortOrder: number
  capabilities: string
}

/** 可用模型（含提供商名称，用于对话选择器） */
export interface AvailableModel extends ProviderModelInfo {
  providerName: string
}

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
  /** 主题 */
  theme: 'dark' | 'light' | 'system'
  /** 字体大小 (px) */
  fontSize: number
  /** 设置面板是否打开 */
  isSettingsOpen: boolean
  /** 设置面板当前 Tab */
  activeSettingsTab: 'general' | 'providers' | 'httpLogs' | 'about'
  /** 是否已加载 */
  loaded: boolean

  // Actions
  setProviders: (providers: ProviderInfo[]) => void
  setAvailableModels: (models: AvailableModel[]) => void
  setActiveProvider: (provider: string) => void
  setActiveModel: (model: string) => void
  setSystemPrompt: (prompt: string) => void
  setTheme: (theme: 'dark' | 'light' | 'system') => void
  setFontSize: (size: number) => void
  setIsSettingsOpen: (open: boolean) => void
  setActiveSettingsTab: (tab: 'general' | 'providers' | 'httpLogs' | 'about') => void
  loadSettings: (settings: Record<string, string>) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  providers: [],
  availableModels: [],
  activeProvider: '',
  activeModel: '',
  systemPrompt: 'You are a helpful assistant.',
  theme: 'dark',
  fontSize: 14,
  isSettingsOpen: false,
  activeSettingsTab: 'general',
  loaded: false,

  setProviders: (providers) => set({ providers }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setActiveProvider: (provider) => set({ activeProvider: provider }),
  setActiveModel: (model) => set({ activeModel: model }),
  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),
  setTheme: (theme) => set({ theme }),
  setFontSize: (size) => set({ fontSize: size }),
  setIsSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setActiveSettingsTab: (tab) => set({ activeSettingsTab: tab }),

  /** 从 settings 表加载通用设置 */
  loadSettings: (settings) => {
    set({
      activeProvider: settings['general.defaultProvider'] || '',
      activeModel: settings['general.defaultModel'] || '',
      systemPrompt: settings['general.systemPrompt'] || 'You are a helpful assistant.',
      theme: (settings['general.theme'] as 'dark' | 'light' | 'system') || 'dark',
      fontSize: Number(settings['general.fontSize']) || 14,
      loaded: true
    })
  }
}))
