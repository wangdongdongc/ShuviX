/**
 * 子智能体会话管理器 — 进程内 Agent 子智能体的运行时管理
 *
 * 管理 explore 等进程内子智能体的 Agent 实例生命周期。
 * 纯内存管理，不写 DB，父会话销毁时统一清理。
 *
 * 每个 runTask 调用会生成一个临时的 subSessionId，并以该 id 为
 * event.sessionId 广播标准 ChatEvent（agent_start / text_delta / tool_start /
 * tool_end / agent_end 等），由右侧 Sub-agent 面板负责流式展示。
 */

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool
} from '@mariozechner/pi-agent-core'
import type { TSchema } from 'typebox'
import { v4 as uuid } from 'uuid'
import { isAssistantMessage } from '../utils/messageGuards'
import type { ChatTokenUsage } from '../frontend/core'
import { getBuiltinToolEntries } from '../services/toolRegistry'
import { SkillTool } from '../services/skillTool'
import type { ToolContext } from '../services/toolContext'
import { resolveModel } from '../services/agentModelResolver'
import { providerDao } from '../dao/providerDao'
import { mcpService } from '../services/mcpService'
import {
  wrapToolOutput,
  getOutputStrategy,
  type ProcessToolOutputOverrides
} from '../services/wrapToolOutput'
import { chatFrontendRegistry } from '../frontend/core'
import type { SubAgentModelConfig } from './types'
import { transientSessionRegistry } from './transientSessionRegistry'
import { t } from '../i18n'
import { createLogger } from '../logger'

const log = createLogger('SubAgent')

// ─── 子智能体类型定义 ──────────────────────────────────────────

/** 进程内子智能体类型（工具集 + 系统提示 + 行为配置） */
export interface InProcessAgentType {
  /** 类型名称（如 'explore'） */
  name: string
  /** UI 展示名（右侧 Sub-agent 面板子 Tab 标题） */
  displayName: string
  /** 描述（展示给主 Agent，帮助它决定何时使用） */
  description: string
  /** 固定工具名称列表（不受父级 enabledTools 限制） */
  tools: string[]
  /** 最大 agent loop 轮次 */
  maxTurns: number
  /** 子智能体专用系统提示词 */
  systemPrompt: string
}

// ─── 子智能体会话 ──────────────────────────────────────────

interface SubAgentSession {
  subSessionId: string
  type: InProcessAgentType
  agent: Agent
  abortController: AbortController
  /** 已开始但尚未结束的工具调用：toolCallId → toolName */
  pendingToolCalls: Map<string, string>
  /**
   * 已被 abort 主动 finalize 的 toolCallId；
   * 后续从 pi-agent-core 到达的 tool_execution_end 会被忽略，
   * 避免覆盖"已被用户中止"为"完成"。
   */
  finalizedToolCalls: Set<string>
  /** 是否已被 abort（来自父 agent 或用户直接关闭子 tab） */
  aborted: boolean
}

// ─── 工具构建 ──────────────────────────────────────────

type AnyAgentTool = Agent['state']['tools'][number]

function buildSubAgentTools(ctx: ToolContext, agentType: InProcessAgentType): AnyAgentTool[] {
  const tools: AnyAgentTool[] = []
  const builtinEntries = getBuiltinToolEntries()
  const builtinMap = new Map(builtinEntries.filter((e) => e.factory).map((e) => [e.name, e]))
  const skillNames: string[] = []
  const wrap = (tool: object): AnyAgentTool =>
    wrapToolOutput(
      tool as AgentTool<TSchema, unknown>,
      ctx.sessionId,
      getOutputStrategy(tool),
      pickOverrides(tool)
    ) as unknown as AnyAgentTool

  for (const toolName of agentType.tools) {
    if (toolName.startsWith('mcp:')) {
      const serverName = toolName.slice(4)
      for (const mcpTool of mcpService.getAgentToolsByServerName(serverName)) {
        tools.push(wrap(mcpTool))
      }
    } else if (toolName.startsWith('skill:')) {
      skillNames.push(toolName.slice(6))
    } else {
      const entry = builtinMap.get(toolName)
      if (entry?.factory) {
        tools.push(wrap(entry.factory(ctx)))
      }
    }
  }

  if (skillNames.length > 0) {
    tools.push(wrap(new SkillTool(skillNames)))
  }

  return tools
}

function pickOverrides(tool: object): ProcessToolOutputOverrides | undefined {
  const t = tool as { outputMaxBytes?: number; outputMaxLines?: number }
  if (t.outputMaxBytes == null && t.outputMaxLines == null) return undefined
  return { maxBytes: t.outputMaxBytes, maxLines: t.outputMaxLines }
}

// ─── SubAgentManager ──────────────────────────────────────────

export interface RunTaskParams {
  parentSessionId: string
  parentToolCallId?: string
  agentType: InProcessAgentType
  prompt: string
  description: string
  modelConfig: SubAgentModelConfig
  parentAbortSignal?: AbortSignal
}

