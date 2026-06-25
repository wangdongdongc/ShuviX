/**
 * 子代理会话管理器（跨端共享核心，从桌面 AgentManager 抽取）。
 *
 * 派生进程内嵌套 pi-agent-core Agent，订阅其事件翻译成 ChatEvent 广播（sessionId=subSessionId），
 * 抽取最终文本结果供父 tool_call 使用，并处理 abort 传播 / 在飞工具调用的"已中止"终结。
 *
 * 平台相关项全部经注入：工具解析(resolveTools)、模型构建(buildModel)、apiKey(getApiKey)、
 * 事件广播(broadcast)、可选的会话登记(onRegister/onUnregister，桌面接 transientSessionRegistry)。
 */
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentToolResult
} from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { v4 as uuid } from 'uuid'
import type { ChatEvent, ChatTokenUsage } from '@shuvix/chat-protocol/events'
import { isAssistantMessage } from '../messageGuards'
import type { InProcessAgentType, SubAgentModelConfig } from './types'

type AnyAgentTool = Agent['state']['tools'][number]

/** 子代理会话登记元信息（onRegister 回调；桌面据此填充 transientSessionRegistry） */
export interface SubAgentRegisterMeta {
  subSessionId: string
  parentSessionId: string
  subAgentName: string
  displayName: string
  description: string
}

export interface SubAgentManagerDeps {
  /** 把 agentType.tools 解析为可执行工具实例（含截断/落盘包装），端特定 */
  resolveTools: (agentType: InProcessAgentType, parentSessionId: string) => AnyAgentTool[]
  /** 把模型配置构建为 pi-ai Model，端特定（桌面 providerDao / 扩展 providerInfo+env） */
  buildModel: (config: SubAgentModelConfig) => Model<Api>
  /** 取 provider 的 apiKey（pi-agent-core getApiKey） */
  getApiKey: (provider: string) => string | undefined | Promise<string | undefined>
  /** 向前端广播 ChatEvent */
  broadcast: (event: ChatEvent) => void
  /** 日志（可选） */
  logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }
  /** abort 时工具调用展示的文案（懒解析以反映当前 i18n 语言；缺省英文） */
  getAbortedNote?: () => string
  /** 子会话登记/注销（可选；桌面接 transientSessionRegistry 供 IPC/右侧面板发现） */
  onRegister?: (meta: SubAgentRegisterMeta) => void
  onUnregister?: (subSessionId: string) => void
  /** 最大并发子代理数（默认 5） */
  maxConcurrent?: number
}

export interface RunTaskParams {
  parentSessionId: string
  parentToolCallId?: string
  agentType: InProcessAgentType
  prompt: string
  description: string
  modelConfig: SubAgentModelConfig
  parentAbortSignal?: AbortSignal
}

export interface SubAgentManager {
  runTask: (params: RunTaskParams) => Promise<{ result: string }>
  abortAll: (parentSessionId: string) => void
  destroyAll: (parentSessionId: string) => void
  destroy: (subSessionId: string) => void
  has: (subSessionId: string) => boolean
}

interface SubAgentSession {
  subSessionId: string
  type: InProcessAgentType
  agent: Agent
  abortController: AbortController
  pendingToolCalls: Map<string, string>
  finalizedToolCalls: Set<string>
  aborted: boolean
}

