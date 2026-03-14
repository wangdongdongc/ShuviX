/**
 * 子智能体会话管理器 — 进程内 Agent 子智能体的运行时管理
 *
 * 管理 explore 等进程内子智能体的 Agent 实例生命周期。
 * 纯内存管理，不写 DB，父会话销毁时统一清理。
 *
 * 与父 Agent 解耦：自行解析模型配置并创建 streamFn，
 * 不依赖父 Agent 的 Model/StreamFn 对象。
 */

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type StreamFn
} from '@mariozechner/pi-agent-core'
import { streamSimple } from '@mariozechner/pi-ai'
import { isAssistantMessage } from '../utils/messageGuards'
import type { ChatTokenUsage } from '../frontend'
import { ReadTool } from '../tools/read'
import { ListTool } from '../tools/ls'
import { GrepTool } from '../tools/grep'
import { GlobTool } from '../tools/glob'
import type { ToolContext } from '../tools/types'
import { createTransformContext } from '../services/contextManager'
import { parallelCoordinator } from '../services/parallelExecution'
import { resolveModel } from '../services/agentModelResolver'
import { providerDao } from '../dao/providerDao'
import type { ChatEvent } from '../frontend'
import { extractArgsSummary, type SubAgentModelConfig } from './types'
import { createLogger } from '../logger'

const log = createLogger('SubAgent')

// ─── 子智能体类型定义 ──────────────────────────────────────────

/** 进程内子智能体类型（工具集 + 系统提示 + 行为配置） */
export interface InProcessAgentType {
  /** 类型名称（如 'explore'） */
  name: string
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

/** 活跃的子智能体会话（纯内存） */
interface SubAgentSession {
  taskId: string
  type: InProcessAgentType
  agent: Agent
  abortController: AbortController
  turnCount: number
}

// ─── 工具构建 ──────────────────────────────────────────

type AnyAgentTool = Agent['state']['tools'][number]

/** 为子智能体构建工具集（固定列表，不依赖父级 enabledTools） */
function buildSubAgentTools(ctx: ToolContext, agentType: InProcessAgentType): AnyAgentTool[] {
  const toolFactories: Record<string, () => AnyAgentTool> = {
    read: () => new ReadTool(ctx),
    ls: () => new ListTool(ctx),
    grep: () => new GrepTool(ctx),
    glob: () => new GlobTool(ctx)
  }

  const parallelKey = ctx.parallelSessionKey || ctx.sessionId

  return agentType.tools
    .filter((name) => name in toolFactories)
    .map((name) => {
      const tool = toolFactories[name]()
      // 包装并行执行（复用父级的 parallelCoordinator，用独立 key 隔离）
      const originalExecute = tool.execute.bind(tool)
      const preExecute =
        'preExecute' in tool
          ? (tool as { preExecute: (...a: unknown[]) => Promise<void> }).preExecute.bind(tool)
          : undefined
      parallelCoordinator.registerExecutor(
        parallelKey,
        tool.name,
        tool,
        originalExecute,
        preExecute
      )
      return {
        ...tool,
        execute: async (
          toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
          onUpdate?: (partialResult: unknown) => void
        ) => {
          await Promise.resolve()
          return parallelCoordinator.execute(
            parallelKey,
            toolCallId,
            tool.name,
            params,
            signal,
            onUpdate,
            originalExecute
          )
        }
      } as AnyAgentTool
    })
}

// ─── SubAgentManager ──────────────────────────────────────────

export interface RunTaskParams {
  parentSessionId: string
  /** 父级工具调用 ID（用于前端关联子智能体与 explore 工具调用） */
  parentToolCallId?: string
  taskId?: string
  agentType: InProcessAgentType
  prompt: string
  /** 模型配置（纯数据，SubAgentManager 自行解析为 Model + StreamFn） */
  modelConfig: SubAgentModelConfig
  parentAbortSignal?: AbortSignal
  onEvent: (event: ChatEvent) => void
}

/** 进程内子智能体会话管理器 */
class SubAgentManager {
  /** parentSessionId → Map<taskId, SubAgentSession> */
  private sessions = new Map<string, Map<string, SubAgentSession>>()

  /** 最大并发子智能体数 */
  private readonly MAX_CONCURRENT = 5

