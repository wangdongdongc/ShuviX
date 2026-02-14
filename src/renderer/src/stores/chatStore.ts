import { create } from 'zustand'

/** 聊天消息类型 */
export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

/** 会话类型 */
export interface Session {
  id: string
  title: string
  provider: string
  model: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

interface ChatState {
  /** 所有会话 */
  sessions: Session[]
  /** 当前活跃会话 ID */
  activeSessionId: string | null
  /** 当前会话的消息列表 */
  messages: ChatMessage[]
  /** 当前正在流式输出的内容 */
  streamingContent: string
  /** 是否正在生成 */
  isStreaming: boolean
  /** 输入框内容 */
  inputText: string
  /** 错误信息 */
  error: string | null

  // Actions
  setSessions: (sessions: Session[]) => void
  setActiveSessionId: (id: string | null) => void
  setMessages: (messages: ChatMessage[]) => void
  addMessage: (message: ChatMessage) => void
  appendStreamingContent: (delta: string) => void
  clearStreamingContent: () => void
  setIsStreaming: (streaming: boolean) => void
  setInputText: (text: string) => void
  setError: (error: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
  removeSession: (id: string) => void
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  streamingContent: '',
  isStreaming: false,
  inputText: '',
  error: null,

  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  appendStreamingContent: (delta) =>
    set((state) => ({ streamingContent: state.streamingContent + delta })),
  clearStreamingContent: () => set({ streamingContent: '' }),
  setIsStreaming: (streaming) => set({ isStreaming: streaming }),
  setInputText: (text) => set({ inputText: text }),
  setError: (error) => set({ error }),
  updateSessionTitle: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s))
    })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId
    }))
}))
