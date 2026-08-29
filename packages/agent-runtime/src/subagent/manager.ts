/**
 * 派生 Agent 协调器（跨端共享核心）。
 *
 * 所有 agent 地位对等：派生 agent 与会话根 agent 共用同一条统一创建管线
 * （agentProfile/createAgent 的 factory，kind='spawned' → 内存会话树，销毁即消失）。
 * 本文件只负责 spawn 协调：深度校验（MAX_AGENT_DEPTH）、登记（AgentRegistry，
 * 父子关系唯一事实来源 —— pi 的 SessionMetadata 刻意不含血缘字段，这层簿记是对 pi
 * 的补充而非重复）、结果抽取、abort/interrupt 传播（含级联子树）、追问（continueTask）。
 *
 * 平台相关项全部经注入：agent 创建(createAgent，宿主 factory)、事件广播(broadcast)、
 * 询问/询问通道(requestUserInput，路由到根会话前端)。
 */
import type { Agent, AgentMessage, AgentToolResult, Session } from '@earendil-works/pi-agent-core'
import { v4 as uuid } from 'uuid'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { isAssistantMessage } from '../messageGuards'
import { AgentRegistry, agentIdOf } from '../agentRegistry'
import type { HarnessSession } from '../harness/harnessSession'
import type { AgentFactory } from '../agentProfile/createAgent'
import type { InProcessAgentType, SubAgentModelConfig } from './types'
import type { RuntimeLogger } from '../types'
import {
  NextTool,
  NEXT_NUDGE_TEXT,
  buildResultContractNote,
  validateContractSchema,
  type ResultContract
} from './nextTool'

type AnyAgentTool = Agent['state']['tools'][number]

/**
 * 默认派生层级上限：根会话 depth=0，其派生 agent depth=1，再派生 depth=2。
 * 超过上限的 spawn 被拒绝（错误文本返回给调用方 LLM）。宿主可经 deps.maxAgentDepth 覆盖。
 */
export const DEFAULT_MAX_AGENT_DEPTH = 2

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

/**
 * spawn 上下文 —— 传给 resolveTools 的本次派生身份信息。
 * 宿主据此把派发工具（Agent）也注入派生 agent 的工具集：parentSessionId 用 agentId
 * （嵌套派生的子代挂在本 agent 名下），深度校验由 manager 在下一次 spawn 时统一执行。
 */
export interface SpawnContext {
  /** 本次派生 agent 的事件频道 id */
  agentId: string
  /** 本次派生 agent 的层级（根会话的直接派生 = 1） */
  depth: number
  /** 派生来源 agent 的 id（可能本身也是派生 agent）—— 运行时注册中心据此还原血缘 */
  parentAgentId: string
  /** 所属根会话 id（工具路径询问/LLM 日志归属） */
  rootSessionId: string
  /** 本次派生使用的模型配置（宿主为其派发工具沿用） */
  modelConfig: SubAgentModelConfig
  /** 本 agent 是否还允许继续派发（depth < maxAgentDepth）；false 时宿主应省略派发工具 */
  canSpawn: boolean
}

/**
 * 传给 resolveTools 的运行期辅助能力（manager 按派发上下文绑定后注入）。
 *
 * requestUserInput：派生 agent 工具可达**根会话**的用户输入通道——询问/询问表单出现在
 * 根会话对话流中，由用户作答后回流，与主 Agent 亲自调用 ask/路径询问完全等效。
 * 仅当宿主向 SubAgentManagerDeps 注入了 requestUserInput 时存在。
 */
export interface SubAgentToolHelpers {
  requestUserInput?: (req: InputRequest) => Promise<InputResponse>
}

