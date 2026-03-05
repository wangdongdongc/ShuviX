/**
 * 子智能体类型注册表 + 会话管理器
 *
 * 子智能体通过 task 工具由主 Agent 生成，运行在独立上下文中。
 * 纯内存管理，不写 DB，父会话销毁时统一清理。
 */

import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from '@mariozechner/pi-agent-core'
import type { Api, Model } from '@mariozechner/pi-ai'
import { isAssistantMessage } from '../utils/messageGuards'
import type { ChatTokenUsage } from '../frontend'
import { ReadTool } from '../tools/read'
import { ListTool } from '../tools/ls'
import { GrepTool } from '../tools/grep'
import { GlobTool } from '../tools/glob'
import type { ToolContext } from '../tools/types'
import { createTransformContext } from './contextManager'
import { parallelCoordinator } from './parallelExecution'
import type { ChatEvent } from '../frontend'
import { createLogger } from '../logger'

const log = createLogger('SubAgent')

// ─── 子智能体类型定义 ──────────────────────────────────────────

/** 子智能体类型 */
export interface SubAgentType {
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

/** 内置子智能体类型：explore — 只读代码库搜索专家 */
const EXPLORE_TYPE: SubAgentType = {
  name: 'explore',
  description:
    'Fast read-only agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
  tools: ['read', 'ls', 'grep', 'glob'],
  maxTurns: 20,
  systemPrompt: `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Use Ls for listing directory contents
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files or run commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.`
}

/** 所有已注册的子智能体类型 */
const SUBAGENT_TYPES: SubAgentType[] = [EXPLORE_TYPE]

/** 获取所有子智能体类型名称 */
export function getSubAgentTypes(): SubAgentType[] {
  return SUBAGENT_TYPES
}

/** 按名称查找子智能体类型 */
export function getSubAgentType(name: string): SubAgentType | undefined {
  return SUBAGENT_TYPES.find((t) => t.name === name)
}

// ─── 子智能体会话 ──────────────────────────────────────────

/** 活跃的子智能体会话（纯内存） */
interface SubAgentSession {
  taskId: string
  type: SubAgentType
  agent: Agent
  abortController: AbortController
  turnCount: number
}

// ─── 工具构建 ──────────────────────────────────────────

type AnyAgentTool = Agent['state']['tools'][number]

/** 为子智能体构建工具集（固定列表，不依赖父级 enabledTools） */
function buildSubAgentTools(ctx: ToolContext, subAgentType: SubAgentType): AnyAgentTool[] {
  const toolFactories: Record<string, () => AnyAgentTool> = {
    read: () => new ReadTool(ctx),
    ls: () => new ListTool(ctx),
    grep: () => new GrepTool(ctx),
    glob: () => new GlobTool(ctx)
  }

  const parallelKey = ctx.parallelSessionKey || ctx.sessionId

  return subAgentType.tools
    .filter((name) => name in toolFactories)
    .map((name) => {
      const tool = toolFactories[name]()
      // 包装并行执行（复用父级的 parallelCoordinator，用独立 key 隔离）
      const originalExecute = tool.execute.bind(tool)
      const preExecute =
        'preExecute' in tool ? (tool as { preExecute: (...a: unknown[]) => Promise<void> }).preExecute.bind(tool) : undefined
      parallelCoordinator.registerExecutor(parallelKey, tool.name, tool, originalExecute, preExecute)
      return {
        ...tool,
        execute: async (
          toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
          onUpdate?: (partialResult: unknown) => void
        ) => {
          await Promise.resolve()
          return parallelCoordinator.execute(parallelKey, toolCallId, tool.name, params, signal, onUpdate, originalExecute)
        }
      } as AnyAgentTool
    })
}

// ─── SubAgentManager ──────────────────────────────────────────

export interface RunTaskParams {
  parentSessionId: string
  parentToolContext: ToolContext
  /** 父级工具调用 ID（用于前端关联子智能体与 explore 工具调用） */
  parentToolCallId?: string
  taskId?: string
  subAgentType: string
  prompt: string
  parentModel: Model<Api>
  parentStreamFn: StreamFn
  parentAbortSignal?: AbortSignal
  onEvent: (event: ChatEvent) => void
}

/** 子智能体会话管理器 */
class SubAgentManager {
  /** parentSessionId → Map<taskId, SubAgentSession> */
  private sessions = new Map<string, Map<string, SubAgentSession>>()

