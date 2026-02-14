import { create } from 'zustand'

interface SettingsState {
  /** API Keys（按 provider 存储） */
  apiKeys: Record<string, string>
  /** 自定义 Base URL（按 provider 存储） */
  baseUrls: Record<string, string>
  /** 当前选择的 provider */
  provider: string
  /** 当前选择的模型 */
  model: string
  /** 系统提示词 */
  systemPrompt: string
  /** 设置面板是否打开 */
  isSettingsOpen: boolean
  /** 是否已加载 */
  loaded: boolean

  // Actions
  setApiKey: (provider: string, key: string) => void
  setBaseUrl: (provider: string, url: string) => void
  setProvider: (provider: string) => void
  setModel: (model: string) => void
  setSystemPrompt: (prompt: string) => void
  setIsSettingsOpen: (open: boolean) => void
  loadSettings: (settings: Record<string, string>) => void
}

/** 可用的 Provider 和模型列表 */
export const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini', 'o4-mini']
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-3-5-20241022', 'claude-opus-4-20250514']
  },
  {
    id: 'google',
    name: 'Google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']
  }
]

export const useSettingsStore = create<SettingsState>((set) => ({
  apiKeys: {},
  baseUrls: {},
  provider: 'openai',
  model: 'gpt-4o-mini',
  systemPrompt: 'You are a helpful assistant.',
  isSettingsOpen: false,
  loaded: false,

  setApiKey: (provider, key) =>
    set((state) => ({ apiKeys: { ...state.apiKeys, [provider]: key } })),
  setBaseUrl: (provider, url) =>
    set((state) => ({ baseUrls: { ...state.baseUrls, [provider]: url } })),
  setProvider: (provider) => set({ provider }),
  setModel: (model) => set({ model }),
  setSystemPrompt: (prompt) => set({ systemPrompt: prompt }),
  setIsSettingsOpen: (open) => set({ isSettingsOpen: open }),

  /** 从持久化存储加载设置 */
  loadSettings: (settings) => {
    const apiKeys: Record<string, string> = {}
    const baseUrls: Record<string, string> = {}
    for (const [key, value] of Object.entries(settings)) {
      if (key.startsWith('apiKey:')) {
        apiKeys[key.replace('apiKey:', '')] = value
      } else if (key.startsWith('baseUrl:')) {
        baseUrls[key.replace('baseUrl:', '')] = value
      }
    }
    set({
      apiKeys,
      baseUrls,
      provider: settings['provider'] || 'openai',
      model: settings['model'] || 'gpt-4o-mini',
      systemPrompt: settings['systemPrompt'] || 'You are a helpful assistant.',
      loaded: true
    })
  }
}))
