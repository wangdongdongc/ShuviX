import { ElectronAPI } from '@electron-toolkit/preload'

/** Agent 事件流类型 */
interface AgentStreamEvent {
  type: 'text_delta' | 'text_end' | 'thinking_delta' | 'agent_start' | 'agent_end' | 'error'
  data?: string
  error?: string
}

/** 会话类型 */
interface Session {
  id: string
  title: string
  provider: string
  model: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

/** 消息类型 */
interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

/** 提供商类型 */
interface ProviderInfo {
  id: string
  name: string
  apiKey: string
  baseUrl: string
  isEnabled: number
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** 提供商模型类型 */
interface ProviderModelInfo {
  id: string
  providerId: string
  modelId: string
  isEnabled: number
  sortOrder: number
}

/** 可用模型（含提供商名称） */
interface AvailableModel extends ProviderModelInfo {
  providerName: string
}

/** 暴露给 Renderer 的 API 类型 */
interface ShiroBotAPI {
  app: {
    openSettings: () => Promise<{ success: boolean }>
    onSettingsChanged: (callback: () => void) => () => void
  }
  agent: {
    init: (params: {
      provider: string
      model: string
      systemPrompt: string
      apiKey?: string
      baseUrl?: string
      messages?: Array<{ role: string; content: string }>
    }) => Promise<{ success: boolean }>
    prompt: (text: string) => Promise<{ success: boolean }>
    abort: () => Promise<{ success: boolean }>
    setModel: (params: { provider: string; model: string; baseUrl?: string }) => Promise<{ success: boolean }>
    onEvent: (callback: (event: AgentStreamEvent) => void) => () => void
  }
  provider: {
    listAll: () => Promise<ProviderInfo[]>
    listEnabled: () => Promise<ProviderInfo[]>
    getById: (id: string) => Promise<ProviderInfo | undefined>
    updateConfig: (params: { id: string; apiKey?: string; baseUrl?: string }) => Promise<{ success: boolean }>
    toggleEnabled: (params: { id: string; isEnabled: boolean }) => Promise<{ success: boolean }>
    listModels: (providerId: string) => Promise<ProviderModelInfo[]>
    listAvailableModels: () => Promise<AvailableModel[]>
    toggleModelEnabled: (params: { id: string; isEnabled: boolean }) => Promise<{ success: boolean }>
    syncModels: (params: { providerId: string }) => Promise<{ providerId: string; total: number; added: number }>
  }
  session: {
    list: () => Promise<Session[]>
    create: (params?: Partial<Session>) => Promise<Session>
    updateTitle: (params: { id: string; title: string }) => Promise<{ success: boolean }>
    delete: (id: string) => Promise<{ success: boolean }>
  }
  message: {
    list: (sessionId: string) => Promise<ChatMessage[]>
    add: (params: {
      sessionId: string
      role: 'user' | 'assistant'
      content: string
    }) => Promise<ChatMessage>
    clear: (sessionId: string) => Promise<{ success: boolean }>
  }
  settings: {
    getAll: () => Promise<Record<string, string>>
    get: (key: string) => Promise<string | undefined>
    set: (params: { key: string; value: string }) => Promise<{ success: boolean }>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ShiroBotAPI
  }
}
