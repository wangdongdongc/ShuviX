import { create } from 'zustand'

/** 聊天消息类型 */
export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'system_notify'
  type: 'text' | 'tool_call' | 'tool_result' | 'docker_event'
  content: string
  metadata: string | null
  model: string
  createdAt: number
}

/** 工具执行实时状态（流式期间的临时状态） */
export interface ToolExecution {
  toolCallId: string
  toolName: string
  args: any
  status: 'running' | 'done' | 'error' | 'pending_approval'
  result?: string
  messageId?: string
}

/** 会话类型 */
export interface Session {
  id: string
  title: string
  /** 所属项目 ID（null 表示临时会话） */
  projectId: string | null
  provider: string
  model: string
  systemPrompt: string
  /** 模型相关设置（JSON：思考深度等） */
  modelMetadata: string
  createdAt: number
  updatedAt: number
  /** 项目工作目录（计算属性，由后端填充） */
  workingDirectory?: string | null
}

/** 每个 session 的流式状态 */
interface SessionStreamState {
  content: string
  thinking: string
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
  /** 当前会话的流式思考内容 */
  streamingThinking: string
  /** 当前会话是否正在生成（UI 直接读取，自动同步自 sessionStreams） */
  isStreaming: boolean
  /** 各 session 的工具执行实时状态（按 sessionId 隔离） */
  sessionToolExecutions: Record<string, ToolExecution[]>
  /** 当前会话的工具执行实时状态（UI 直接读取） */
  toolExecutions: ToolExecution[]
  /** 当前模型是否支持深度思考 */
  modelSupportsReasoning: boolean
  /** 当前思考深度 */
  thinkingLevel: string
  /** 当前模型是否支持图片输入 */
  modelSupportsVision: boolean
  /** 当前模型最大上下文 token 数 */
  maxContextTokens: number
  /** 当前会话已占用上下文 token 数（来自最近一次 LLM 请求的 input usage） */
  usedContextTokens: number | null
  /** 待发送的图片列表（base64） */
  pendingImages: Array<{ data: string; mimeType: string; preview: string }>
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
  appendStreamingThinking: (sessionId: string, delta: string) => void
  clearStreamingContent: (sessionId: string) => void
  setIsStreaming: (sessionId: string, streaming: boolean) => void
  getSessionStreamContent: (sessionId: string) => string
  getSessionStreamThinking: (sessionId: string) => string
  addToolExecution: (sessionId: string, exec: ToolExecution) => void
  updateToolExecution: (sessionId: string, toolCallId: string, updates: Partial<ToolExecution>) => void
  clearToolExecutions: (sessionId: string) => void
  setInputText: (text: string) => void
  setError: (error: string | null) => void
  setModelSupportsReasoning: (supports: boolean) => void
  setThinkingLevel: (level: string) => void
  setModelSupportsVision: (supports: boolean) => void
  setMaxContextTokens: (tokens: number) => void
  setUsedContextTokens: (tokens: number | null) => void
  addPendingImage: (image: { data: string; mimeType: string; preview: string }) => void
  removePendingImage: (index: number) => void
  clearPendingImages: () => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionProject: (id: string, projectId: string | null) => void
  removeSession: (id: string) => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  sessionStreams: {},
  streamingContent: '',
  streamingThinking: '',
  isStreaming: false,
  sessionToolExecutions: {},
  toolExecutions: [],
  modelSupportsReasoning: false,
  thinkingLevel: 'off',
  modelSupportsVision: false,
  maxContextTokens: 0,
  usedContextTokens: null,
  pendingImages: [],
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
        streamingThinking: stream?.thinking || '',
        isStreaming: stream?.isStreaming || false,
        toolExecutions: tools,
        error: null
      }
    }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),

  appendStreamingContent: (sessionId, delta) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || { content: '', thinking: '', isStreaming: false }
      const updated = { ...prev, content: prev.content + delta }
      const newStreams = { ...state.sessionStreams, [sessionId]: updated }
      return {
        sessionStreams: newStreams,
        ...(sessionId === state.activeSessionId ? { streamingContent: updated.content } : {})
      }
    }),

  appendStreamingThinking: (sessionId, delta) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || { content: '', thinking: '', isStreaming: false }
      const updated = { ...prev, thinking: prev.thinking + delta }
      const newStreams = { ...state.sessionStreams, [sessionId]: updated }
      return {
        sessionStreams: newStreams,
        ...(sessionId === state.activeSessionId ? { streamingThinking: updated.thinking } : {})
      }
    }),

  clearStreamingContent: (sessionId) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev) return {}
      const updated = { ...prev, content: '', thinking: '' }
      const newStreams = { ...state.sessionStreams, [sessionId]: updated }
      return {
        sessionStreams: newStreams,
        ...(sessionId === state.activeSessionId ? { streamingContent: '', streamingThinking: '' } : {})
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

  getSessionStreamThinking: (sessionId) => {
    return get().sessionStreams[sessionId]?.thinking || ''
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
  setModelSupportsReasoning: (supports) => set({ modelSupportsReasoning: supports }),
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
  setModelSupportsVision: (supports) => set({ modelSupportsVision: supports }),
  setMaxContextTokens: (tokens) => set({ maxContextTokens: tokens }),
  setUsedContextTokens: (tokens) => set({ usedContextTokens: tokens }),
  addPendingImage: (image) => set((state) => ({ pendingImages: [...state.pendingImages, image] })),
  removePendingImage: (index) => set((state) => ({ pendingImages: state.pendingImages.filter((_, i) => i !== index) })),
  clearPendingImages: () => set({ pendingImages: [] }),
  updateSessionTitle: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s))
    })),
  updateSessionProject: (id, projectId) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, projectId } : s))
    })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId
    }))
}))
