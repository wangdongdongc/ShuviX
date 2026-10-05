/**
 * 子智能体临时会话 store
 *
 * 后台任务面板里派生 agent 的那一条使用的纯内存状态。每个派生 agent 一个 SubSessionState：
 *  - **元信息**（展示名、系统提示词、初始 prompt、状态、结果）来自 `sub_session_register` /
 *    `sub_session_end` 余项；
 *  - **转写与实时态**（messages / 流式正文 / 工具执行）只由 **`applyAgentView`** 写（P3-08）：订阅那个派生
 *    agent 的视图（`useAgentView`）时镜像进来，形状与主会话同一套推导。没登记过的 agent 不建条目
 *    （PIN-07；面板接上视图在 P3-14）。
 *
 * 全局（不按父会话过滤）：跨主会话切换仍保留；用户点 × 才移除。
 */

import { create } from 'zustand'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { AgentView } from '@shuvix/chat-protocol/types/sessionView'
import type { ChatMessage, ToolExecution } from './chatStore'
import {
  EMPTY_TOOLS,
  deriveStream,
  deriveToolExecutions,
  shareStructure
} from './viewDerivation'

/** 子智能体运行时状态 */
export type SubSessionStatus = 'running' | 'done' | 'error'

/** 单个子会话的完整状态 */
export interface SubSessionState {
  subSessionId: string
  parentSessionId: string
  /** 父 Agent 派发本子会话的 tool_call id；有值 = Agent 自行触发（内联展示），无值 = 用户主动触发（右侧面板） */
  parentToolCallId?: string
  subAgentName: string
  displayName: string
  description: string
  /** 子智能体的系统提示词（register 事件携带） */
  systemPrompt: string
  /** 父 Agent 发给子智能体的初始 user prompt（register 事件携带） */
  prompt: string
  /** prompt 中内联 Token（slash 命令 / skill）字典；面板据此把 prompt 渲染为命令标签 + 文本 */
  promptInlineTokens?: Record<string, InlineToken>
  /** 额外注入上下文的人读文本（runTask 的 contextMessages）；面板以折叠用户消息卡展示 */
  contextNote?: string
  status: SubSessionStatus
  startedAt: number
  endedAt?: number
  /** 最终返回给父 Agent 的 result 文本（仅在 end 后有值） */
  result?: string
  /** 子会话消息列表（agent 视图的 `messages`，不持久化） */
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
  /** 最近一次镜像进来的 agent 视图（结构共享用；没订阅过 → undefined，运行标记由余项维护） */
  view?: AgentView
}

const EMPTY_TOOL_EXECUTIONS: ToolExecution[] = []
const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_COMPLETED: Array<{ toolName: string; args?: Record<string, unknown> }> = []

interface SubSessionStore {
  subSessions: Record<string, SubSessionState>

  // ─── 生命周期 ──
  register(params: {
    subSessionId: string
    parentSessionId: string
    parentToolCallId?: string
    subAgentName: string
    displayName: string
    description: string
    systemPrompt: string
    prompt: string
    promptInlineTokens?: Record<string, InlineToken>
    contextNote?: string
  }): void
  markEnded(params: { subSessionId: string; result: string; isError?: boolean }): void
  /** 用户显式关闭：移除 store 条目（同时应触发 IPC subSession:destroy） */
  close(subSessionId: string): void
  /**
   * `agent_start` / `agent_end` 余项：没订阅视图时据此显示「在跑」；订阅着视图就以视图为准（不动）
   */
  setRunning(subSessionId: string, running: boolean): void
}

function createEmpty(params: {
  subSessionId: string
  parentSessionId: string
  parentToolCallId?: string
  subAgentName: string
  displayName: string
  description: string
  systemPrompt: string
  prompt: string
  promptInlineTokens?: Record<string, InlineToken>
  contextNote?: string
}): SubSessionState {
  return {
    subSessionId: params.subSessionId,
    parentSessionId: params.parentSessionId,
    parentToolCallId: params.parentToolCallId,
    subAgentName: params.subAgentName,
    displayName: params.displayName,
    description: params.description,
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
    promptInlineTokens: params.promptInlineTokens,
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

  register: (params) =>
    set((state) => {
      // 已存在则不覆盖（但理论上每个 subSessionId 只 register 一次）
      if (state.subSessions[params.subSessionId]) return {}
      const entry = createEmpty(params)
      return { subSessions: { ...state.subSessions, [params.subSessionId]: entry } }
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
            // 订阅着视图：运行状态以视图为准
            isStreaming: prev.view ? prev.isStreaming : false
          }
        }
      }
    }),

  close: (subSessionId) =>
    set((state) => {
      if (!state.subSessions[subSessionId]) return {}
      const { [subSessionId]: _, ...rest } = state.subSessions
      return { subSessions: rest }
    }),

  setRunning: (subSessionId, running) =>
    set((state) => {
      const prev = state.subSessions[subSessionId]
      if (!prev || prev.view !== undefined) return {}
      if (prev.isStreaming === running && (!running || prev.status === 'running')) return {}
      return {
        subSessions: {
          ...state.subSessions,
          [subSessionId]: {
            ...prev,
            isStreaming: running,
            ...(running ? { status: 'running' as const, endedAt: undefined, result: undefined } : {})
          }
        }
      }
    })
}))

/**
 * 把一份派生 agent 的视图镜像进它的条目 —— 转写与实时态的**唯一写入口**（P3-08）。元信息（展示名、
 * 提示词、状态）不动；没登记过的 agent 不建条目（PIN-07）。与上一份逐项共享，没变就不写。
 */
export function applyAgentView(agentId: string, view: AgentView): void {
  useSubSessionStore.setState((state) => {
    const prev = state.subSessions[agentId]
    if (!prev) return state
    const shared = shareStructure(prev.view, view)
    if (shared === prev.view) return state
    const stream = deriveStream(shared, false, {
      content: prev.streamingContent,
      thinking: prev.streamingThinking,
      isStreaming: prev.isStreaming,
      images: [],
      streamingToolCall: prev.streamingToolCall,
      completedStreamingToolCalls: prev.completedStreamingToolCalls
    })
    const tools = deriveToolExecutions(shared, undefined, prev.toolExecutions)
    return {
      subSessions: {
        ...state.subSessions,
        [agentId]: {
          ...prev,
          view: shared,
          messages: shared.messages,
          streamingContent: stream.content,
          streamingThinking: stream.thinking,
          isStreaming: stream.isStreaming,
          streamingToolCall: stream.streamingToolCall,
          completedStreamingToolCalls: stream.completedStreamingToolCalls,
          toolExecutions: tools === EMPTY_TOOLS ? EMPTY_TOOL_EXECUTIONS : tools
        }
      }
    }
  })
}

// ─── 选择器 ──────────────────────────────────────────────

/** 判断 sessionId 是否为已注册的子会话 */
export function isSubSession(sessionId: string): boolean {
  return sessionId in useSubSessionStore.getState().subSessions
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
