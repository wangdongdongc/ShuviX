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
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { isAssistantMessage } from '../messageGuards'
import type { InProcessAgentType, SubAgentModelConfig } from './types'
import type { ToolResultDetails } from '../types'

type AnyAgentTool = Agent['state']['tools'][number]

/** 提取一组 Agent 消息的纯文本（用于把注入的 context 消息原样回显到面板卡片） */
function agentMessagesToText(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const c = 'content' in m ? (m as { content: unknown }).content : undefined
      if (typeof c === 'string') return c
      if (Array.isArray(c)) {
        return c
          .filter((p): p is { type: 'text'; text: string } => {
            const part = p as { type?: string; text?: unknown }
            return part.type === 'text' && typeof part.text === 'string'
          })
          .map((p) => p.text)
          .join('\n')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

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
  /**
   * LLM 日志（可选；桌面注入 httpLogService，扩展省略）。
   * 子代理每次 LLM 请求经 logRequest 记入日志（sessionId 用父会话，便于在 LLM 日志里归到可见会话下），
   * 响应到达（message_end）再 updateUsage 回填用量。
   */
  httpLog?: {
    logRequest: (params: {
      sessionId: string
      provider: string
      model: string
      payload: unknown
    }) => string
    updateUsage: (
      logId: string,
      input: number,
      output: number,
      total: number,
      responseJson?: string
    ) => void
  }
}

export interface RunTaskParams {
  parentSessionId: string
  parentToolCallId?: string
  agentType: InProcessAgentType
  prompt: string
  description: string
  modelConfig: SubAgentModelConfig
  /**
   * prompt 中的内联 Token（slash 命令 / skill）字典。提供时：发给 Agent 的文本经 resolveTokensForAgent
   * 解析为真实指令（展开模板），而 prompt 原文（含 marker）随 sub_session_register 广播供面板渲染标签。
   */
  promptInlineTokens?: Record<string, InlineToken>
  parentAbortSignal?: AbortSignal
  /**
   * 在 prompt 之前预置进子代理上下文的消息（如笔记本会话把当前 md 内容作为一条 user message 注入）。
   * 这些消息进 LLM 上下文。其文本会随 sub_session_register 的 contextNote 广播给面板，
   * 故面板「笔记本内容」卡片即这些消息的真实内容（与实际发给 LLM 的 UserMessage 一致，不再另传 raw）。
   */
  contextMessages?: AgentMessage[]
}

export interface SubAgentManager {
  runTask: (params: RunTaskParams) => Promise<{ result: string }>
  /**
   * 继续与一个已存在子代理对话：复用其 Agent（保留历史）追加一轮 user prompt（fire-and-forget）。
   * 面板先收到 user_message（后续用户消息内联到转写），随后流式事件如常，末了再发 sub_session_end。
   * 子会话不存在或已中止时抛错。
   */
  continueTask: (params: {
    subSessionId: string
    text: string
    inlineTokens?: Record<string, InlineToken>
  }) => Promise<void>
  /**
   * 用户中断一个运行中的子代理：停止当前生成但保留已产出的部分结果，按「已完成」收尾
   * （区别于 abort/destroy 的失败/销毁语义——子会话保留在面板，用户可继续追问或显式删除）。
   */
  interrupt: (subSessionId: string) => void
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
  /** 用户主动中断（软停止）：保留部分结果、按「已完成」收尾，区别于 aborted 的失败态 */
  interrupted: boolean
  /** 待回填用量的 LLM 日志 ID 队列（onPayload 入队、message_end 出队 → updateUsage） */
  pendingLogIds: string[]
}

/** 创建一个子代理会话管理器（注入端适配依赖） */
export function createSubAgentManager(deps: SubAgentManagerDeps): SubAgentManager {
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

  function parentOf(subSessionId: string): string | undefined {
    for (const [parent, set] of byParent) if (set.has(subSessionId)) return parent
    return undefined
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

    // 每条 assistant 消息完成 → 回填对应 LLM 请求日志的用量（与 onPayload 入队一一对应）
    if (event.type === 'message_end') {
      const s = sessions.get(subSessionId)
      const msg = event.message
      if (s && deps.httpLog && isAssistantMessage(msg)) {
        const logId = s.pendingLogIds.shift()
        if (logId) {
          const usage = msg.usage
          let responseJson: string | undefined
          try {
            responseJson = JSON.stringify(
              { content: msg.content, stopReason: msg.stopReason },
              null,
              2
            )
          } catch {
            /* 序列化失败则不存响应 */
          }
          deps.httpLog.updateUsage(
            logId,
            usage?.input ?? 0,
            usage?.output ?? 0,
            usage?.totalTokens ?? 0,
            responseJson
          )
        }
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
      // 转发工具结构化详情（edit diff 等），与主对话框一致 → 子代理面板也能渲染 DiffViewer
      const details = (result as { details?: ToolResultDetails } | undefined)?.details
      deps.broadcast({
        type: 'tool_end',
        sessionId: subSessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName ?? '',
        result: text,
        isError: result?.isError ?? false,
        messageId,
        details
      })
      return
    }
  }

  function createSession(
    parentSessionId: string,
    agentType: InProcessAgentType,
    modelConfig: SubAgentModelConfig,
    contextMessages?: AgentMessage[]
  ): SubAgentSession {
    const subSessionId = `sub-${uuid()}`
    const tools = deps.resolveTools(agentType, parentSessionId)
    const resolvedModel = deps.buildModel(modelConfig)
    // onPayload 与 session 共享同一数组引用（session 在 agent 之后构造，故先建数组）
    const pendingLogIds: string[] = []

    const httpLog = deps.httpLog
    const agent = new Agent({
      initialState: {
        systemPrompt: agentType.systemPrompt,
        model: resolvedModel,
        // 默认 'off'；笔记本等把会话思考深度经 modelConfig 传入即生效
        thinkingLevel: modelConfig.thinkingLevel ?? 'off',
        // 预置上下文消息（如笔记本内容）先落上下文，随后 agent.prompt(userText) 接其后
        messages: contextMessages ? [...contextMessages] : [],
        tools
      },
      getApiKey: (p) => deps.getApiKey(p),
      // LLM 日志：每次请求记一条（归到父会话），message_end 再回填用量
      onPayload: httpLog
        ? (payload, requestModel) => {
            pendingLogIds.push(
              httpLog.logRequest({
                sessionId: parentSessionId,
                provider: requestModel.provider,
                model: requestModel.id,
                payload
              })
            )
          }
        : undefined
    })

    agent.subscribe((event: AgentEvent) => forwardEvent(event, subSessionId, agent))

    const session: SubAgentSession = {
      subSessionId,
      type: agentType,
      agent,
      abortController: new AbortController(),
      pendingToolCalls: new Map(),
      finalizedToolCalls: new Set(),
      aborted: false,
      interrupted: false,
      pendingLogIds
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

  function interrupt(subSessionId: string): void {
    const s = sessions.get(subSessionId)
    if (!s) return
    // 软停止：标记为「用户中断」，终结在飞工具调用，停止当前生成。
    // 不动 sessions/byParent 登记 —— runTask/continueTask 的 waitForIdle 解除后会照常广播
    // sub_session_end（isError=false），子会话保留在面板供继续追问或显式删除。
    s.interrupted = true
    finalizeAbortedToolCalls(subSessionId)
    s.agent.abort()
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
      const {
        parentSessionId,
        agentType,
        prompt,
        description,
        modelConfig,
        parentAbortSignal,
        contextMessages,
        promptInlineTokens
      } = params
      // 面板「笔记本内容」卡片 = 实际注入的 context 消息文本（与发给 LLM 的 UserMessage 一致）
      const contextNote = contextMessages?.length ? agentMessagesToText(contextMessages) : undefined

      // 内联 Token（slash 命令 / skill）：prompt 原文（含 marker）用于面板展示标签；
      // 发给 Agent 的文本经解析展开为真实指令（如 skill 模板正文）。
      const hasTokens = promptInlineTokens && Object.keys(promptInlineTokens).length > 0
      const llmPrompt = hasTokens ? resolveTokensForAgent(prompt, promptInlineTokens) : prompt

      // 不限制并发子代理数量：可同时堆叠任意多个（面板纵向手风琴展示）。
      const session = createSession(parentSessionId, agentType, modelConfig, contextMessages)

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
        prompt,
        inlineTokens: hasTokens ? promptInlineTokens : undefined,
        contextNote
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
        await session.agent.prompt(llmPrompt)
        await session.agent.waitForIdle()
      } catch (err: unknown) {
        execError = err instanceof Error ? err.message : String(err)
        deps.logger?.error(`Sub-agent subSession=${session.subSessionId} error: ${execError}`)
      }

      if (session.aborted && session.pendingToolCalls.size > 0) {
        finalizeAbortedToolCalls(session.subSessionId)
      }

      // 用户中断：保留已产出的部分结果、按「已完成」收尾（isError=false）；
      // abort（父级中断）仍按失败态返回 abortedNote。
      const result = session.interrupted
        ? extractResult(session.agent.state.messages)
        : session.aborted
          ? abortedNote()
          : extractResult(session.agent.state.messages, execError)
      const isError = session.interrupted ? false : !!execError || session.aborted

      deps.broadcast({
        type: 'sub_session_end',
        sessionId: session.subSessionId,
        parentSessionId,
        result,
        isError
      })

      return { result }
    },

    async continueTask(params: {
      subSessionId: string
      text: string
      inlineTokens?: Record<string, InlineToken>
    }): Promise<void> {
      const { subSessionId, text, inlineTokens } = params
      const session = sessions.get(subSessionId)
      if (!session) throw new Error(`Sub-session not found: ${subSessionId}`)
      if (session.aborted) throw new Error(`Sub-session already aborted: ${subSessionId}`)
      // 新一轮追问：清除上一轮的「用户中断」标记
      session.interrupted = false
      const parentSessionId = parentOf(subSessionId) ?? ''

      // 内联 Token（slash 命令等）：前端已展开，后端解析为发给 Agent 的真实文本；
      // 原始标记文本 + tokens 落入消息 metadata，供面板渲染 slash 命令标签（与主会话同形）。
      const hasTokens = inlineTokens && Object.keys(inlineTokens).length > 0
      const promptText = hasTokens ? resolveTokensForAgent(text, inlineTokens) : text

      // 后续用户消息广播到面板（与主会话 user_message 同形 → 内联进子会话转写）
      const userMsg = {
        id: `${subSessionId}-user-${Date.now()}`,
        sessionId: subSessionId,
        role: 'user' as const,
        type: 'text' as const,
        content: text,
        metadata: hasTokens ? { inlineTokens } : null,
        model: '',
        createdAt: Date.now()
      }
      deps.broadcast({
        type: 'user_message',
        sessionId: subSessionId,
        message: JSON.stringify(userMsg)
      })

      let execError: string | undefined
      try {
        await session.agent.prompt(promptText)
        await session.agent.waitForIdle()
      } catch (err: unknown) {
        execError = err instanceof Error ? err.message : String(err)
        deps.logger?.error(`Sub-agent continue subSession=${subSessionId} error: ${execError}`)
      }

      if (session.aborted && session.pendingToolCalls.size > 0) {
        finalizeAbortedToolCalls(subSessionId)
      }

      const result = session.interrupted
        ? extractResult(session.agent.state.messages)
        : session.aborted
          ? abortedNote()
          : extractResult(session.agent.state.messages, execError)
      const isError = session.interrupted ? false : !!execError || session.aborted

      deps.broadcast({
        type: 'sub_session_end',
        sessionId: subSessionId,
        parentSessionId,
        result,
        isError
      })
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

    interrupt,

    destroy,

    has(subSessionId: string): boolean {
      return sessions.has(subSessionId)
    }
  }
}

export type { AnyAgentTool, AgentToolResult }