export interface SubAgentManagerDeps {
  /**
   * 统一创建管线（宿主 agentFactory.createAgent）。manager 以 kind='spawned' 调用：
   * 工具解析/模型构建/apiKey/LLM 日志/内存会话树全部收敛在 factory 与宿主 HostAdapter 内。
   */
  createAgent: AgentFactory['createAgent']
  /**
   * 根会话用户输入通道（可选）。注入后 manager 把它绑定 rootSessionId 经
   * SubAgentToolHelpers 传给 createAgent（→ 宿主 resolveTools），使派生 agent 工具
   * （ask/路径询问等）可挂起等待用户作答。不注入时 helpers.requestUserInput 为 undefined。
   */
  requestUserInput?: (rootSessionId: string, req: InputRequest) => Promise<InputResponse>
  /** 向前端广播 ChatEvent */
  broadcast: (event: ChatEvent) => void
  /** 日志（可选） */
  logger?: RuntimeLogger
  /** abort 时工具调用展示的文案（懒解析以反映当前 i18n 语言；缺省英文） */
  getAbortedNote?: () => string
  /** 派生层级上限（缺省 DEFAULT_MAX_AGENT_DEPTH） */
  maxAgentDepth?: number
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
   * 在 prompt 之前预置进派生 agent 上下文的消息（如笔记本会话把当前 md 内容作为一条 user message 注入）。
   * 这些消息进 LLM 上下文。其文本会随 sub_session_register 的 contextNote 广播给面板，
   * 故面板「笔记本内容」卡片即这些消息的真实内容（与实际发给 LLM 的 UserMessage 一致，不再另传 raw）。
   */
  contextMessages?: AgentMessage[]
  /**
   * 结果契约（可选）：声明后派生 agent 获得一个按 schema 现造的 `next` 工具（extraTools
   * 注入，经宿主与内置工具同样包装），任务 prompt 末尾追加契约段，要求以恰好一次 `next`
   * 调用收尾 —— 合规调用即捕获：软停止本 agent（interrupt 语义），返回值的 `structured`
   * 为捕获对象。run 自然结束却没调 next 时补救追问 `nudges` 次（缺省 1），仍无捕获则
   * `structured` 为 undefined，由调用方决定成败。见 subagent/nextTool.ts。
   */
  resultContract?: ResultContract
}

export interface SubAgentManager {
  /**
   * 跑一个一次性派发任务。`result` 恒为文本（无契约 = 转写抽取；有契约且捕获 =
   * 捕获对象的 JSON 文本）；`structured` 仅在结果契约捕获成功时存在。
   */
  runTask: (params: RunTaskParams) => Promise<{ result: string; structured?: unknown }>
  /**
   * 继续与一个已存在派生 agent 对话：复用其 Agent（保留历史）追加一轮 user prompt（fire-and-forget）。
   * 面板先收到 user_message（后续用户消息内联到转写），随后流式事件如常，末了再发 sub_session_end。
   * 派生 agent 不存在或已中止时抛错。
   */
  continueTask: (params: {
    subSessionId: string
    text: string
    inlineTokens?: Record<string, InlineToken>
  }) => Promise<void>
  /**
   * 用户中断一个运行中的派生 agent：停止当前生成但保留已产出的部分结果，按「已完成」收尾
   * （区别于 abort/destroy 的失败/销毁语义——条目保留在面板，用户可继续追问或显式删除）。
   */
  interrupt: (subSessionId: string) => void
  /** 中止某 agent 的全部后代（级联子树） */
  abortAll: (parentSessionId: string) => void
  /** 销毁某 agent 的全部后代（级联子树） */
  destroyAll: (parentSessionId: string) => void
  destroy: (subSessionId: string) => void
  has: (subSessionId: string) => boolean
  /**
   * 派生 agent 的运行时快照（systemPrompt / 模型 / 已装载工具）—— 智能体监控页展开某条
   * 派生 agent 时按需拉取。root agent 的同名信息由各宿主的会话服务给出；这里补上派生这一半，
   * 因为派生运行时只活在本协调器的 map 里（没有会话行，宿主够不到）。不存在时返回 null。
   */
  getRuntimeInfo: (subSessionId: string) => Promise<AgentRuntimeInfo | null>
  /** 父子关系登记簿（层级/归属查询，只读使用） */
  readonly registry: AgentRegistry
}