  /** 最大并发子智能体数 */
  private readonly MAX_CONCURRENT = 5

  /** 生成或恢复子智能体并执行 prompt */
  async runTask(params: RunTaskParams): Promise<{ taskId: string; result: string }> {
    const {
      parentSessionId,
      parentToolContext,
      subAgentType: typeName,
      prompt,
      parentModel,
      parentStreamFn,
      parentAbortSignal,
      onEvent
    } = params

    // 查找子智能体类型
    const agentType = getSubAgentType(typeName)
    if (!agentType) {
      const available = SUBAGENT_TYPES.map((t) => t.name).join(', ')
      throw new Error(`Unknown sub-agent type "${typeName}". Available types: ${available}`)
    }

    // 恢复已有会话 or 创建新会话
    let session: SubAgentSession
    const taskId = params.taskId

    if (taskId) {
      const existing = this.sessions.get(parentSessionId)?.get(taskId)
      if (existing) {
        session = existing
        log.info(`Resuming sub-agent task=${taskId} type=${typeName}`)
      } else {
        log.warn(`Sub-agent task=${taskId} not found, creating new session`)
        session = this.createSession(parentSessionId, agentType, parentToolContext, parentModel, parentStreamFn, onEvent)
      }
    } else {
      // 并发数检查
      const existing = this.sessions.get(parentSessionId)
      if (existing && existing.size >= this.MAX_CONCURRENT) {
        throw new Error(`Maximum concurrent sub-agents (${this.MAX_CONCURRENT}) reached. Wait for existing tasks to complete.`)
      }
      session = this.createSession(parentSessionId, agentType, parentToolContext, parentModel, parentStreamFn, onEvent)
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
      subAgentType: typeName,
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
      subAgentType: typeName,
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

  private createSession(
    parentSessionId: string,
    agentType: SubAgentType,
    parentToolContext: ToolContext,
    parentModel: Model<Api>,
    parentStreamFn: StreamFn,
    onEvent: (event: ChatEvent) => void
  ): SubAgentSession {
    const taskId = crypto.randomUUID()
    const parallelKey = `${parentSessionId}:sub:${taskId}`

    // 子智能体的 ToolContext：继承 sessionId（沙箱配置），独立的 parallelSessionKey
    const subToolContext: ToolContext = {
      sessionId: parentToolContext.sessionId,
      parallelSessionKey: parallelKey
      // 不提供交互回调：子智能体不需要 requestApproval/requestUserInput/requestSshCredentials
    }

    const tools = buildSubAgentTools(subToolContext, agentType)

    const agent = new Agent({
      initialState: {
        systemPrompt: agentType.systemPrompt,
        model: parentModel,
        thinkingLevel: 'off',
        messages: [],
        tools
      },
      transformContext: createTransformContext(parentModel),
      streamFn: parentStreamFn
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

  /** 转发子智能体事件到父会话（添加 subAgentId 标注，仅转发工具生命周期事件） */
  private forwardEvent(
    event: AgentEvent,
    parentSessionId: string,
    taskId: string,
    subAgentType: string,
    onEvent: (event: ChatEvent) => void
  ): void {
    // 只转发工具执行事件（让 UI 显示子智能体的活动进度）
    if (event.type === 'tool_execution_start') {
      onEvent({
        type: 'subagent_tool_start',
        sessionId: parentSessionId,
        subAgentId: taskId,
        subAgentType,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolArgs: event.args as Record<string, unknown>
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
    }
  }
}

export const subAgentManager = new SubAgentManager()
