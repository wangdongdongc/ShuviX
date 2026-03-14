import { create } from 'zustand'
import type { ToolResultDetails } from '../../../shared/types/chatMessage'

// 消息相关类型从 preload 全局声明导入（ChatMessage 判别联合 + per-type 接口）
export type {
  ChatMessage,
  UserTextMessage,
  AssistantTextMessage,
  ToolUseMessage,
  StepTextMessage,
  StepThinkingMessage,
  ErrorEventMessage,
  MessageMetadata,
  ImageMeta,
  UsageInfo,
  UserTextMeta,
  AssistantTextMeta,
  ToolUseMeta,
  StepTextMeta,
  StepThinkingMeta
}
export type { ToolResultDetails }

/** 分享模式类型（与后端 ShareMode 对齐） */
export type ShareMode = 'readonly' | 'chat' | 'full'

/** 工具执行实时状态（流式期间的临时状态） */
export interface ToolExecution {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  /** 所属 turn 编号（用于 UI 区分同一 turn 的工具调用） */
  turnIndex?: number
  status: 'running' | 'done' | 'error' | 'pending_approval' | 'pending_ssh_credentials'
  result?: string
  /** 工具特定的结构化详情（edit diff 等） */
  details?: ToolResultDetails
  messageId?: string
}

/** 独立的用户输入请求状态（ask 工具 / ACP requestPermission 等） */
export interface PendingUserInput {
  toolCallId: string
  toolName: string
  question: string
  /** 问题下方的详细说明（可选） */
  detail?: string
  options: Array<{ label: string; description: string }>
  allowMultiple: boolean
}

/** 模型相关元数据 */
export interface SessionModelMetadata {
  thinkingLevel?: string
  enabledTools?: string[]
}

/** 会话级配置 */
export interface SessionSettings {
  bashAutoApprove?: boolean
  bashAllowList?: string[]
  sshAutoApprove?: boolean
  sshAllowList?: string[]
  telegramBotId?: string
}

/** 会话类型（持久化字段，不含运行时计算属性） */
export interface Session {
  id: string
  title: string
  /** 所属项目 ID（null 表示临时会话） */
  projectId: string | null
  provider: string
  model: string
  systemPrompt: string
  /** 模型相关设置（思考深度、工具列表等） */
  modelMetadata: SessionModelMetadata
  /** 会话级配置（SSH 免审批等） */
  settings: SessionSettings
  createdAt: number
  updatedAt: number
}

/** 每个 session 的流式状态 */
interface SessionStreamState {
  content: string
  thinking: string
  isStreaming: boolean
  images: Array<{ data: string; mimeType: string }>
}

/** 每个 session 的活跃 Docker/SSH/Python/ACP 资源信息 */
export interface SessionResourceInfo {
  docker?: { containerId: string; image: string } | null
  ssh?: { host: string; port: number; username: string } | null
  python?: { ready: boolean } | null
  sql?: { ready: boolean } | null
  acp?: Array<{ agentName: string; displayName: string }>
}

/** 子智能体内部工具执行 */
export interface SubAgentToolExecution {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  /** ACP 工具类别（read / edit / execute / search 等） */
  toolKind?: string
  status: 'running' | 'done' | 'error'
  result?: string
  /** 参数摘要（持久化时保存，恢复后直接使用；流式时从 args 实时推导） */
  summary?: string
}

/** 子智能体 token 用量 */
export interface SubAgentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  details: Array<{
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
    stopReason: string
  }>
}

/** 子智能体时间线条目 — tool / text / thinking 按时间顺序混排 */
export type SubAgentTimelineEntry =
  | { type: 'tool'; tool: SubAgentToolExecution }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }

/** 子智能体执行状态 */
export interface SubAgentExecution {
  subAgentId: string
  subAgentType: string
  description: string
  /** 关联主 Agent 的 explore 工具调用 */
  parentToolCallId?: string
  status: 'running' | 'done' | 'error'
  /** 按时间顺序的工具调用 / 文本 / 思考流 */
  timeline: SubAgentTimelineEntry[]
  result?: string
  usage?: SubAgentUsage
}

/** 空数组常量，避免选择器每次返回新引用 */
const EMPTY_TOOLS: ToolExecution[] = []
const EMPTY_SUBAGENTS: SubAgentExecution[] = []

