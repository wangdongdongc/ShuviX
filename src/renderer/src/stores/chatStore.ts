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

/** 每个 session 的流式状态 */
interface SessionStreamState {
  content: string
  isStreaming: boolean
}

interface ChatState {
  /** 所有会话 */
  sessions: Session[]
  /** 当前活跃会话 ID */
  activeSessionId: string | null
  /** 当前会话的消息列表 */
  messages: ChatMessage[]
  /** 各 session 的流式状态（按 sessionId 隔离） */
  sessionStreams: Record<string, SessionStreamState>
  /** 当前会话的流式内容（UI 直接读取，自动同步自 sessionStreams） */
  streamingContent: string
  /** 当前会话是否正在生成（UI 直接读取，自动同步自 sessionStreams） */
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
  appendStreamingContent: (sessionId: string, delta: string) => void
  clearStreamingContent: (sessionId: string) => void
  setIsStreaming: (sessionId: string, streaming: boolean) => void
  getSessionStreamContent: (sessionId: string) => string
  setInputText: (text: string) => void
  setError: (error: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
  removeSession: (id: string) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  sessionStreams: {},
  streamingContent: '',
  isStreaming: false,
  inputText: '',
  error: null,

  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) =>
    set((state) => {
      const stream = id ? state.sessionStreams[id] : undefined
      return {
        activeSessionId: id,
        streamingContent: stream?.content || '',
        isStreaming: stream?.isStreaming || false
      }
    }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),

  appendStreamingContent: (sessionId, delta) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || { content: '', isStreaming: false }
      const updated = { ...prev, content: prev.content + delta }
      const newStreams = { ...state.sessionStreams, [sessionId]: updated }
      return {
        sessionStreams: newStreams,
        ...(sessionId === state.activeSessionId ? { streamingContent: updated.content } : {})
      }
    }),

  clearStreamingContent: (sessionId) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev) return {}
      const updated = { ...prev, content: '' }
      const newStreams = { ...state.sessionStreams, [sessionId]: updated }
      return {
        sessionStreams: newStreams,
        ...(sessionId === state.activeSessionId ? { streamingContent: '' } : {})
      }
    }),

  setIsStreaming: (sessionId, streaming) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || { content: '', isStreaming: false }
      const updated = { ...prev, isStreaming: streaming }
      const newStreams = { ...state.sessionStreams, [sessionId]: updated }
      return {
        sessionStreams: newStreams,
        ...(sessionId === state.activeSessionId ? { isStreaming: streaming } : {})
      }
    }),

  getSessionStreamContent: (sessionId) => {
    return get().sessionStreams[sessionId]?.content || ''
  },

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