interface SpawnedAgent {
  agentId: string
  profile: InProcessAgentType
  /** 内存态会话树（上下文真理源；随 destroy 消失） */
  piSession: Session
  runtime: HarnessSession
  /** 从运行时注册中心注销（destroy 时调用） */
  dispose: () => void
  aborted: boolean
  /** 用户主动中断（软停止）：保留部分结果、按「已完成」收尾，区别于 aborted 的失败态 */
  interrupted: boolean
}

/** 创建一个派生 agent 协调器（注入端适配依赖） */
export function createSubAgentManager(deps: SubAgentManagerDeps): SubAgentManager {
  const abortedNote = (): string => deps.getAbortedNote?.() || 'Aborted by user.'
  const maxDepth = deps.maxAgentDepth ?? DEFAULT_MAX_AGENT_DEPTH
  const registry = new AgentRegistry()
  const sessions = new Map<string, SpawnedAgent>()

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
      `Agent did not produce a final text response (${assistantCount} assistant message(s), ${toolUseCount} tool call(s)).`
    )
    if (lastStopReason) parts.push(`stopReason=${lastStopReason}.`)
    if (lastErrorMessage) parts.push(`Model errorMessage: ${lastErrorMessage}.`)
    if (execError) parts.push(`Execution threw: ${execError}.`)
    return parts.join(' ')
  }

  async function createSession(params: {
    parentSessionId: string
    agentType: InProcessAgentType
    description: string
    modelConfig: SubAgentModelConfig
    contextMessages?: AgentMessage[]
    extraTools?: readonly AnyAgentTool[]
  }): Promise<SpawnedAgent> {
    const { parentSessionId, agentType, description, modelConfig, contextMessages, extraTools } =
      params

    // ── 深度校验：唯一的层级控制点（派发工具全员可用，越界在此拒绝） ──
    const depth = registry.depthOf(parentSessionId) + 1
    if (depth > maxDepth) {
      throw new Error(
        `Agent depth limit reached (max ${maxDepth}): this agent is already at depth ${depth - 1} and cannot spawn further agents. Complete the task directly instead.`
      )
    }
    const rootSessionId = registry.rootSessionOf(parentSessionId)
    const agentId = agentIdOf(uuid())

    const helpers: SubAgentToolHelpers = {
      requestUserInput: deps.requestUserInput
        ? (req) => deps.requestUserInput!(rootSessionId, req)
        : undefined
    }
    const spawn: SpawnContext = {
      agentId,
      depth,
      parentAgentId: parentSessionId,
      rootSessionId,
      modelConfig,
      canSpawn: depth < maxDepth
    }

    // 统一创建管线：kind='spawned' → 内存会话树 / stub env / 事件汇包装 /
    // LLM 日志归根会话等差异全部由 factory 决策表落定（见 agentProfile/createAgent）
    const created = await deps.createAgent({
      kind: 'spawned',
      sessionId: agentId,
      profile: agentType,
      model: modelConfig,
      // 默认 'off'；笔记本/用户直发把会话思考深度经 modelConfig 传入即生效
      thinkingLevel: modelConfig.thinkingLevel ?? 'off',
      cwd: '',
      spawn,
      spawnHelpers: helpers,
      extraTools
    })
    const runtime = created.runtime
    const piSession = runtime.session

    // 预置上下文（如笔记本正文）直接落 entry —— 进 LLM 上下文，且不触发任何事件广播。
    // （构造后追加与旧「构造前追加」时序等价：harness 每轮 prompt 时才 buildContext 读树）
    if (contextMessages) {
      for (const msg of contextMessages) await piSession.appendMessage(msg)
    }

    const session: SpawnedAgent = {
      agentId,
      profile: agentType,
      piSession,
      runtime,
      dispose: () => created.dispose(),
      aborted: false,
      interrupted: false
    }
    sessions.set(agentId, session)
    registry.register({
      agentId,
      parentAgentId: parentSessionId,
      depth,
      profileName: agentType.name,
      displayName: agentType.displayName,
      description
    })

    deps.logger?.info(
      `Spawned agent=${agentId} profile=${agentType.name} parent=${parentSessionId} depth=${depth} root=${rootSessionId}`
    )
    return session
  }

  /** 跑一轮（prompt → 完成），返回本轮 execError（错误已消化并广播，不抛出） */
  async function runTurn(session: SpawnedAgent, promptText: string): Promise<string | undefined> {
    const { error } = await session.runtime.prompt(promptText)
    if (error) deps.logger?.error(`Agent ${session.agentId} error: ${error}`)
    return error
  }

  /** 一轮结束后的收尾：抽取结果 + 广播 sub_session_end。契约捕获成功时结果即捕获值的 JSON */
  async function finishTurn(
    session: SpawnedAgent,
    parentSessionId: string,
    execError: string | undefined,
    captured?: { hit: boolean; value?: unknown }
  ): Promise<{ result: string; structured?: unknown }> {
    // 契约捕获：结果以捕获值为准 —— 捕获后紧跟软停止，树尾部（部分消息/中止痕迹）不代表结果
    if (captured?.hit) {
      const result = JSON.stringify(captured.value, null, 2)
      deps.broadcast({
        type: 'sub_session_end',
        sessionId: session.agentId,
        parentSessionId,
        result,
        isError: false
      })
      return { result, structured: captured.value }
    }

    // 上下文真理源是内存会话树（含 harness 落进去的失败消息）
    const messages = (await session.piSession.buildContext()).messages
    const result = session.interrupted
      ? extractResult(messages)
      : session.aborted
        ? abortedNote()
        : extractResult(messages, execError)
    const isError = session.interrupted ? false : !!execError || session.aborted

    deps.broadcast({
      type: 'sub_session_end',
      sessionId: session.agentId,
      parentSessionId,
      result,
      isError
    })
    return { result }
  }

  function interrupt(subSessionId: string): void {
    const s = sessions.get(subSessionId)
    if (!s) return
    // 软停止：标记为「用户中断」，harness.abort 终结在飞工具调用并停止当前生成。
    // 登记保留 —— runTask/continueTask 的 prompt 解除后照常广播 sub_session_end
    // （isError=false），条目保留在面板供继续追问或显式删除。
    s.interrupted = true
    void s.runtime.abort()
  }

  function abortOne(s: SpawnedAgent): void {
    s.aborted = true
    void s.runtime.abort()
  }

  function destroy(subSessionId: string): void {
    const s = sessions.get(subSessionId)
    if (!s) return
    // 先级联销毁子树（后代挂在本 agent 名下）
    for (const child of registry.childrenOf(subSessionId)) destroy(child.agentId)
    void s.runtime.abort()
    s.dispose()
    sessions.delete(subSessionId)
    registry.unregister(subSessionId)
  }

  return {
    registry,

    async runTask(params: RunTaskParams): Promise<{ result: string; structured?: unknown }> {
      const {
        parentSessionId,
        parentToolCallId,
        agentType,
        prompt,
        description,
        modelConfig,
        parentAbortSignal,
        contextMessages,
        promptInlineTokens,
        resultContract
      } = params
      // 面板「笔记本内容」卡片 = 实际注入的 context 消息文本（与发给 LLM 的 UserMessage 一致）
      const contextNote = contextMessages?.length ? agentMessagesToText(contextMessages) : undefined

      // 内联 Token（slash 命令 / skill）：prompt 原文（含 marker）用于面板展示标签；
      // 发给 Agent 的文本经解析展开为真实指令（如 skill 模板正文）。
      const hasTokens = promptInlineTokens && Object.keys(promptInlineTokens).length > 0
      let llmPrompt = hasTokens ? resolveTokensForAgent(prompt, promptInlineTokens) : prompt

      // ── 结果契约：next 工具（extraTools 注入）+ prompt 契约段 + 捕获通道 ──
      // 捕获即软停止（interrupt 语义）：结果以捕获值为准，树尾部的中止痕迹无关紧要；
      // queueMicrotask 让 next 的成功 tool result 先返回，再触发停止。
      const captured: { hit: boolean; value?: unknown } = { hit: false }
      let extraTools: AnyAgentTool[] | undefined
      // 前向引用：捕获回调在 agent 执行期才触发，届时 id 已就位
      let capturedAgentId = ''
      if (resultContract) {
        const schemaError = validateContractSchema(resultContract.schema)
        if (schemaError) throw new Error(`invalid result contract: ${schemaError}`)
        const nextTool = new NextTool(resultContract.schema, (value) => {
          captured.hit = true
          captured.value = value
          queueMicrotask(() => {
            if (capturedAgentId) interrupt(capturedAgentId)
          })
        })
        extraTools = [nextTool as unknown as AnyAgentTool]
        llmPrompt = `${llmPrompt}\n\n${buildResultContractNote(resultContract)}`
      }

      // 不限制并发数量：可同时堆叠任意多个（面板纵向手风琴展示）；层级由深度校验约束
      const session = await createSession({
        parentSessionId,
        agentType,
        description,
        modelConfig,
        contextMessages,
        extraTools
      })

      deps.broadcast({
        type: 'sub_session_register',
        sessionId: session.agentId,
        parentSessionId,
        parentToolCallId,
        subAgentName: agentType.name,
        displayName: agentType.displayName,
        description,
        systemPrompt: agentType.systemPrompt,
        prompt,
        inlineTokens: hasTokens ? promptInlineTokens : undefined,
        contextNote,
        // 血缘由 AgentRegistry 唯一维护（HarnessSession 不再承载 depth/parent）
        depth: registry.depthOf(session.agentId),
        rootSessionId: registry.rootSessionOf(session.agentId)
      })

      capturedAgentId = session.agentId

      if (parentAbortSignal) {
        if (parentAbortSignal.aborted) {
          abortOne(session)
        } else {
          parentAbortSignal.addEventListener('abort', () => abortOne(session), { once: true })
        }
      }

      let execError = await runTurn(session, llmPrompt)

      // 契约补救：run 自然结束却没调 next → 追问 nudges 次（缺省 1）。
      // 中止/出错不追问；捕获会置 interrupted（软停止），故以 captured.hit 先行判定。
      if (resultContract && !captured.hit) {
        const nudges = resultContract.nudges ?? 1
        for (
          let i = 0;
          i < nudges && !captured.hit && !session.aborted && !session.interrupted && !execError;
          i++
        ) {
          // 面板转写连贯：与 continueTask 同形广播这条追问（用户可见自动化的补救动作）
          deps.broadcast({
            type: 'user_message',
            sessionId: session.agentId,
            message: JSON.stringify({
              id: `${session.agentId}-user-${Date.now()}`,
              sessionId: session.agentId,
              role: 'user' as const,
              type: 'text' as const,
              content: NEXT_NUDGE_TEXT,
              metadata: null,
              model: '',
              createdAt: Date.now()
            })
          })
          execError = await runTurn(session, NEXT_NUDGE_TEXT)
        }
      }

      return await finishTurn(session, parentSessionId, execError, captured)
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
      const parentSessionId = registry.get(subSessionId)?.parentAgentId ?? ''

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

      const execError = await runTurn(session, promptText)
      await finishTurn(session, parentSessionId, execError)
    },

    abortAll(parentSessionId: string): void {
      for (const entry of registry.descendantsOf(parentSessionId)) {
        const s = sessions.get(entry.agentId)
        if (s) abortOne(s)
      }
    },

    destroyAll(parentSessionId: string): void {
      for (const child of registry.childrenOf(parentSessionId)) destroy(child.agentId)
    },

    interrupt,

    destroy,

    has(subSessionId: string): boolean {
      return sessions.has(subSessionId)
    },

    async getRuntimeInfo(subSessionId: string): Promise<AgentRuntimeInfo | null> {
      const session = sessions.get(subSessionId)
      return session ? await session.runtime.getRuntimeInfo() : null
    }
  }
}

export type { AnyAgentTool, AgentToolResult }