interface ChatState {
  /** 所有会话 */
  sessions: Session[]
  /** 当前活跃会话 ID */
  activeSessionId: string | null
  /** 当前会话的消息列表 */
  messages: ChatMessage[]
  /** 各 session 的流式状态（按 sessionId 隔离） */
  sessionStreams: Record<string, SessionStreamState>
  /** 各 session 的工具执行实时状态（按 sessionId 隔离） */
  sessionToolExecutions: Record<string, ToolExecution[]>
  /** 各 session 的子智能体执行状态（按 sessionId 隔离，临时，不持久化） */
  sessionSubAgentExecutions: Record<string, SubAgentExecution[]>
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
  /** 当前会话启用的工具列表 */
  enabledTools: string[]
  /** 当前会话的项目工作目录 */
  projectPath: string | null
  /** AGENT.md 是否已加载 */
  agentMdLoaded: boolean
  /** 各 session 的活跃 Docker/SSH 资源信息 */
  sessionResources: Record<string, SessionResourceInfo>
  /** 各 session 的待处理用户输入请求 */
  sessionPendingUserInputs: Record<string, PendingUserInput>
  /** 已开启 WebUI 分享的 session ID → 分享模式 */
  sharedSessionIds: Map<string, ShareMode>
  /** Telegram 绑定关系：sessionId → { botId, username } */
  telegramBindings: Map<string, { botId: string; username: string }>
  /** 当前 WebUI 分享模式（null = Electron 本地，不受限） */
  shareMode: ShareMode | null

  // Actions
  setSessions: (sessions: Session[]) => void
  setActiveSessionId: (id: string | null) => void
  setMessages: (messages: ChatMessage[]) => void
  addMessage: (message: ChatMessage) => void
  replaceMessage: (id: string, message: ChatMessage) => void
  appendStreamingContent: (sessionId: string, delta: string) => void
  appendStreamingThinking: (sessionId: string, delta: string) => void
  appendStreamingImage: (sessionId: string, image: { data: string; mimeType: string }) => void
  clearStreamingContent: (sessionId: string) => void
  setIsStreaming: (sessionId: string, streaming: boolean) => void
  getSessionStreamContent: (sessionId: string) => string
  getSessionStreamThinking: (sessionId: string) => string
  addToolExecution: (sessionId: string, exec: ToolExecution) => void
  updateToolExecution: (
    sessionId: string,
    toolCallId: string,
    updates: Partial<ToolExecution>
  ) => void
  clearToolExecutions: (sessionId: string) => void
  addSubAgentExecution: (sessionId: string, exec: SubAgentExecution) => void
  addSubAgentTool: (sessionId: string, subAgentId: string, tool: SubAgentToolExecution) => void
  updateSubAgentTool: (
    sessionId: string,
    subAgentId: string,
    toolCallId: string,
    updates: Partial<SubAgentToolExecution>
  ) => void
  endSubAgentExecution: (
    sessionId: string,
    subAgentId: string,
    result?: string,
    usage?: SubAgentUsage
  ) => void
  setInputText: (text: string) => void
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
  updateSessionSettings: (id: string, patch: Partial<SessionSettings>) => void
  removeSession: (id: string) => void
  setEnabledTools: (tools: string[]) => void
  setProjectPath: (path: string | null) => void
  setAgentMdLoaded: (loaded: boolean) => void
  setShareMode: (mode: ShareMode | null) => void
  setSharedSessionIds: (ids: Map<string, ShareMode>) => void
  setTelegramBindings: (bindings: Map<string, { botId: string; username: string }>) => void
  setSessionDocker: (sessionId: string, info: { containerId: string; image: string } | null) => void
  setSessionSsh: (
    sessionId: string,
    info: { host: string; port: number; username: string } | null
  ) => void
  setSessionPython: (sessionId: string, info: { ready: boolean } | null) => void
  setSessionSql: (sessionId: string, info: { ready: boolean } | null) => void
  addSessionAcp: (sessionId: string, info: { agentName: string; displayName: string }) => void
  removeSessionAcp: (sessionId: string, agentName: string) => void
  appendSubAgentStreamingContent: (sessionId: string, subAgentId: string, delta: string) => void
  appendSubAgentStreamingThinking: (sessionId: string, subAgentId: string, delta: string) => void
  /** 设置 session 的待处理用户输入 */
  setPendingUserInput: (sessionId: string, input: PendingUserInput) => void
  /** 清除 session 的待处理用户输入 */
  clearPendingUserInput: (sessionId: string) => void
  /** 原子完成流式：清除流式状态 + 工具执行 + 添加最终消息（单次 set，避免页面闪动） */
  finishStreaming: (sessionId: string, finalMessage?: ChatMessage) => void
}

