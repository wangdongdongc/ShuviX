import { create } from 'zustand'
import type { ToolResultDetails } from '@shuvix/chat-protocol/types/chatMessage'
import type { ToolPresentation } from '@shuvix/chat-protocol/types/toolPresentation'
export type {
  ToolPresentation,
  ToolFormItem,
  ToolFormItemRenderer as FormItemRenderer
} from '@shuvix/chat-protocol/types/toolPresentation'

// 消息相关类型从 @shuvix/chat-protocol 导入（ChatMessage 判别联合 + per-type 接口），
// 不再依赖宿主的全局环境声明。
export type {
  ChatMessage,
  UserTextMessage,
  AssistantTextMessage,
  ToolUseMessage,
  StepTextMessage,
  StepThinkingMessage,
  SteerMessage,
  ErrorEventMessage,
  MessageMetadata,
  ImageMeta,
  UsageInfo,
  UserTextMeta,
  AssistantTextMeta,
  ToolUseMeta,
  StepTextMeta,
  StepThinkingMeta
} from '@shuvix/chat-protocol/types/chatMessage'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
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
  status: 'running' | 'done' | 'error'
  result?: string
  /** 工具特定的结构化详情（edit diff 等） */
  details?: ToolResultDetails
  messageId?: string
}

/** 重新导出统一的用户输入请求类型,UI 直接消费 */
export type {
  InputRequest,
  InputResponse,
  ApprovalInputRequest,
  ChoiceInputRequest,
  SshCredentialsInputRequest,
  ApprovalResponse,
  ChoiceResponse,
  SshCredentialsResponse,
  CancelResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

/** 模型相关元数据 */
export interface SessionModelMetadata {
  thinkingLevel?: string
  enabledTools?: string[]
}

/** 会话级配置 */
export interface SessionSettings {
  autoApprove?: boolean
  allowList?: string[]
  telegramBotId?: string
  enabledInstructionFiles?: string[]
  /** 笔记本会话绑定的 md 文件（相对项目根，forward-slash）；非空即为笔记本会话（纯预览，无对话/Agent） */
  notebookPath?: string
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
  /** 当前正在生成的工具调用（LLM 流式输出 tool_use 块期间） */
  streamingToolCall: {
    toolName: string
    /** 累积的原始参数 JSON 文本 */
    argsText: string
  } | null
  /** 已完成生成但尚未开始执行的工具调用（多工具顺序生成时累积） */
  completedStreamingToolCalls: Array<{
    toolName: string
    args?: Record<string, unknown>
  }>
}

/** Buffered streaming deltas for rAF batching (used by useAgentEvents) */
export interface StreamingDeltaBuffer {
  content: string
  thinking: string
  toolCallArgsDelta: string
}

/** 运行时资源状态信息 */
export interface RuntimeInfo {
  label: string
  icon?: string
  color?: string
  description?: string
}

/** 每个 session 的活跃运行时资源（runtimeId → info） */
export interface SessionResourceInfo {
  runtimes: Record<string, RuntimeInfo>
}

/** 空数组常量，避免选择器每次返回新引用 */
const EMPTY_TOOLS: ToolExecution[] = []

/** 每个会话的输入框草稿状态 */
type PendingImage = { data: string; mimeType: string; preview: string }
interface SessionDraft {
  inputText: string
  pendingImages: PendingImage[]
}

/** 按 sessionId 暂存输入框草稿，切换会话时自动保存/恢复 */
const sessionDrafts = new Map<string, SessionDraft>()

/**
 * 当前激活目标的唯一来源：会话 / 无。
 * 单一来源（active）派生出所有镜像字段，杜绝多个独立「激活字段」相互竞争。
 * 注：md live-preview 现仅经「笔记本会话」进入（普通会话选择，中间区据 session.settings.notebookPath
 * 决定渲染 NotebookView 还是 ChatView），不再有独立的「临时打开任意文件」激活态。
 */
export type ActiveView = { type: 'session'; id: string } | null

/** 由 active 派生出镜像字段，所有写入都经此，保证状态一致、无竞争 */
function deriveActive(active: ActiveView): {
  active: ActiveView
  activeSessionId: string | null
} {
  return {
    active,
    activeSessionId: active?.type === 'session' ? active.id : null
  }
}

interface ChatState {
  /** 所有会话 */
  sessions: Session[]
  /** 当前激活目标（唯一来源）：会话 / 无，其余字段皆由其派生 */
  active: ActiveView
  /** 当前活跃会话 ID —— 由 active 派生的只读镜像，勿直接 set */
  activeSessionId: string | null
  /**
   * 请求在右侧 Files 面板打开某文件预览的信号（绝对路径 + 单调 nonce）。
   * 笔记本编辑器内点击 [[wiki-link]] 时设置；FilesPanel 订阅并打开预览。
   * 含 nonce 以便重复点击同一文件也能触发（值变化）。
   */
  filePreviewRequest: { absPath: string; nonce: number } | null
  /** 当前会话的消息列表 */
  messages: ChatMessage[]
  /** 各 session 的流式状态（按 sessionId 隔离） */
  sessionStreams: Record<string, SessionStreamState>
  /** 各 session 的工具执行实时状态（按 sessionId 隔离） */
  sessionToolExecutions: Record<string, ToolExecution[]>
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
  /** 待发送的图片列表（base64），按会话隔离 */
  pendingImages: PendingImage[]
  /** 输入框内容 */
  inputText: string
  /** 当前会话启用的工具列表 */
  enabledTools: string[]
  /** 插件工具的渲染配置（toolName → presentation，启动时加载一次） */
  toolPresentations: Record<string, ToolPresentation>
  /** 当前会话的项目工作目录 */
  projectPath: string | null
  /** 当前会话可用的斜杠命令 */
  slashCommands: Array<{
    commandId: string
    name: string
    description: string
    template: string
    requiredTools?: string[]
  }>
  /** 各 session 的活跃运行时资源（SSH / DB / SQL / Python 等） */
  sessionResources: Record<string, SessionResourceInfo>
  /**
   * 各 session 的待处理用户输入请求列表(按 sessionId 隔离)。
   * 命令审批 / 选择题 / SSH 凭证全部走这一张表。
   */
  sessionPendingInputs: Record<string, InputRequest[]>
  /**
   * 各 session 中各 request 的草稿状态(按 sessionId+requestId 隔离)。
   * 切换会话或切换 tab 时不清除,仅在 request resolved/abort 后才清。
   */
  sessionInputDrafts: Record<string, Record<string, unknown>>
  /**
   * 各 session 中各 request 的"其它"输入文本(按 sessionId+requestId 隔离)。
   * 用户在 PendingInputsPanel 的"其它"输入框里填写的文本,
   * 跨会话切换持久化,在 request resolved/abort 后随 draft 一起清除。
   */
  sessionOtherInputs: Record<string, Record<string, string>>
  /** 已开启 WebUI 分享的 session ID → 分享模式 */
  sharedSessionIds: Map<string, ShareMode>
  /** Telegram 绑定关系：sessionId → { botId, username } */
  telegramBindings: Map<string, { botId: string; username: string }>
  /** 当前 WebUI 分享模式（null = Electron 本地，不受限） */
  shareMode: ShareMode | null
  /** 正在压缩的会话 ID 集合 */
  compactingSessions: Set<string>

  // Actions
  setSessions: (sessions: Session[]) => void
  setActiveSessionId: (id: string | null) => void
  /** 请求在右侧 Files 面板打开某文件预览（绝对路径）；由笔记本编辑器 [[wiki-link]] 点击触发 */
  requestFilePreview: (absPath: string) => void
  setMessages: (messages: ChatMessage[]) => void
  addMessage: (message: ChatMessage) => void
  removeMessage: (id: string) => void
  replaceMessage: (id: string, message: ChatMessage) => void
  appendStreamingContent: (sessionId: string, delta: string) => void
  appendStreamingThinking: (sessionId: string, delta: string) => void
  appendStreamingImage: (sessionId: string, image: { data: string; mimeType: string }) => void
  clearStreamingContent: (sessionId: string) => void
  setIsStreaming: (sessionId: string, streaming: boolean) => void
  getSessionStreamContent: (sessionId: string) => string
  getSessionStreamThinking: (sessionId: string) => string
  setStreamingToolCall: (
    sessionId: string,
    toolCall: { toolName: string; argsText: string } | null
  ) => void
  appendStreamingToolCallDelta: (sessionId: string, delta: string) => void
  /** 将当前 streamingToolCall 移入 completedStreamingToolCalls 并清除 */
  finalizeStreamingToolCall: (sessionId: string) => void
  addToolExecution: (sessionId: string, exec: ToolExecution) => void
  updateToolExecution: (
    sessionId: string,
    toolCallId: string,
    updates: Partial<ToolExecution>
  ) => void
  clearToolExecutions: (sessionId: string) => void
  setInputText: (text: string) => void
  setModelSupportsReasoning: (supports: boolean) => void
  setThinkingLevel: (level: string) => void
  setModelSupportsVision: (supports: boolean) => void
  setMaxContextTokens: (tokens: number) => void
  setUsedContextTokens: (tokens: number | null) => void
  addPendingImage: (image: PendingImage) => void
  removePendingImage: (index: number) => void
  clearPendingImages: () => void
  updateSessionTitle: (id: string, title: string) => void
  updateSessionProject: (id: string, projectId: string | null) => void
  updateSessionSettings: (id: string, patch: Partial<SessionSettings>) => void
  removeSession: (id: string) => void
  setEnabledTools: (tools: string[]) => void
  setToolPresentations: (presentations: Record<string, ToolPresentation>) => void
  setProjectPath: (path: string | null) => void
  setSlashCommands: (
    commands: Array<{ commandId: string; name: string; description: string; template: string }>
  ) => void
  setShareMode: (mode: ShareMode | null) => void
  setSharedSessionIds: (ids: Map<string, ShareMode>) => void
  setTelegramBindings: (bindings: Map<string, { botId: string; username: string }>) => void
  /** 设置/删除运行时资源状态（info 为 null 时删除） */
  setRuntime: (sessionId: string, runtimeId: string, info: RuntimeInfo | null) => void
  /** 批量设置运行时资源状态（session 初始化时使用） */
  setRuntimes: (sessionId: string, runtimes: Record<string, RuntimeInfo>) => void
  /** 添加一个新的 pending 输入请求 */
  addPendingInput: (sessionId: string, request: InputRequest) => void
  /** 移除某个已解决的 pending 请求(同时清掉草稿) */
  removePendingInput: (sessionId: string, requestId: string) => void
  /** 清空指定 session 的全部 pending(用于会话切换/失效) */
  clearPendingInputs: (sessionId: string) => void
  /** 设置/更新某个请求的草稿 */
  setInputDraft: (sessionId: string, requestId: string, draft: unknown) => void
  /** 设置/更新某个请求的"其它"输入文本 */
  setOtherInput: (sessionId: string, requestId: string, text: string) => void
  /** Batch-apply buffered streaming deltas in a single set() (rAF optimization) */
  flushStreamingDeltas: (buffers: Map<string, StreamingDeltaBuffer>) => void
  /** 原子处理 step_end：清除流式内容 + 添加 step 消息（单次 set，避免闪空） */
  handleStepEnd: (sessionId: string, stepMessage: ChatMessage | null) => void
  /** 原子处理 tool_start：清除流式工具调用 + 添加执行状态 + 构造临时消息（单次 set，避免闪烁） */
  handleToolStart: (sessionId: string, exec: ToolExecution, toolMessage: ChatMessage | null) => void
  /** 原子处理 tool_end：更新执行状态 + 替换消息（单次 set，避免闪烁） */
  handleToolEnd: (
    sessionId: string,
    toolCallId: string,
    execUpdates: Partial<ToolExecution>,
    messageId: string | undefined,
    updatedMessage: ChatMessage | null
  ) => void
  /** 原子完成流式：清除流式状态 + 工具执行 + 添加最终消息（单次 set，避免页面闪动） */
  finishStreaming: (sessionId: string, finalMessage?: ChatMessage) => void
  /** 设置/解除会话的压缩中状态 */
  setCompacting: (sessionId: string, compacting: boolean) => void
}

// ========== 派生选择器（UI 组件通过这些选择器从底层 map 读取当前活跃会话的状态） ==========

/** 以本地时区按"YYYY-MM-DD"分组会话；用 updatedAt（最后活跃时间）作为落点。
 *  不是 zustand selector——每次调用都返回新 Map，需在组件内用 useMemo 包裹。 */
export const groupSessionsByDay = (sessions: Session[]): Map<string, Session[]> => {
  const map = new Map<string, Session[]>()
  for (const session of sessions) {
    const d = new Date(session.updatedAt)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const arr = map.get(key)
    if (arr) arr.push(session)
    else map.set(key, [session])
  }
  return map
}

export const selectStreamingContent = (s: ChatState): string =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.content || '' : ''

export const selectStreamingThinking = (s: ChatState): string =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.thinking || '' : ''

export const selectIsStreaming = (s: ChatState): boolean =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.isStreaming || false : false

export const selectIsCompacting = (s: ChatState): boolean =>
  s.activeSessionId ? s.compactingSessions.has(s.activeSessionId) : false

/** 空图片数组常量，避免选择器每次返回新引用 */
const EMPTY_IMAGES: Array<{ data: string; mimeType: string }> = []

export const selectStreamingImages = (s: ChatState): Array<{ data: string; mimeType: string }> =>
  s.activeSessionId ? s.sessionStreams[s.activeSessionId]?.images || EMPTY_IMAGES : EMPTY_IMAGES

export const selectStreamingToolCall = (
  s: ChatState
): { toolName: string; argsText: string } | null =>
  s.activeSessionId ? (s.sessionStreams[s.activeSessionId]?.streamingToolCall ?? null) : null

const EMPTY_COMPLETED_TOOL_CALLS: Array<{
  toolName: string
  args?: Record<string, unknown>
}> = []

export const selectCompletedStreamingToolCalls = (
  s: ChatState
): Array<{ toolName: string; args?: Record<string, unknown> }> =>
  s.activeSessionId
    ? s.sessionStreams[s.activeSessionId]?.completedStreamingToolCalls || EMPTY_COMPLETED_TOOL_CALLS
    : EMPTY_COMPLETED_TOOL_CALLS

export const selectToolExecutions = (s: ChatState): ToolExecution[] =>
  s.activeSessionId ? s.sessionToolExecutions[s.activeSessionId] || EMPTY_TOOLS : EMPTY_TOOLS

/** 当前会话的所有 pending 输入请求(按时间序) */
const EMPTY_INPUT_REQUESTS: InputRequest[] = []
export const selectPendingInputs = (s: ChatState): InputRequest[] =>
  s.activeSessionId
    ? s.sessionPendingInputs[s.activeSessionId] || EMPTY_INPUT_REQUESTS
    : EMPTY_INPUT_REQUESTS

/**
 * 全局 pending 计数(供 Sidebar 一次读取所有会话的待处理数)。
 *
 * ⚠️ zustand + useSyncExternalStore 要求 selector 在数据未变时返回稳定引用,
 * 否则触发"getSnapshot should be cached"错误并陷入无限重渲染循环。
 * 用 module-scope cache 缓存上次的输入(sessionPendingInputs 引用)和输出对象,
 * 输入引用不变时直接返回上次的输出。
 */
const EMPTY_PENDING_COUNTS: Record<string, number> = {}
let _lastPendingCountsInput: ChatState['sessionPendingInputs'] | null = null
let _lastPendingCountsOutput: Record<string, number> = EMPTY_PENDING_COUNTS
export const selectAllPendingCounts = (s: ChatState): Record<string, number> => {
  if (s.sessionPendingInputs === _lastPendingCountsInput) return _lastPendingCountsOutput
  _lastPendingCountsInput = s.sessionPendingInputs
  const result: Record<string, number> = {}
  let nonEmpty = false
  for (const [sid, list] of Object.entries(s.sessionPendingInputs)) {
    if (list && list.length > 0) {
      result[sid] = list.length
      nonEmpty = true
    }
  }
  _lastPendingCountsOutput = nonEmpty ? result : EMPTY_PENDING_COUNTS
  return _lastPendingCountsOutput
}

/** 取某个会话中某个请求的草稿 */
export const selectInputDraft = (s: ChatState, sessionId: string, requestId: string): unknown =>
  s.sessionInputDrafts[sessionId]?.[requestId]

/** 当前模式是否允许对话（chat / full / null=本地） */
export const selectCanChat = (s: ChatState): boolean => s.shareMode !== 'readonly'

/** 当前模式是否允许编辑配置（full / null=本地） */
export const selectCanEdit = (s: ChatState): boolean =>
  s.shareMode === 'full' || s.shareMode === null

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  ...deriveActive(null),
  filePreviewRequest: null,
  messages: [],
  sessionStreams: {},
  sessionToolExecutions: {},
  sessionPendingInputs: {},
  sessionInputDrafts: {},
  sessionOtherInputs: {},
  modelSupportsReasoning: false,
  thinkingLevel: 'off',
  modelSupportsVision: false,
  maxContextTokens: 0,
  usedContextTokens: null,
  pendingImages: [],
  inputText: '',
  enabledTools: [],
  toolPresentations: {},
  projectPath: null,
  slashCommands: [],
  sessionResources: {},
  sharedSessionIds: new Map(),
  telegramBindings: new Map(),
  shareMode: null,
  compactingSessions: new Set(),

  setSessions: (sessions) => set({ sessions }),
  setActiveSessionId: (id) => {
    const state = get()
    // 保存当前会话的输入框草稿
    if (state.activeSessionId) {
      sessionDrafts.set(state.activeSessionId, {
        inputText: state.inputText,
        pendingImages: state.pendingImages
      })
    }
    // 恢复目标会话的草稿（无则清空）
    const draft = id ? sessionDrafts.get(id) : undefined
    // 选中/新建会话即把 active 切到 session（互斥由 deriveActive 保证）
    set({
      ...deriveActive(id ? { type: 'session', id } : null),
      inputText: draft?.inputText ?? '',
      pendingImages: draft?.pendingImages ?? []
    })
  },
  requestFilePreview: (absPath) =>
    set((state) => ({
      filePreviewRequest: { absPath, nonce: (state.filePreviewRequest?.nonce ?? 0) + 1 }
    })),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((state) =>
      state.messages.some((m) => m.id === message.id)
        ? state
        : { messages: [...state.messages, message] }
    ),
  removeMessage: (id) => set((state) => ({ messages: state.messages.filter((m) => m.id !== id) })),
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
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
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
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
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
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
      }
      const updated = { ...prev, images: [...prev.images, image] }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  clearStreamingContent: (sessionId) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev) return {}
      // 注意：不清除 streamingToolCall，等 tool_start 事件到达时再清除
      const updated = { ...prev, content: '', thinking: '', images: [] }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  setIsStreaming: (sessionId, streaming) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
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

  setStreamingToolCall: (sessionId, toolCall) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId] || {
        content: '',
        thinking: '',
        isStreaming: false,
        images: [],
        streamingToolCall: null,
        completedStreamingToolCalls: []
      }
      // 设为 null 时同时清除已完成列表（生成阶段结束）
      const updated = toolCall
        ? { ...prev, streamingToolCall: toolCall }
        : { ...prev, streamingToolCall: null, completedStreamingToolCalls: [] }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  appendStreamingToolCallDelta: (sessionId, delta) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev?.streamingToolCall) return {}
      const updated = {
        ...prev,
        streamingToolCall: {
          ...prev.streamingToolCall,
          argsText: prev.streamingToolCall.argsText + delta
        }
      }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

  finalizeStreamingToolCall: (sessionId) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev?.streamingToolCall) return {}
      // 尝试解析完整的 argsText 为结构化参数
      let parsedArgs: Record<string, unknown> | undefined
      try {
        parsedArgs = JSON.parse(prev.streamingToolCall.argsText)
      } catch {
        /* 解析失败则不带 args */
      }
      const completed = {
        toolName: prev.streamingToolCall.toolName,
        args: parsedArgs
      }
      const updated = {
        ...prev,
        streamingToolCall: null,
        completedStreamingToolCalls: [...prev.completedStreamingToolCalls, completed]
      }
      return { sessionStreams: { ...state.sessionStreams, [sessionId]: updated } }
    }),

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
      // 删除的是当前激活会话才清空 active
      ...(state.active?.type === 'session' && state.active.id === id ? deriveActive(null) : {})
    })),
  setShareMode: (mode) => set({ shareMode: mode }),
  setSharedSessionIds: (ids: Map<string, ShareMode>) => set({ sharedSessionIds: ids }),
  setTelegramBindings: (bindings) => set({ telegramBindings: bindings }),
  setEnabledTools: (tools) => set({ enabledTools: tools }),
  setToolPresentations: (presentations) => set({ toolPresentations: presentations }),
  setProjectPath: (path) => set({ projectPath: path }),
  setSlashCommands: (commands) => set({ slashCommands: commands }),

  setRuntime: (sessionId, runtimeId, info) =>
    set((state) => {
      const prev = state.sessionResources[sessionId]?.runtimes || {}
      const runtimes = { ...prev }
      if (info) {
        runtimes[runtimeId] = info
      } else {
        delete runtimes[runtimeId]
      }
      return {
        sessionResources: {
          ...state.sessionResources,
          [sessionId]: { runtimes }
        }
      }
    }),

  setRuntimes: (sessionId, runtimes) =>
    set((state) => ({
      sessionResources: {
        ...state.sessionResources,
        [sessionId]: { runtimes }
      }
    })),

  addPendingInput: (sessionId, request) =>
    set((state) => {
      const prev = state.sessionPendingInputs[sessionId] || []
      // 同一 id 已存在则更新而非追加(避免事件去重边界情况)
      const exists = prev.findIndex((r) => r.id === request.id)
      const next =
        exists >= 0 ? prev.map((r, i) => (i === exists ? request : r)) : [...prev, request]
      return {
        sessionPendingInputs: { ...state.sessionPendingInputs, [sessionId]: next }
      }
    }),

  removePendingInput: (sessionId, requestId) =>
    set((state) => {
      const prev = state.sessionPendingInputs[sessionId]
      if (!prev) return {}
      const nextList = prev.filter((r) => r.id !== requestId)
      const nextMap = { ...state.sessionPendingInputs }
      if (nextList.length > 0) {
        nextMap[sessionId] = nextList
      } else {
        delete nextMap[sessionId]
      }
      // 同时清掉对应草稿
      const sessionDrafts = state.sessionInputDrafts[sessionId]
      let nextDrafts = state.sessionInputDrafts
      if (sessionDrafts && requestId in sessionDrafts) {
        const { [requestId]: _drop, ...rest } = sessionDrafts
        nextDrafts = { ...state.sessionInputDrafts, [sessionId]: rest }
        if (Object.keys(rest).length === 0) {
          const { [sessionId]: _drop2, ...other } = nextDrafts
          nextDrafts = other
        }
      }
      // 同时清掉"其它"输入文本
      const sessionOthers = state.sessionOtherInputs[sessionId]
      let nextOthers = state.sessionOtherInputs
      if (sessionOthers && requestId in sessionOthers) {
        const { [requestId]: _dropO, ...restO } = sessionOthers
        nextOthers = { ...state.sessionOtherInputs, [sessionId]: restO }
        if (Object.keys(restO).length === 0) {
          const { [sessionId]: _drop2O, ...otherO } = nextOthers
          nextOthers = otherO
        }
      }
      return {
        sessionPendingInputs: nextMap,
        sessionInputDrafts: nextDrafts,
        sessionOtherInputs: nextOthers
      }
    }),

  clearPendingInputs: (sessionId) =>
    set((state) => {
      const nextMap = { ...state.sessionPendingInputs }
      delete nextMap[sessionId]
      const nextDrafts = { ...state.sessionInputDrafts }
      delete nextDrafts[sessionId]
      const nextOthers = { ...state.sessionOtherInputs }
      delete nextOthers[sessionId]
      return {
        sessionPendingInputs: nextMap,
        sessionInputDrafts: nextDrafts,
        sessionOtherInputs: nextOthers
      }
    }),

  setInputDraft: (sessionId, requestId, draft) =>
    set((state) => {
      const sessionDrafts = state.sessionInputDrafts[sessionId] || {}
      return {
        sessionInputDrafts: {
          ...state.sessionInputDrafts,
          [sessionId]: { ...sessionDrafts, [requestId]: draft }
        }
      }
    }),

  setOtherInput: (sessionId, requestId, text) =>
    set((state) => {
      const sessionOthers = state.sessionOtherInputs[sessionId] || {}
      return {
        sessionOtherInputs: {
          ...state.sessionOtherInputs,
          [sessionId]: { ...sessionOthers, [requestId]: text }
        }
      }
    }),

  flushStreamingDeltas: (buffers) =>
    set((state) => {
      const newStreams = { ...state.sessionStreams }

      for (const [sessionId, buf] of buffers) {
        if (buf.content || buf.thinking || buf.toolCallArgsDelta) {
          const prev = newStreams[sessionId] || {
            content: '',
            thinking: '',
            isStreaming: false,
            images: [],
            streamingToolCall: null,
            completedStreamingToolCalls: []
          }
          const updated = { ...prev }
          if (buf.content) updated.content = prev.content + buf.content
          if (buf.thinking) updated.thinking = prev.thinking + buf.thinking
          if (buf.toolCallArgsDelta && updated.streamingToolCall) {
            updated.streamingToolCall = {
              ...updated.streamingToolCall,
              argsText: updated.streamingToolCall.argsText + buf.toolCallArgsDelta
            }
          }
          newStreams[sessionId] = updated
        }
      }

      return { sessionStreams: newStreams }
    }),

  handleStepEnd: (sessionId, stepMessage) =>
    set((state) => {
      const prev = state.sessionStreams[sessionId]
      if (!prev) return stepMessage ? { messages: [...state.messages, stepMessage] } : {}
      // 单次 set：清除流式内容 + 添加 step 消息
      const updatedStream = { ...prev, content: '', thinking: '', images: [] }
      return {
        sessionStreams: { ...state.sessionStreams, [sessionId]: updatedStream },
        ...(stepMessage ? { messages: [...state.messages, stepMessage] } : {})
      }
    }),

  handleToolStart: (sessionId, exec, toolMessage) =>
    set((state) => {
      // 1. 清除流式工具调用状态
      const prevStream = state.sessionStreams[sessionId]
      const updatedStream = prevStream
        ? { ...prevStream, streamingToolCall: null, completedStreamingToolCalls: [] }
        : undefined
      const newStreams = updatedStream
        ? { ...state.sessionStreams, [sessionId]: updatedStream }
        : state.sessionStreams

      // 2. 添加工具执行状态
      const prevExecs = state.sessionToolExecutions[sessionId] || []
      const newToolExecs = {
        ...state.sessionToolExecutions,
        [sessionId]: [...prevExecs, exec]
      }

      // 3. 添加 tool_use 消息（如有）
      const newMessages = toolMessage ? [...state.messages, toolMessage] : state.messages

      return {
        sessionStreams: newStreams,
        sessionToolExecutions: newToolExecs,
        messages: newMessages
      }
    }),

  handleToolEnd: (sessionId, toolCallId, execUpdates, messageId, updatedMessage) =>
    set((state) => {
      // 1. 更新工具执行状态
      const prevExecs = state.sessionToolExecutions[sessionId] || []
      const newExecs = prevExecs.map((t) =>
        t.toolCallId === toolCallId ? { ...t, ...execUpdates } : t
      )

      // 2. 替换消息（如有）
      const newMessages =
        messageId && updatedMessage
          ? state.messages.map((m) => (m.id === messageId ? updatedMessage : m))
          : state.messages

      return {
        sessionToolExecutions: { ...state.sessionToolExecutions, [sessionId]: newExecs },
        messages: newMessages
      }
    }),

  finishStreaming: (sessionId, finalMessage) =>
    set((state) => {
      // 清除该 session 的流式内容
      const prevStream = state.sessionStreams[sessionId]
      const updatedStream = prevStream
        ? {
            ...prevStream,
            content: '',
            thinking: '',
            isStreaming: false,
            images: [],
            streamingToolCall: null,
            completedStreamingToolCalls: []
          }
        : undefined
      const newStreams = updatedStream
        ? { ...state.sessionStreams, [sessionId]: updatedStream }
        : state.sessionStreams

      // 清除该 session 的工具执行状态
      const restToolExecs = { ...state.sessionToolExecutions }
      delete restToolExecs[sessionId]

      // 清除该 session 的待处理用户输入(以及对应草稿和"其它"文本)
      const restPendingInputs = { ...state.sessionPendingInputs }
      delete restPendingInputs[sessionId]
      const restInputDrafts = { ...state.sessionInputDrafts }
      delete restInputDrafts[sessionId]
      const restOtherInputs = { ...state.sessionOtherInputs }
      delete restOtherInputs[sessionId]

      // 添加最终消息（如有）
      const newMessages =
        finalMessage && sessionId === state.activeSessionId
          ? [...state.messages, finalMessage]
          : state.messages

      return {
        sessionStreams: newStreams,
        sessionToolExecutions: restToolExecs,
        sessionPendingInputs: restPendingInputs,
        sessionInputDrafts: restInputDrafts,
        sessionOtherInputs: restOtherInputs,
        messages: newMessages
      }
    }),

  setCompacting: (sessionId, compacting) =>
    set((state) => {
      const next = new Set(state.compactingSessions)
      if (compacting) next.add(sessionId)
      else next.delete(sessionId)
      return { compactingSessions: next }
    })
}))