  /** 生成或恢复子智能体并执行 prompt */
  async runTask(params: RunTaskParams): Promise<{ taskId: string; result: string }> {
    const { parentSessionId, agentType, prompt, modelConfig, parentAbortSignal, onEvent } = params

    // 恢复已有会话 or 创建新会话
    let session: SubAgentSession
    const taskId = params.taskId

    if (taskId) {
      const existing = this.sessions.get(parentSessionId)?.get(taskId)
      if (existing) {
        session = existing
        log.info(`Resuming sub-agent task=${taskId} type=${agentType.name}`)
      } else {
        log.warn(`Sub-agent task=${taskId} not found, creating new session`)
        session = this.createSession(parentSessionId, agentType, modelConfig, onEvent)
      }
    } else {
      // 并发数检查
      const existing = this.sessions.get(parentSessionId)
      if (existing && existing.size >= this.MAX_CONCURRENT) {
        throw new Error(
          `Maximum concurrent sub-agents (${this.MAX_CONCURRENT}) reached. Wait for existing tasks to complete.`
        )
      }
      session = this.createSession(parentSessionId, agentType, modelConfig, onEvent)
    }

    // 链接父级中止信号
    if (parentAbortSignal) {
      if (parentAbortSignal.aborted) {
        session.abortController.abort()
        throw new Error('Parent agent was aborted')
      }
      parentAbortSignal.addEventListener('abort', () => session.agent.abort(), { once: true })
    }

    // 广播子智能体开始事件
    onEvent({
      type: 'subagent_start',
      sessionId: parentSessionId,
      subAgentId: session.taskId,
      subAgentType: agentType.name,
      description: prompt.slice(0, 100),
      parentToolCallId: params.parentToolCallId
    })

    // 执行 prompt
    try {
      await session.agent.prompt(prompt)
      await session.agent.waitForIdle()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Sub-agent error: ${message}`)
      // 即使出错也返回已有内容
    }

    // 提取最终文本结果
    const result = this.extractLastText(session.agent.state.messages)

    // 提取子智能体 token 用量
    const usage = this.extractUsage(session.agent.state.messages)

    // 广播子智能体结束事件
    onEvent({
      type: 'subagent_end',
      sessionId: parentSessionId,
      subAgentId: session.taskId,
      subAgentType: agentType.name,
      result,
      usage: usage.total > 0 ? { ...usage, details: usage.details } : undefined
    })

    return { taskId: session.taskId, result }
  }

  /** 中止指定父会话的所有子智能体 */
  abortAll(parentSessionId: string): void {
    const map = this.sessions.get(parentSessionId)
    if (!map) return
    for (const [taskId, session] of map) {
      log.info(`Aborting sub-agent task=${taskId}`)
      session.agent.abort()
      session.abortController.abort()
    }
  }

  /** 销毁指定父会话的所有子智能体 */
  destroyAll(parentSessionId: string): void {
    const map = this.sessions.get(parentSessionId)
    if (!map) return
    for (const [taskId, session] of map) {
      log.info(`Destroying sub-agent task=${taskId}`)
      session.agent.abort()
      session.abortController.abort()
      // 清理并行协调器
      const parallelKey = `${parentSessionId}:sub:${taskId}`
      parallelCoordinator.clearSession(parallelKey)
    }
    this.sessions.delete(parentSessionId)
  }

  // ─── 内部方法 ──────────────────────────────────────────

  /** 创建子智能体的 StreamFn：自行查 API key、还原 provider slug，不依赖父级 */
  private buildStreamFn(): StreamFn {
    return (
      streamModel: Parameters<typeof streamSimple>[0],
      context: Parameters<typeof streamSimple>[1],
      options?: Parameters<typeof streamSimple>[2]
    ): ReturnType<typeof streamSimple> => {
      const p = providerDao.pick(String(streamModel.provider), ['apiKey', 'isBuiltin', 'name'])
      const effectiveModel =
        p?.isBuiltin && p.name ? { ...streamModel, provider: p.name.toLowerCase() } : streamModel
      const streamOpts = {
        ...(options || {}),
        ...(p?.apiKey ? { apiKey: p.apiKey } : {})
      }
      return streamSimple(effectiveModel, context, streamOpts)
    }
  }

  private createSession(
    parentSessionId: string,
    agentType: InProcessAgentType,
    modelConfig: SubAgentModelConfig,
    onEvent: (event: ChatEvent) => void
  ): SubAgentSession {
    const taskId = crypto.randomUUID()
    const parallelKey = `${parentSessionId}:sub:${taskId}`

    // 子智能体的 ToolContext：继承 sessionId（沙箱配置），独立的 parallelSessionKey
    const subToolContext: ToolContext = {
      sessionId: parentSessionId,
      parallelSessionKey: parallelKey
      // 不提供交互回调：子智能体不需要 requestApproval/requestUserInput/requestSshCredentials
    }

    const tools = buildSubAgentTools(subToolContext, agentType)

    // 自行解析模型和创建 streamFn（与父 Agent 解耦）
    const resolvedModel = resolveModel({
      provider: modelConfig.provider,
      model: modelConfig.model,
      capabilities: modelConfig.capabilities
    })
    const subStreamFn = this.buildStreamFn()

    const agent = new Agent({
      initialState: {
        systemPrompt: agentType.systemPrompt,
        model: resolvedModel,
        thinkingLevel: 'off',
        messages: [],
        tools
      },
      transformContext: createTransformContext(resolvedModel),
      streamFn: subStreamFn
    })

    // 订阅子智能体事件，转发到父会话（带 subAgentId 标注）
    agent.subscribe((event: AgentEvent) => {
      this.forwardEvent(event, parentSessionId, taskId, agentType.name, onEvent)
    })

    const abortController = new AbortController()
    const session: SubAgentSession = {
      taskId,
      type: agentType,
      agent,
      abortController,
      turnCount: 0
    }

    // 存入管理器
    if (!this.sessions.has(parentSessionId)) {
      this.sessions.set(parentSessionId, new Map())
    }
    this.sessions.get(parentSessionId)!.set(taskId, session)

    log.info(`Created sub-agent task=${taskId} type=${agentType.name} parent=${parentSessionId}`)
    return session
  }

  /** 从消息列表中提取 token 用量（与 agentEventHandler 中 handleAgentEnd 相同逻辑） */
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

  /** 从消息列表中提取最后一条 assistant 消息的文本内容 */
  private extractLastText(messages: AgentMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== 'assistant') continue
      if (typeof msg.content === 'string') return msg.content
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
        if (textParts.length > 0) return textParts.join('\n')
      }
    }
    return '(No result)'
  }

  /** 转发子智能体事件到父会话（工具 + 文本 + 思考流式事件） */
  private forwardEvent(
    event: AgentEvent,
    parentSessionId: string,
    taskId: string,
    subAgentType: string,
    onEvent: (event: ChatEvent) => void
  ): void {
    if (event.type === 'tool_execution_start') {
      onEvent({
        type: 'subagent_tool_start',
        sessionId: parentSessionId,
        subAgentId: taskId,
        subAgentType,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        summary: extractArgsSummary(event.args as Record<string, unknown>)
      })
    } else if (event.type === 'tool_execution_end') {
      const result = event.result
      const content = result?.content as Array<{ type: string; text?: string }> | undefined
      const text =
        content
          ?.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n') ?? ''
      onEvent({
        type: 'subagent_tool_end',
        sessionId: parentSessionId,
        subAgentId: taskId,
        subAgentType,
        toolCallId: event.toolCallId,
        toolName: event.toolName ?? '',
        result: text.length > 500 ? text.slice(0, 500) + '...' : text
      })
    } else if (event.type === 'message_update') {
      const msgEvent = event.assistantMessageEvent
      if (msgEvent.type === 'text_delta' && msgEvent.delta) {
        onEvent({
          type: 'subagent_text_delta',
          sessionId: parentSessionId,
          subAgentId: taskId,
          subAgentType,
          delta: msgEvent.delta
        })
      } else if (msgEvent.type === 'thinking_delta' && msgEvent.delta) {
        onEvent({
          type: 'subagent_thinking_delta',
          sessionId: parentSessionId,
          subAgentId: taskId,
          subAgentType,
          delta: msgEvent.delta
        })
      }
    }
  }
}

export const subAgentManager = new SubAgentManager()