/** 进程内子智能体会话管理器 */
class SubAgentManager {
  /** parentSessionId → Set<subSessionId> */
  private byParent = new Map<string, Set<string>>()
  /** subSessionId → SubAgentSession */
  private sessions = new Map<string, SubAgentSession>()

  /** 最大并发子智能体数 */
  private readonly MAX_CONCURRENT = 5

  /** 生成子智能体会话并执行 prompt；返回最终 result 文本供父 tool_call 使用 */
  async runTask(params: RunTaskParams): Promise<{ result: string }> {
    const { parentSessionId, agentType, prompt, description, modelConfig, parentAbortSignal } =
      params

    const parentSet = this.byParent.get(parentSessionId)
    if (parentSet && parentSet.size >= this.MAX_CONCURRENT) {
      throw new Error(
        `Maximum concurrent sub-agents (${this.MAX_CONCURRENT}) reached. Wait for existing tasks to complete.`
      )
    }

    const session = this.createSession(parentSessionId, agentType, modelConfig)

    // 注册到临时会话表（用于 IPC 分叉与 UI 面板发现）
    transientSessionRegistry.register({
      sessionId: session.subSessionId,
      parentSessionId,
      subAgentName: agentType.name,
      displayName: agentType.displayName,
      description
    })

    // 广播子会话注册事件 → 右侧 Sub-agent 面板显示新子 Tab
    chatFrontendRegistry.broadcast({
      type: 'sub_session_register',
      sessionId: session.subSessionId,
      parentSessionId,
      subAgentName: agentType.name,
      displayName: agentType.displayName,
      description,
      systemPrompt: agentType.systemPrompt,
      prompt
    })

    // 链接父级中止信号：父 agent 中止时，同步把子 agent 也中止并把在飞的工具调用标记为"已被用户中止"
    if (parentAbortSignal) {
      if (parentAbortSignal.aborted) {
        session.aborted = true
        this.finalizeAbortedToolCalls(session.subSessionId)
        session.abortController.abort()
        session.agent.abort()
      } else {
        parentAbortSignal.addEventListener(
          'abort',
          () => {
            session.aborted = true
            this.finalizeAbortedToolCalls(session.subSessionId)
            session.agent.abort()
          },
          { once: true }
        )
      }
    }

    // 执行 prompt
    let execError: string | undefined
    try {
      await session.agent.prompt(prompt)
      await session.agent.waitForIdle()
    } catch (err: unknown) {
      execError = err instanceof Error ? err.message : String(err)
      log.error(`Sub-agent subSession=${session.subSessionId} error: ${execError}`)
    }

    // 若 abort 前还有未 finalize 的工具调用（理论上 listener 已处理，这里做兜底）
    if (session.aborted && session.pendingToolCalls.size > 0) {
      this.finalizeAbortedToolCalls(session.subSessionId)
    }

    const abortedNote = t('agent.toolAborted') || 'Aborted by user.'
    const result = session.aborted
      ? abortedNote
      : this.extractResult(session.agent.state.messages, execError)
    const isError = !!execError || session.aborted

    // 广播子会话结束事件（agent_end 已由 forwardEvent 翻译广播；此事件用于右侧面板状态切换）
    chatFrontendRegistry.broadcast({
      type: 'sub_session_end',
      sessionId: session.subSessionId,
      parentSessionId,
      result,
      isError
    })

    // 保留 registry 条目与 session 直到用户显式关闭 sub-tab（IPC 触发 destroy）
    return { result }
  }

  /** 中止指定父会话的所有子智能体 */
  abortAll(parentSessionId: string): void {
    const ids = this.byParent.get(parentSessionId)
    if (!ids) return
    for (const id of ids) {
      const s = this.sessions.get(id)
      if (s) {
        s.agent.abort()
        s.abortController.abort()
      }
    }
  }

  /** 销毁指定父会话的所有子智能体（清理 registry 与 session） */
  destroyAll(parentSessionId: string): void {
    const ids = this.byParent.get(parentSessionId)
    if (!ids) return
    for (const id of [...ids]) {
      this.destroy(id)
    }
  }

  /** 销毁指定子会话（用户点 × 关闭子 Tab 触发） */
  destroy(subSessionId: string): void {
    const s = this.sessions.get(subSessionId)
    if (!s) return
    s.agent.abort()
    s.abortController.abort()
    const entry = transientSessionRegistry.get(subSessionId)
    if (entry) {
      this.removeSession(entry.parentSessionId, subSessionId)
    }
    transientSessionRegistry.unregister(subSessionId)
  }

  /** 查询是否存在指定子会话 */
  has(subSessionId: string): boolean {
    return this.sessions.has(subSessionId)
  }