/** 创建一个子代理会话管理器（注入端适配依赖） */
export function createSubAgentManager(deps: SubAgentManagerDeps): SubAgentManager {
  const MAX_CONCURRENT = deps.maxConcurrent ?? 5
  const abortedNote = (): string => deps.getAbortedNote?.() || 'Aborted by user.'
  const byParent = new Map<string, Set<string>>()
  const sessions = new Map<string, SubAgentSession>()

  function removeSession(parentSessionId: string, subSessionId: string): void {
    sessions.delete(subSessionId)
    const set = byParent.get(parentSessionId)
    if (set) {
      set.delete(subSessionId)
      if (set.size === 0) byParent.delete(parentSessionId)
    }
  }

  function extractResult(messages: AgentMessage[], execError?: string): string {
    let lastText = ''
    let lastStopReason = ''
    let lastErrorMessage = ''
    let assistantCount = 0
    let toolUseCount = 0
    for (const msg of messages) {
      if (!isAssistantMessage(msg)) continue
      assistantCount++
      if (msg.stopReason) lastStopReason = msg.stopReason
      if (msg.errorMessage) lastErrorMessage = msg.errorMessage
      if (typeof msg.content === 'string') {
        if (msg.content) lastText = msg.content
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) lastText = part.text
          else if (part.type === 'toolCall') toolUseCount++
        }
      }
    }

    if (lastText) {
      const notes: string[] = []
      if (lastStopReason && lastStopReason !== 'stop') notes.push(`stopReason=${lastStopReason}`)
      if (lastErrorMessage) notes.push(`error=${lastErrorMessage}`)
      if (execError) notes.push(`execError=${execError}`)
      return notes.length > 0 ? `${lastText}\n\n[Note] ${notes.join('; ')}` : lastText
    }

    const parts: string[] = []
    parts.push(
      `Sub-agent did not produce a final text response (${assistantCount} assistant message(s), ${toolUseCount} tool call(s)).`
    )
    if (lastStopReason) parts.push(`stopReason=${lastStopReason}.`)
    if (lastErrorMessage) parts.push(`Model errorMessage: ${lastErrorMessage}.`)
    if (execError) parts.push(`Execution threw: ${execError}.`)
    return parts.join(' ')
  }

  function extractUsage(messages: AgentMessage[]): ChatTokenUsage {
    const details: ChatTokenUsage['details'] = []
    for (const m of messages) {
      if (isAssistantMessage(m) && m.usage) {
        details.push({
          input: m.usage.input || 0,
          output: m.usage.output || 0,
          cacheRead: m.usage.cacheRead || 0,
          cacheWrite: m.usage.cacheWrite || 0,
          total: m.usage.totalTokens || 0,
          stopReason: m.stopReason || ''
        })
      }
    }
    const totals = details.reduce(
      (acc, d) => ({
        input: acc.input + d.input,
        output: acc.output + d.output,
        cacheRead: acc.cacheRead + d.cacheRead,
        cacheWrite: acc.cacheWrite + d.cacheWrite,
        total: acc.total + d.total
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    )
    return { ...totals, details }
  }

  function finalizeAbortedToolCalls(subSessionId: string): void {
    const s = sessions.get(subSessionId)
    if (!s) return
    for (const [toolCallId, toolName] of s.pendingToolCalls) {
      const messageId = `${subSessionId}-tc-${toolCallId}`
      s.finalizedToolCalls.add(toolCallId)
      deps.broadcast({
        type: 'tool_end',
        sessionId: subSessionId,
        toolCallId,
        toolName,
        result: abortedNote(),
        isError: true,
        messageId
      })
    }
    s.pendingToolCalls.clear()
  }

  function forwardEvent(event: AgentEvent, subSessionId: string, agent: Agent): void {
    if (event.type === 'agent_start') {
      deps.broadcast({ type: 'agent_start', sessionId: subSessionId })
      return
    }

    if (event.type === 'agent_end') {
      const lastAssistant = [...agent.state.messages].reverse().find(isAssistantMessage)
      let content = ''
      if (lastAssistant) {
        if (typeof lastAssistant.content === 'string') {
          content = lastAssistant.content
        } else if (Array.isArray(lastAssistant.content)) {
          content = lastAssistant.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
        }
      }
      const usage = extractUsage(agent.state.messages)
      const finalMsg = {
        id: `${subSessionId}-final-${Date.now()}`,
        sessionId: subSessionId,
        role: 'assistant' as const,
        type: 'text' as const,
        content,
        metadata: usage.total > 0 ? { usage } : null,
        model: lastAssistant?.model || '',
        createdAt: Date.now()
      }
      deps.broadcast({
        type: 'agent_end',
        sessionId: subSessionId,
        message: JSON.stringify(finalMsg),
        usage: usage.total > 0 ? usage : undefined
      })
      return
    }

    if (event.type === 'message_update') {
      const msgEvent = event.assistantMessageEvent
      if (msgEvent.type === 'text_delta' && msgEvent.delta) {
        deps.broadcast({ type: 'text_delta', sessionId: subSessionId, delta: msgEvent.delta })
      } else if (msgEvent.type === 'thinking_delta' && msgEvent.delta) {
        deps.broadcast({ type: 'thinking_delta', sessionId: subSessionId, delta: msgEvent.delta })
      }
      return
    }

    if (event.type === 'tool_execution_start') {
      const s = sessions.get(subSessionId)
      if (s && !s.aborted) s.pendingToolCalls.set(event.toolCallId, event.toolName)
      const messageId = `${subSessionId}-tc-${event.toolCallId}`
      deps.broadcast({
        type: 'tool_start',
        sessionId: subSessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolArgs: (event.args as Record<string, unknown>) ?? {},
        messageId
      })
      return
    }

    if (event.type === 'tool_execution_end') {
      const s = sessions.get(subSessionId)
      if (s?.finalizedToolCalls.has(event.toolCallId)) {
        s.finalizedToolCalls.delete(event.toolCallId)
        return
      }
      if (s) s.pendingToolCalls.delete(event.toolCallId)

      const messageId = `${subSessionId}-tc-${event.toolCallId}`
      const result = event.result
      const content = result?.content as Array<{ type: string; text?: string }> | undefined
      const text =
        content
          ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n') ?? ''
      deps.broadcast({
        type: 'tool_end',
        sessionId: subSessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName ?? '',
        result: text,
        isError: result?.isError ?? false,
        messageId
      })
      return
    }
  }

  function createSession(
    parentSessionId: string,
    agentType: InProcessAgentType,
    modelConfig: SubAgentModelConfig
  ): SubAgentSession {
    const subSessionId = `sub-${uuid()}`
    const tools = deps.resolveTools(agentType, parentSessionId)
    const resolvedModel = deps.buildModel(modelConfig)

    const agent = new Agent({
      initialState: {
        systemPrompt: agentType.systemPrompt,
        model: resolvedModel,
        thinkingLevel: 'off',
        messages: [],
        tools
      },
      getApiKey: (p) => deps.getApiKey(p)
    })

    agent.subscribe((event: AgentEvent) => forwardEvent(event, subSessionId, agent))

    const session: SubAgentSession = {
      subSessionId,
      type: agentType,
      agent,
      abortController: new AbortController(),
      pendingToolCalls: new Map(),
      finalizedToolCalls: new Set(),
      aborted: false
    }

    sessions.set(subSessionId, session)
    let set = byParent.get(parentSessionId)
    if (!set) {
      set = new Set()
      byParent.set(parentSessionId, set)
    }
    set.add(subSessionId)

    deps.logger?.info(
      `Created sub-agent subSession=${subSessionId} type=${agentType.name} parent=${parentSessionId}`
    )
    return session
  }

  function destroy(subSessionId: string): void {
    const s = sessions.get(subSessionId)
    if (!s) return
    s.agent.abort()
    s.abortController.abort()
    // 注：父子归属在 byParent 中查（onUnregister 仅清外部登记表，不再回查归属）
    for (const [parent, set] of byParent) {
      if (set.has(subSessionId)) {
        removeSession(parent, subSessionId)
        break
      }
    }
    deps.onUnregister?.(subSessionId)
  }

  return {
    async runTask(params: RunTaskParams): Promise<{ result: string }> {
      const { parentSessionId, agentType, prompt, description, modelConfig, parentAbortSignal } =
        params

      const parentSet = byParent.get(parentSessionId)
      if (parentSet && parentSet.size >= MAX_CONCURRENT) {
        throw new Error(
          `Maximum concurrent sub-agents (${MAX_CONCURRENT}) reached. Wait for existing tasks to complete.`
        )
      }

      const session = createSession(parentSessionId, agentType, modelConfig)

      deps.onRegister?.({
        subSessionId: session.subSessionId,
        parentSessionId,
        subAgentName: agentType.name,
        displayName: agentType.displayName,
        description
      })

      deps.broadcast({
        type: 'sub_session_register',
        sessionId: session.subSessionId,
        parentSessionId,
        subAgentName: agentType.name,
        displayName: agentType.displayName,
        description,
        systemPrompt: agentType.systemPrompt,
        prompt
      })

      if (parentAbortSignal) {
        if (parentAbortSignal.aborted) {
          session.aborted = true
          finalizeAbortedToolCalls(session.subSessionId)
          session.abortController.abort()
          session.agent.abort()
        } else {
          parentAbortSignal.addEventListener(
            'abort',
            () => {
              session.aborted = true
              finalizeAbortedToolCalls(session.subSessionId)
              session.agent.abort()
            },
            { once: true }
          )
        }
      }

      let execError: string | undefined
      try {
        await session.agent.prompt(prompt)
        await session.agent.waitForIdle()
      } catch (err: unknown) {
        execError = err instanceof Error ? err.message : String(err)
        deps.logger?.error(`Sub-agent subSession=${session.subSessionId} error: ${execError}`)
      }

      if (session.aborted && session.pendingToolCalls.size > 0) {
        finalizeAbortedToolCalls(session.subSessionId)
      }

      const result = session.aborted
        ? abortedNote()
        : extractResult(session.agent.state.messages, execError)
      const isError = !!execError || session.aborted

      deps.broadcast({
        type: 'sub_session_end',
        sessionId: session.subSessionId,
        parentSessionId,
        result,
        isError
      })

      return { result }
    },

    abortAll(parentSessionId: string): void {
      const ids = byParent.get(parentSessionId)
      if (!ids) return
      for (const id of ids) {
        const s = sessions.get(id)
        if (s) {
          s.agent.abort()
          s.abortController.abort()
        }
      }
    },

    destroyAll(parentSessionId: string): void {
      const ids = byParent.get(parentSessionId)
      if (!ids) return
      for (const id of [...ids]) destroy(id)
    },

    destroy,

    has(subSessionId: string): boolean {
      return sessions.has(subSessionId)
    }
  }
}

export type { AnyAgentTool, AgentToolResult }
