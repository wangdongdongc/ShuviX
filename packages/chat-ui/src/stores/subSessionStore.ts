/**
 * 子智能体临时会话 store
 *
 * 右侧 Sub-agent Tab 使用的纯内存状态管理。
 * 每个子智能体运行对应一个 SubSessionState，携带与主会话相同结构的
 * messages / streamingContent / streamingThinking / toolExecutions。
 *
 * 全局（不按父会话过滤）：跨主会话切换仍保留；用户点 × 才移除。
 */

import { create } from 'zustand'
import type { ChatMessage, ToolExecution } from './chatStore'

/** 子智能体运行时状态 */
export type SubSessionStatus = 'running' | 'done' | 'error'

/** 单个子会话的完整状态 */
export interface SubSessionState {
  subSessionId: string
  parentSessionId: string
  subAgentName: string
  displayName: string
  description: string
  /** 子智能体的系统提示词（register 事件携带） */
  systemPrompt: string
  /** 父 Agent 发给子智能体的初始 user prompt（register 事件携带） */
  prompt: string
  /** 额外注入上下文的人读文本（如笔记本当前内容）；面板以折叠用户消息卡展示 */
  contextNote?: string
  status: SubSessionStatus
  startedAt: number
  endedAt?: number
  /** 最终返回给父 Agent 的 result 文本（仅在 end 后有值） */
  result?: string
  /** 子会话消息列表（事件驱动累积，不持久化） */
  messages: ChatMessage[]
  /** 流式状态 */
  streamingContent: string
  streamingThinking: string
  isStreaming: boolean
  /** 流式工具调用生成状态 */
  streamingToolCall: { toolName: string; argsText: string } | null
  completedStreamingToolCalls: Array<{ toolName: string; args?: Record<string, unknown> }>
  /** 工具执行状态（按 toolCallId 匹配） */
  toolExecutions: ToolExecution[]
}

const EMPTY_TOOL_EXECUTIONS: ToolExecution[] = []
const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_COMPLETED: Array<{ toolName: string; args?: Record<string, unknown> }> = []

interface SubSessionStore {
  subSessions: Record<string, SubSessionState>
  activeSubSessionId: string | null

  // ─── 生命周期 ──
  register(params: {
    subSessionId: string
    parentSessionId: string
    subAgentName: string
    displayName: string
    description: string
    systemPrompt: string
    prompt: string
    contextNote?: string
  }): void
  markEnded(params: { subSessionId: string; result: string; isError?: boolean }): void
  /** 用户后续追问：内联一条 user 消息到转写，并把子会话标记回运行态 */
  appendUserMessage(subSessionId: string, message: ChatMessage): void
  /** 用户显式关闭：移除 store 条目（同时应触发 IPC subSession:destroy） */
  close(subSessionId: string): void
  setActive(subSessionId: string | null): void

  // ─── 事件处理（镜像主会话事件语义） ──
  handleAgentStart(subSessionId: string): void
  appendTextDelta(subSessionId: string, delta: string): void
  appendThinkingDelta(subSessionId: string, delta: string): void
  setStreamingToolCall(
    subSessionId: string,
    toolCall: { toolName: string; argsText: string } | null
  ): void
  appendStreamingToolCallDelta(subSessionId: string, delta: string): void
  finalizeStreamingToolCall(subSessionId: string): void
  handleToolStart(subSessionId: string, exec: ToolExecution, toolMessage: ChatMessage | null): void
  handleToolEnd(
    subSessionId: string,
    toolCallId: string,
    execUpdates: Partial<ToolExecution>,
    messageId: string | undefined,
    updatedMessage: ChatMessage | null
  ): void
  handleAgentEnd(subSessionId: string, finalMessage?: ChatMessage): void
}

function createEmpty(params: {
  subSessionId: string
  parentSessionId: string
  subAgentName: string
  displayName: string
  description: string
  systemPrompt: string
  prompt: string
  contextNote?: string
}): SubSessionState {
  return {
    subSessionId: params.subSessionId,
    parentSessionId: params.parentSessionId,
    subAgentName: params.subAgentName,
    displayName: params.displayName,
    description: params.description,
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
    contextNote: params.contextNote,
    status: 'running',
    startedAt: Date.now(),
    messages: [],
    streamingContent: '',
    streamingThinking: '',
    isStreaming: false,
    streamingToolCall: null,
    completedStreamingToolCalls: [],
    toolExecutions: []
  }
}

