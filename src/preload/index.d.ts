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

/** 暴露给 Renderer 的 API 类型 */
interface ShiroBotAPI {
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
