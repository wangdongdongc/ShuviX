import { create } from 'zustand'

/** 聊天消息类型 */
export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  type: 'text' | 'tool_call' | 'tool_result'
  content: string
  metadata: string | null
  createdAt: number
}

/** 工具执行实时状态（流式期间的临时状态） */
export interface ToolExecution {
  toolCallId: string
  toolName: string
  args: any
  status: 'running' | 'done' | 'error'
  result?: string
  messageId?: string
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
  /** 各 session 的工具执行实时状态（按 sessionId 隔离） */
  sessionToolExecutions: Record<string, ToolExecution[]>
  /** 当前会话的工具执行实时状态（UI 直接读取） */
  toolExecutions: ToolExecution[]
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
  addToolExecution: (sessionId: string, exec: ToolExecution) => void
  updateToolExecution: (sessionId: string, toolCallId: string, updates: Partial<ToolExecution>) => void
  clearToolExecutions: (sessionId: string) => void
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
  sessionToolExecutions: {},
  toolExecutions: [],
  inputText: '',
  error: null,

  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) =>
    set((state) => {
      const stream = id ? state.sessionStreams[id] : undefined
      const tools = id ? state.sessionToolExecutions[id] || [] : []
      return {
        activeSessionId: id,
        streamingContent: stream?.content || '',
        isStreaming: stream?.isStreaming || false,
        toolExecutions: tools
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

  addToolExecution: (sessionId, exec) =>
    set((state) => {
      const prev = state.sessionToolExecutions[sessionId] || []
      const updated = [...prev, exec]
      const newMap = { ...state.sessionToolExecutions, [sessionId]: updated }
      return {
        sessionToolExecutions: newMap,
        ...(sessionId === state.activeSessionId ? { toolExecutions: updated } : {})
      }
    }),

  updateToolExecution: (sessionId, toolCallId, updates) =>
    set((state) => {
      const prev = state.sessionToolExecutions[sessionId] || []
      const updated = prev.map((t) => (t.toolCallId === toolCallId ? { ...t, ...updates } : t))
      const newMap = { ...state.sessionToolExecutions, [sessionId]: updated }
      return {
        sessionToolExecutions: newMap,
        ...(sessionId === state.activeSessionId ? { toolExecutions: updated } : {})
      }
    }),

  clearToolExecutions: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.sessionToolExecutions
      return {
        sessionToolExecutions: rest,
        ...(sessionId === state.activeSessionId ? { toolExecutions: [] } : {})
      }
    }),

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