export const useSubSessionStore = create<SubSessionStore>((set) => ({
  subSessions: {},
  activeSubSessionId: null,

  register: (params) =>
    set((state) => {
      // 已存在则不覆盖（但理论上每个 subSessionId 只 register 一次）
      if (state.subSessions[params.subSessionId]) return {}
      const entry = createEmpty(params)
      return {
        subSessions: { ...state.subSessions, [params.subSessionId]: entry },
        // 新注册的子会话默认设为活跃（SubAgentPanel useEffect 会在切换主会话时纠正）
        activeSubSessionId: params.subSessionId
      }
    }),

  markEnded: ({ subSessionId, result, isError }) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev) return {}
      return {
        subSessions: {
          ...state.subSessions,
          [subSessionId]: {
            ...prev,
            status: isError ? 'error' : 'done',
            endedAt: Date.now(),
            result,
            isStreaming: false
          }
        }
      }
    }),

  appendUserMessage: (subSessionId, message) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev) return {}
      return {
        subSessions: {
          ...state.subSessions,
          [subSessionId]: {
            ...prev,
            messages: [...prev.messages, message],
            // 追问即重回运行态（紧随其后会到来 agent_start / 流式事件）
            status: 'running',
            endedAt: undefined,
            result: undefined
          }
        }
      }
    }),

  close: (subSessionId) =>
    set((state) => {
      if (!state.subSessions[subSessionId]) return {}
      const { [subSessionId]: _, ...rest } = state.subSessions
      const nextActive =
        state.activeSubSessionId === subSessionId
          ? (Object.keys(rest)[0] ?? null)
          : state.activeSubSessionId
      return { subSessions: rest, activeSubSessionId: nextActive }
    }),

  setActive: (subSessionId) => set({ activeSubSessionId: subSessionId }),

  handleAgentStart: (subSessionId) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev) return {}
      return {
        subSessions: {
          ...state.subSessions,
          [subSessionId]: {
            ...prev,
            status: 'running',
            isStreaming: true,
            streamingContent: '',
            streamingThinking: '',
            streamingToolCall: null,
            completedStreamingToolCalls: []
          }
        }
      }
    }),

  appendTextDelta: (subSessionId, delta) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev) return {}
      return {
        subSessions: {
          ...state.subSessions,
          [subSessionId]: { ...prev, streamingContent: prev.streamingContent + delta }
        }
      }
    }),

  appendThinkingDelta: (subSessionId, delta) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev) return {}
      return {
        subSessions: {
          ...state.subSessions,
          [subSessionId]: { ...prev, streamingThinking: prev.streamingThinking + delta }
        }
      }
    }),

  setStreamingToolCall: (subSessionId, toolCall) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev) return {}
      const updated = toolCall
        ? { ...prev, streamingToolCall: toolCall }
        : { ...prev, streamingToolCall: null, completedStreamingToolCalls: [] }
      return { subSessions: { ...state.subSessions, [subSessionId]: updated } }
    }),

  appendStreamingToolCallDelta: (subSessionId, delta) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev?.streamingToolCall) return {}
      return {
        subSessions: {
          ...state.subSessions,
          [subSessionId]: {
            ...prev,
            streamingToolCall: {
              ...prev.streamingToolCall,
              argsText: prev.streamingToolCall.argsText + delta
            }
          }
        }
      }
    }),

  finalizeStreamingToolCall: (subSessionId) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev?.streamingToolCall) return {}
      let parsedArgs: Record<string, unknown> | undefined
      try {
        parsedArgs = JSON.parse(prev.streamingToolCall.argsText)
      } catch {
        /* ignore */
      }
      const completed = { toolName: prev.streamingToolCall.toolName, args: parsedArgs }
      return {
        subSessions: {
          ...state.subSessions,
          [subSessionId]: {
            ...prev,
            streamingToolCall: null,
            completedStreamingToolCalls: [...prev.completedStreamingToolCalls, completed]
          }
        }
      }
    }),

  handleToolStart: (subSessionId, exec, toolMessage) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev) return {}
      // 工具开始前，把累积的 thinking / text 冻结为 step 消息（对应主对话框的 step_end 语义）
      // 否则下一个工具调用到来时，中间的文字会被 streamingContent='' 直接丢掉
      const newMessages: ChatMessage[] = [...prev.messages]
      const now = Date.now()
      if (prev.streamingThinking) {
        newMessages.push({
          id: `${subSessionId}-step-thinking-${newMessages.length}`,
          sessionId: subSessionId,
          role: 'assistant',
          type: 'step_thinking',
          content: prev.streamingThinking,
          metadata: null,
          model: '',
          createdAt: now
        } as ChatMessage)
      }
      if (prev.streamingContent) {
        newMessages.push({
          id: `${subSessionId}-step-text-${newMessages.length}`,
          sessionId: subSessionId,
          role: 'assistant',
          type: 'step_text',
          content: prev.streamingContent,
          metadata: null,
          model: '',
          createdAt: now
        } as ChatMessage)
      }
      if (toolMessage) newMessages.push(toolMessage)

      const updated: SubSessionState = {
        ...prev,
        streamingToolCall: null,
        completedStreamingToolCalls: [],
        streamingContent: '',
        streamingThinking: '',
        toolExecutions: [...prev.toolExecutions, exec],
        messages: newMessages
      }
      return { subSessions: { ...state.subSessions, [subSessionId]: updated } }
    }),

  handleToolEnd: (subSessionId, toolCallId, execUpdates, messageId, updatedMessage) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev) return {}
      const newExecs = prev.toolExecutions.map((t) =>
        t.toolCallId === toolCallId ? { ...t, ...execUpdates } : t
      )
      const newMessages =
        updatedMessage && messageId
          ? prev.messages.map((m) => (m.id === messageId ? updatedMessage : m))
          : prev.messages
      return {
        subSessions: {
          ...state.subSessions,
          [subSessionId]: { ...prev, toolExecutions: newExecs, messages: newMessages }
        }
      }
    }),

  handleAgentEnd: (subSessionId, finalMessage) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev) return {}
      const newMessages: ChatMessage[] = [...prev.messages]
      const now = Date.now()
      // 冻结仍在缓冲中的 thinking（text 已包含在 finalMessage 中，不重复落位）
      if (prev.streamingThinking) {
        newMessages.push({
          id: `${subSessionId}-step-thinking-${newMessages.length}`,
          sessionId: subSessionId,
          role: 'assistant',
          type: 'step_thinking',
          content: prev.streamingThinking,
          metadata: null,
          model: '',
          createdAt: now
        } as ChatMessage)
      }
      if (finalMessage) newMessages.push(finalMessage)

      const updated: SubSessionState = {
        ...prev,
        isStreaming: false,
        streamingContent: '',
        streamingThinking: '',
        streamingToolCall: null,
        completedStreamingToolCalls: [],
        toolExecutions: [],
        messages: newMessages
      }
      return { subSessions: { ...state.subSessions, [subSessionId]: updated } }
    })
}))