// ========== 派生选择器（UI 组件通过这些选择器从底层 map 读取当前活跃会话的状态） ==========

export const selectStreamingContent = (s: ChatState): string =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.content || '' : ''

export const selectStreamingThinking = (s: ChatState): string =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.thinking || '' : ''

export const selectIsStreaming = (s: ChatState): boolean =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.isStreaming || false : false

/** 空图片数组常量，避免选择器每次返回新引用 */
const EMPTY_IMAGES: Array<{ data: string; mimeType: string }> = []

export const selectStreamingImages = (s: ChatState): Array<{ data: string; mimeType: string }> =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.images || EMPTY_IMAGES : EMPTY_IMAGES

export const selectToolExecutions = (s: ChatState): ToolExecution[] =>
  s.activeSessionId ? s.sessionToolExecutions[s.activeSessionId] || EMPTY_TOOLS : EMPTY_TOOLS

export const selectSubAgentExecutions = (s: ChatState): SubAgentExecution[] =>
  s.activeSessionId
    ? s.sessionSubAgentExecutions[s.activeSessionId] || EMPTY_SUBAGENTS
    : EMPTY_SUBAGENTS

export const selectPendingUserInput = (s: ChatState): PendingUserInput | null =>
  s.activeSessionId ? s.sessionPendingUserInputs[s.activeSessionId] || null : null

/** 当前模式是否允许对话（chat / full / null=本地） */
export const selectCanChat = (s: ChatState): boolean => s.shareMode !== 'readonly'