  /**
   * 把仍在飞的工具调用标记为"已被用户中止"。
   * 在父 agent abort 或用户显式关闭子 tab 时调用：
   * pi-agent-core 自身不会对进行中的 MCP 等外部工具主动取消 —— 它们会
   * 在后台继续跑到完成并发送 tool_execution_end。为了让子会话面板上
   * 的工具调用立刻呈现"已被用户中止"，我们主动广播 tool_end(isError=true)，
   * 并在 finalizedToolCalls 里登记，后续到达的真实 tool_execution_end 会被忽略，
   * 避免把状态改回"完成"。
   */
  private finalizeAbortedToolCalls(subSessionId: string): void {
    const s = this.sessions.get(subSessionId)
    if (!s) return
    const abortedContent = t('agent.toolAborted') || 'Aborted by user.'
    for (const [toolCallId, toolName] of s.pendingToolCalls) {
      const messageId = `${subSessionId}-tc-${toolCallId}`
      s.finalizedToolCalls.add(toolCallId)
      chatFrontendRegistry.broadcast({
        type: 'tool_end',
        sessionId: subSessionId,
        toolCallId,
        toolName,
        result: abortedContent,
        isError: true,
        messageId
      })
    }
    s.pendingToolCalls.clear()
  }

  // ─── 内部方法 ──────────────────────────────────────────

  private createSession(
    parentSessionId: string,
    agentType: InProcessAgentType,
    modelConfig: SubAgentModelConfig
  ): SubAgentSession {
    const subSessionId = `sub-${uuid()}`

    const subToolContext: ToolContext = {
      sessionId: parentSessionId
    }

    const tools = buildSubAgentTools(subToolContext, agentType)

    const resolvedModel = resolveModel({
      provider: modelConfig.provider,
      model: modelConfig.model,
      capabilities: modelConfig.capabilities
    })

    const agent = new Agent({
      initialState: {
        systemPrompt: agentType.systemPrompt,
        model: resolvedModel,
        thinkingLevel: 'off',
        messages: [],
        tools
      },
      getApiKey: (p) => providerDao.pick(p, ['apiKey'])?.apiKey || undefined
    })

    // 订阅子智能体事件，翻译为标准 ChatEvent 并广播（sessionId=subSessionId）
    agent.subscribe((event: AgentEvent) => {
      this.forwardEvent(event, subSessionId, agent)
    })

    const abortController = new AbortController()
    const session: SubAgentSession = {
      subSessionId,
      type: agentType,
      agent,
      abortController,
      pendingToolCalls: new Map(),
      finalizedToolCalls: new Set(),
      aborted: false
    }

    this.sessions.set(subSessionId, session)
    let set = this.byParent.get(parentSessionId)
    if (!set) {
      set = new Set()
      this.byParent.set(parentSessionId, set)
    }
    set.add(subSessionId)

    log.info(
      `Created sub-agent subSession=${subSessionId} type=${agentType.name} parent=${parentSessionId}`
    )
    return session
  }

  private removeSession(parentSessionId: string, subSessionId: string): void {
    this.sessions.delete(subSessionId)
    const set = this.byParent.get(parentSessionId)
    if (set) {
      set.delete(subSessionId)
      if (set.size === 0) this.byParent.delete(parentSessionId)
    }
  }

  /** 提取子 Agent 最终文本结果，附加诊断信息 */
  private extractResult(messages: AgentMessage[], execError?: string): string {
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

  /** 从 agent.state.messages 提取 token 总用量（用于 agent_end 事件） */
  private extractUsage(messages: AgentMessage[]): ChatTokenUsage {
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

  /**
   * 将 pi-agent-core 的 AgentEvent 翻译为 ShuviX ChatEvent 并广播。
   * 以 subSessionId 作为 event.sessionId，让 renderer 以"正常会话"的方式渲染。
   */
  private forwardEvent(event: AgentEvent, subSessionId: string, agent: Agent): void {
    const broadcast = chatFrontendRegistry.broadcast.bind(chatFrontendRegistry)

    if (event.type === 'agent_start') {
      broadcast({ type: 'agent_start', sessionId: subSessionId })
      return
    }

    if (event.type === 'agent_end') {
      // 构造最终 assistant 消息（非持久化），让 renderer finishStreaming 落位
      const lastAssistant = [...agent.state.messages].reverse().find(isAssistantMessage)
      let content = ''
      if (lastAssistant) {
        if (typeof lastAssistant.content === 'string') {
          content = lastAssistant.content
        } else if (Array.isArray(lastAssistant.content)) {
          const parts = lastAssistant.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
          content = parts.join('\n')
        }
      }
      const usage = this.extractUsage(agent.state.messages)
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
      broadcast({
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
        broadcast({ type: 'text_delta', sessionId: subSessionId, delta: msgEvent.delta })
      } else if (msgEvent.type === 'thinking_delta' && msgEvent.delta) {
        broadcast({ type: 'thinking_delta', sessionId: subSessionId, delta: msgEvent.delta })
      }
      return
    }

    if (event.type === 'tool_execution_start') {
      const s = this.sessions.get(subSessionId)
      // 若会话已被 abort，则不再进入新的工具调用流转
      if (s && !s.aborted) s.pendingToolCalls.set(event.toolCallId, event.toolName)
      const messageId = `${subSessionId}-tc-${event.toolCallId}`
      broadcast({
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
      const s = this.sessions.get(subSessionId)
      // 已被 finalizeAbortedToolCalls 标记的 toolCallId：吞掉真实的 end 事件，
      // 避免覆盖 "已被用户中止" 为 "完成"。
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
      broadcast({
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
}

export const subAgentManager = new SubAgentManager()