// ─── 选择器 ──────────────────────────────────────────────

/** 判断 sessionId 是否为已注册的子会话 */
export function isSubSession(sessionId: string): boolean {
  return sessionId in useSubSessionStore.getState().subSessions
}

/** 当前活跃子会话；没有子会话时返回 null */
export const selectActiveSubSession = (s: SubSessionStore): SubSessionState | null =>
  s.activeSubSessionId ? (s.subSessions[s.activeSubSessionId] ?? null) : null

/**
 * 所有子会话列表（按 startedAt 升序）。
 *
 * ⚠️ zustand + useSyncExternalStore 要求 selector 在数据未变时返回稳定引用,
 * 否则触发 "getSnapshot should be cached" 错误并进入无限重渲染循环。
 * 用 module-scope cache 按 subSessions 引用缓存排序结果。
 */
const EMPTY_SUB_LIST: SubSessionState[] = []
let _lastSubListInput: SubSessionStore['subSessions'] | null = null
let _lastSubListOutput: SubSessionState[] = EMPTY_SUB_LIST
export const selectSubSessionList = (s: SubSessionStore): SubSessionState[] => {
  if (s.subSessions === _lastSubListInput) return _lastSubListOutput
  _lastSubListInput = s.subSessions
  const arr = Object.values(s.subSessions)
  _lastSubListOutput =
    arr.length === 0 ? EMPTY_SUB_LIST : arr.sort((a, b) => a.startedAt - b.startedAt)
  return _lastSubListOutput
}

/** 子会话数量 */
export const selectSubSessionCount = (s: SubSessionStore): number =>
  Object.keys(s.subSessions).length

/** 特定子会话的流式状态（用于 AssistantBubble 的 StreamSource 供给） */
export const selectSubSessionStream =
  (subSessionId: string) =>
  (
    s: SubSessionStore
  ): {
    content: string
    thinking: string
    isStreaming: boolean
    streamingToolCall: { toolName: string; argsText: string } | null
    completedStreamingToolCalls: Array<{ toolName: string; args?: Record<string, unknown> }>
    toolExecutions: ToolExecution[]
    messages: ChatMessage[]
  } => {
    const entry = s.subSessions[subSessionId]
    if (!entry) {
      return {
        content: '',
        thinking: '',
        isStreaming: false,
        streamingToolCall: null,
        completedStreamingToolCalls: EMPTY_COMPLETED,
        toolExecutions: EMPTY_TOOL_EXECUTIONS,
        messages: EMPTY_MESSAGES
      }
    }
    return {
      content: entry.streamingContent,
      thinking: entry.streamingThinking,
      isStreaming: entry.isStreaming,
      streamingToolCall: entry.streamingToolCall,
      completedStreamingToolCalls: entry.completedStreamingToolCalls,
      toolExecutions: entry.toolExecutions,
      messages: entry.messages
    }
  }