/** 当前模式是否允许编辑配置（full / null=本地） */
export const selectCanEdit = (s: ChatState): boolean =>
  s.shareMode === 'full' || s.shareMode === null

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  sessionStreams: {},
  sessionToolExecutions: {},
  sessionSubAgentExecutions: {},
  sessionPendingUserInputs: {},
  modelSupportsReasoning: false,
  thinkingLevel: 'off',
  modelSupportsVision: false,
  maxContextTokens: 0,
  usedContextTokens: null,
  pendingImages: [],
  inputText: '',
  enabledTools: [],
  projectPath: null,
  agentMdLoaded: false,
  sessionResources: {},
  sharedSessionIds: new Map(),
  telegramBindings: new Map(),
  shareMode: null,

  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  replaceMessage: (id, message) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? message : m))
    })),

  appendStreamingContent: (sessionId, delta) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: []
      }
      const updated = { ...prev, content: prev.content + delta }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  appendStreamingThinking: (sessionId, delta) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: []
      }
      const updated = { ...prev, thinking: prev.thinking + delta }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  appendStreamingImage: (sessionId, image) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: []
      }
      const updated = { ...prev, images: [...prev.images, image] }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  clearStreamingContent: (sessionId) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev) return {}
      const updated = { ...prev, content: '', thinking: '', images: [] }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  setIsStreaming: (sessionId, streaming) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: []
      }
      const updated = { ...prev, isStreaming: streaming }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
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
      return {
        sessionToolExecutions: { ...state.sessionToolExecutions, [sessionId]: [...prev, exec] }
      }
    }),

  updateToolExecution: (sessionId, toolCallId, updates) =>
    set((state) => {
      const prev = state.sessionToolExecutions[sessionId] || []
      const updated = prev.map((t) => (t.toolCallId === toolCallId ? { ...t, ...updates } : t))
      return { sessionToolExecutions: { ...state.sessionToolExecutions, [sessionId]: updated } }
    }),

  clearToolExecutions: (sessionId) =>
    set((state) => {
      const rest = { ...state.sessionToolExecutions }
      delete rest[sessionId]
      return { sessionToolExecutions: rest }
    }),

  addSubAgentExecution: (sessionId, exec) =>
    set((state) => {
      const prev = state.sessionSubAgentExecutions[sessionId] || []
      return {
        sessionSubAgentExecutions: {
          ...state.sessionSubAgentExecutions,
          [sessionId]: [...prev, exec]
        }
      }
    }),

  addSubAgentTool: (sessionId, subAgentId, tool) =>
    set((state) => {
      const prev = state.sessionSubAgentExecutions[sessionId] || []
      const updated = prev.map((sa) =>
        sa.subAgentId === subAgentId
          ? { ...sa, timeline: [...sa.timeline, { type: 'tool' as const, tool }] }
          : sa
      )
      return {
        sessionSubAgentExecutions: { ...state.sessionSubAgentExecutions, [sessionId]: updated }
      }
    }),

  updateSubAgentTool: (sessionId, subAgentId, toolCallId, updates) =>
    set((state) => {
      const prev = state.sessionSubAgentExecutions[sessionId] || []
      const updated = prev.map((sa) =>
        sa.subAgentId === subAgentId
          ? {
              ...sa,
              timeline: sa.timeline.map((entry) =>
                entry.type === 'tool' && entry.tool.toolCallId === toolCallId
                  ? { ...entry, tool: { ...entry.tool, ...updates } }
                  : entry
              )
            }
          : sa
      )
      return {
        sessionSubAgentExecutions: { ...state.sessionSubAgentExecutions, [sessionId]: updated }
      }
    }),

  endSubAgentExecution: (sessionId, subAgentId, result, usage) =>
    set((state) => {
      const prev = state.sessionSubAgentExecutions[sessionId] || []
      const updated = prev.map((sa) =>
        sa.subAgentId === subAgentId ? { ...sa, status: 'done' as const, result, usage } : sa
      )
      return {
        sessionSubAgentExecutions: { ...state.sessionSubAgentExecutions, [sessionId]: updated }
      }
    }),

  setInputText: (text) => set({ inputText: text }),
  setModelSupportsReasoning: (supports) => set({ modelSupportsReasoning: supports }),
  setThinkingLevel: (level) => set({ thinkingLevel: level }),
  setModelSupportsVision: (supports) => set({ modelSupportsVision: supports }),
  setMaxContextTokens: (tokens) => set({ maxContextTokens: tokens }),
  setUsedContextTokens: (tokens) => set({ usedContextTokens: tokens }),
  addPendingImage: (image) => set((state) => ({ pendingImages: [...state.pendingImages, image] })),
  removePendingImage: (index) =>
    set((state) => ({ pendingImages: state.pendingImages.filter((_, i) => i !== index) })),
  clearPendingImages: () => set({ pendingImages: [] }),
  updateSessionTitle: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s))
    })),
  updateSessionProject: (id, projectId) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, projectId } : s))
    })),
  updateSessionSettings: (id, patch) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, settings: { ...s.settings, ...patch } } : s
      )
    })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId
    })),
  setShareMode: (mode) => set({ shareMode: mode }),
  setSharedSessionIds: (ids: Map<string, ShareMode>) => set({ sharedSessionIds: ids }),
  setTelegramBindings: (bindings) => set({ telegramBindings: bindings }),
  setEnabledTools: (tools) => set({ enabledTools: tools }),
  setProjectPath: (path) => set({ projectPath: path }),
  setAgentMdLoaded: (loaded) => set({ agentMdLoaded: loaded }),

  setSessionDocker: (sessionId, info) =>
    set((state) => {
      const prev = state.sessionResources[sessionId] || {}
      return {
        sessionResources: { ...state.sessionResources, [sessionId]: { ...prev, docker: info } }
      }
    }),

  setSessionSsh: (sessionId, info) =>
    set((state) => {
      const prev = state.sessionResources[sessionId] || {}
      return {
        sessionResources: { ...state.sessionResources, [sessionId]: { ...prev, ssh: info } }
      }
    }),

  setSessionPython: (sessionId, info) =>
    set((state) => {
      const prev = state.sessionResources[sessionId] || {}
      return {
        sessionResources: { ...state.sessionResources, [sessionId]: { ...prev, python: info } }
      }
    }),

  setSessionSql: (sessionId, info) =>
    set((state) => {
      const prev = state.sessionResources[sessionId] || {}
      return {
        sessionResources: { ...state.sessionResources, [sessionId]: { ...prev, sql: info } }
      }
    }),

  addSessionAcp: (sessionId, info) =>
    set((state) => {
      const prev = state.sessionResources[sessionId] || {}
      const acpList = [...(prev.acp || []), info]
      return {
        sessionResources: { ...state.sessionResources, [sessionId]: { ...prev, acp: acpList } }
      }
    }),

  removeSessionAcp: (sessionId, agentName) =>
    set((state) => {
      const prev = state.sessionResources[sessionId] || {}
      const acpList = (prev.acp || []).filter((a) => a.agentName !== agentName)
      return {
        sessionResources: {
          ...state.sessionResources,
          [sessionId]: { ...prev, acp: acpList.length > 0 ? acpList : undefined }
        }
      }
    }),

  appendSubAgentStreamingContent: (sessionId, subAgentId, delta) =>
    set((state) => {
      const execs = state.sessionSubAgentExecutions[sessionId]
      if (!execs) return state
      return {
        sessionSubAgentExecutions: {
          ...state.sessionSubAgentExecutions,
          [sessionId]: execs.map((sa) => {
            if (sa.subAgentId !== subAgentId) return sa
            const tl = sa.timeline
            const last = tl[tl.length - 1]
            if (last && last.type === 'text') {
              // 追加到最后一个 text 条目
              const updated = [...tl]
              updated[updated.length - 1] = { type: 'text', content: last.content + delta }
              return { ...sa, timeline: updated }
            }
            // 新建 text 条目
            return { ...sa, timeline: [...tl, { type: 'text' as const, content: delta }] }
          })
        }
      }
    }),

  appendSubAgentStreamingThinking: (sessionId, subAgentId, delta) =>
    set((state) => {
      const execs = state.sessionSubAgentExecutions[sessionId]
      if (!execs) return state
      return {
        sessionSubAgentExecutions: {
          ...state.sessionSubAgentExecutions,
          [sessionId]: execs.map((sa) => {
            if (sa.subAgentId !== subAgentId) return sa
            const tl = sa.timeline
            const last = tl[tl.length - 1]
            if (last && last.type === 'thinking') {
              const updated = [...tl]
              updated[updated.length - 1] = { type: 'thinking', content: last.content + delta }
              return { ...sa, timeline: updated }
            }
            return { ...sa, timeline: [...tl, { type: 'thinking' as const, content: delta }] }
          })
        }
      }
    }),

  setPendingUserInput: (sessionId, input) =>
    set((state) => ({
      sessionPendingUserInputs: { ...state.sessionPendingUserInputs, [sessionId]: input }
    })),

  clearPendingUserInput: (sessionId) =>
    set((state) => {
      const rest = { ...state.sessionPendingUserInputs }
      delete rest[sessionId]
      return { sessionPendingUserInputs: rest }
    }),

  finishStreaming: (sessionId, finalMessage) =>
    set((state) => {
      // 清除该 session 的流式内容
      const prevStream = state.sessionStreams[sessionId]
      const updatedStream = prevStream
        ? { ...prevStream, content: '', thinking: '', isStreaming: false, images: [] }
        : undefined
      const newStreams = updatedStream
        ? { ...state.sessionStreams, [sessionId]: updatedStream }
        : state.sessionStreams

      // 清除该 session 的工具执行状态
      const restToolExecs = { ...state.sessionToolExecutions }
      delete restToolExecs[sessionId]

      // 清除该 session 的子智能体执行状态
      const restSubAgents = { ...state.sessionSubAgentExecutions }
      delete restSubAgents[sessionId]

      // 清除该 session 的待处理用户输入
      const restPendingInputs = { ...state.sessionPendingUserInputs }
      delete restPendingInputs[sessionId]

      // 添加最终消息（如有）
      const newMessages =
        finalMessage && sessionId === state.activeSessionId
          ? [...state.messages, finalMessage]
          : state.messages

      return {
        sessionStreams: newStreams,
        sessionToolExecutions: restToolExecs,
        sessionSubAgentExecutions: restSubAgents,
        sessionPendingUserInputs: restPendingInputs,
        messages: newMessages
      }
    })
}))
