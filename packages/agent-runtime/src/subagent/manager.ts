/**
 * 派生 agent 路由（P2-05）—— 宿主无关，跨端共享。
 *
 * 派生 agent 本身住在它的 durable 会话里（`session.agents`，durable/spawn.ts 的 SpawnCoordinator：子对话、
 * 拥有者边、等待、崩溃恢复、结果抽取、结果契约都在那里）。本文件只做**进程内的呈现与路由**：
 *
 *  - **会话 → 协调器**：`runTask` 按 `sessionId` 找到打开着的会话（`sessions.get`；派发工具总在打开的会话里
 *    跑），把这一次派发交给 `session.agents.spawn`。
 *  - **广播**：子 agent 建好（或重跑时重新挂上）的那一刻（`onCreated`）发 `sub_session_register`，每一轮
 *    收尾发 `sub_session_end`（`result` 与交回调用方的文本逐字相同）。追问另发一条 `user_message`；结果契约
 *    的追问（nudge）不广播（PIN-06）。
 *  - **任务登记**：每个子 agent 在 taskRegistry 里一条 `'agent'` 任务，taskId = agentId，归属可见会话
 *    （嵌套派生也一样）；停 = 软停止（interrupt）。每条路径都要落定 —— 没落定的任务会把会话钉在 LRU 里。
 *  - **agentId 索引**：agentId → (sessionId, conversationId)，进程内（PIN-12：重启之后只靠重跑重新填）。
 *    面板的追问 / 中断 / 销毁按 agentId 找到会话与子对话。
 *  - **忙**：路由自己记哪个 agentId 正在跑（PIN-08），忙时追问在任何广播之前就拒绝。
 *
 * 成败只判一处（`settleOf`）：结果契约捕获 > 中止 > 软停止（PIN-05）。中止 = 派发工具的 signal 落下或协调器
 * 交回 `error: 'aborted'` → 任务 `killed`、`isError: true`、文本换成 `getAbortedNote()`（软停止标记在时保留
 * 部分结果）；模型报错 → `error`；其余 → `done`。
 *
 * 拥有者：`{tool}` = 模型调派发工具（派发工具把自己这次调用的 scope 交进来）。宿主派发的 `{task}` /
 * `{anchor}` 归 P2-08，在那之前以 `PhasePendingError('host-dispatched agents', 2)` 拒绝（PIN-03）。
 */
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { DurableSession } from '../durable/durableSession'
import type { SessionHost } from '../durable/sessionHost'
import type { SpawnCreatedInfo, SpawnOutcome } from '../durable/spawn'
import { PhasePendingError } from '../errors/phasePending'
import type { TaskRegistry } from '../task/registry'
import type { ToolCallScope } from '../tools/toolCall'
import type { RuntimeLogger } from '../types'
import type { ResultContract } from './nextTool'
import type { InProcessAgentType, SubAgentModelConfig } from './types'

// ─────────────────────────── 公共类型 ───────────────────────────

export interface SubAgentManagerDeps {
  /** 会话宿主的两样（PIN-19）：`runTask` 只用 `get`；面板追问在会话关着时用 `peek`（从不 open） */
  sessions: Pick<SessionHost, 'get' | 'peek'>
  /** 向前端广播 ChatEvent */
  broadcast: (event: ChatEvent) => void
  /**
   * 后台任务枢纽（可选）。注入后每个子 agent 在那里登记一条任务 —— 面板因此能与 bash、子会话同列一张表。
   * **taskId 就是 agentId**（它已经是事件频道）。不注入时其余行为不变。
   */
  tasks?: TaskRegistry
  /** 日志（可选） */
  logger?: RuntimeLogger
  /** 中止时交回的文案（懒解析以反映当前 i18n 语言；缺省英文） */
  getAbortedNote?: () => string
}

/** 模型调派发工具：子对话由这次工具调用的任务拥有 */
export interface RunTaskToolOwner {
  readonly tool: ToolCallScope
}

/** 宿主派发（reviewer）：子对话由提问的工具任务拥有 —— P2-08 */
export interface RunTaskTaskOwner {
  readonly task: number
}

/** 宿主派发（观察型 hook）：子对话由一个后台锚任务拥有 —— P2-08 */
export interface RunTaskAnchorOwner {
  readonly anchor: true
}

export type RunTaskOwner = RunTaskToolOwner | RunTaskTaskOwner | RunTaskAnchorOwner

export interface RunTaskParams {
  /** 派发发生在哪条会话里（嵌套派发也是根会话的 id，从不是 agentId） */
  sessionId: string
  /** 子对话的拥有者 */
  owner: RunTaskOwner
  agentType: InProcessAgentType
  prompt: string
  description: string
  /** 宿主派发的模型（hook 的会话模型；P2-08 用）。工具派发从不给 —— 调用方模型现取自 `api.agent()` */
  modelConfig?: SubAgentModelConfig
  /**
   * 结果契约（可选）：子 agent 多一个按 schema 现造的 `next` 工具，任务 prompt 末尾追加契约段；捕获即成功，
   * `structured` 为捕获对象。schema 不合法 → `runTask` 以 `invalid result contract: …` 拒绝。见 subagent/nextTool.ts。
   */
  resultContract?: ResultContract
  /** 派发它的那次工具调用的 provider id（面板把子 agent 内联到那张工具卡片里） */
  parentToolCallId?: string
  /** 宿主派发的取消信号（P2-08）。工具派发的取消在 `owner.tool.signal` 上 */
  signal?: AbortSignal
}

/** 一次派发（runTask）的结果 */
export interface RunTaskOutcome {
  /** 恒为文本：转写抽取（带注记）；结果契约捕获 = 捕获对象的 JSON 文本；中止 = 中止文案；被拒 = 拒绝原因 */
  result: string
  /** 仅在结果契约捕获成功时存在 */
  structured?: unknown
  /**
   * 失败的机器可读原因：`'aborted'`、模型报错原文、拒绝原因（深度 / 建不起来）。软停止与捕获不算失败。
   * 与 `sub_session_end.isError`、任务落定态是同一个结论。
   */
  error?: string
  /** 子对话建成之后才有（没有 = 子 agent 根本没建起来） */
  conversationId?: number
  agentId?: string
}

export interface SubAgentLocation {
  sessionId: string
  conversationId: number
}

export interface SubAgentManager {
  /** 跑一次派发并等它的回答（被拒 / 失败都在结果里；schema 不合法与非工具拥有者以拒绝报告） */
  runTask: (params: RunTaskParams) => Promise<RunTaskOutcome>
  /**
   * 面板追问一个已有的子 agent（agent:subAgentPrompt）：不认识 → `Sub-session not found`；正在跑 →
   * `Sub-session is busy`（在任何广播之前）；会话关着 → `peek` 重开；存储没了 → not found 并丢掉索引。
   * 先广播 `user_message`，这一轮收尾再广播 `sub_session_end`；这一轮自己失败不拒绝。
   */
  continueTask: (params: {
    subSessionId: string
    text: string
    inlineTokens?: Record<string, InlineToken>
  }) => Promise<void>
  /** 软停止一个在跑的子 agent（保留部分结果、按「已完成」收尾）。不认识 / 空闲 / 会话关着 → 无操作（从不打开会话） */
  interrupt: (agentId: string) => Promise<void>
  /** 销毁：在跑就硬中止、卸掉它的扩展、丢掉索引与任务条目（转写留着）。会话关着只丢索引；不认识 → 无操作 */
  destroy: (agentId: string) => Promise<void>
  /** 索引里有没有这个 agentId（同步） */
  has: (agentId: string) => boolean
  /** agentId 在哪条会话的哪个子对话（同步；不打开会话） */
  locate: (agentId: string) => SubAgentLocation | undefined
  /** 派生 agent 的运行时快照 —— phase 3 之前恒为 null */
  getRuntimeInfo: (agentId: string) => Promise<AgentRuntimeInfo | null>
}

// ─────────────────────────── 实现 ───────────────────────────

interface IndexEntry extends SubAgentLocation {
  /** register 里的那个父：派生调用方 = 它的 agentId，根 = 会话 id（PIN-15） */
  parentSessionId: string
  /** 任务条目被清掉之后追问重建它用 */
  displayName: string
  profileName: string
  depth: number
}

type SettleStatus = 'done' | 'error' | 'killed'

interface Verdict {
  status: SettleStatus
  outcome: RunTaskOutcome
}

const DEFAULT_ABORTED_NOTE = 'Aborted by user.'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 创建派生 agent 路由（注入端适配依赖） */
export function createSubAgentManager(deps: SubAgentManagerDeps): SubAgentManager {
  const abortedNote = (): string => deps.getAbortedNote?.() || DEFAULT_ABORTED_NOTE
  const index = new Map<string, IndexEntry>()
  /** 正在跑一轮的 agentId（派发等待 / 面板追问；PIN-08） */
  const running = new Set<string>()
  /** 这一轮被软停止的 agentId（PIN-05 的文本：中止时保留部分结果） */
  const soft = new Set<string>()

  /**
   * 一轮收尾的成败（全模块只此一处）：捕获 > 中止 > 软停止 / 成功（PIN-05）。`aborted` = 派发工具的
   * signal 落下（面板追问没有）或协调器交回 `'aborted'`。
   */
  function settleOf(raw: SpawnOutcome, aborted: boolean, wasSoft: boolean): Verdict {
    const ids = {
      ...(raw.conversationId === undefined ? {} : { conversationId: raw.conversationId }),
      ...(raw.agentId === undefined ? {} : { agentId: raw.agentId })
    }
    if (raw.structured !== undefined) {
      return { status: 'done', outcome: { result: raw.result, structured: raw.structured, ...ids } }
    }
    if (aborted || raw.error === 'aborted') {
      const result = wasSoft ? raw.result : abortedNote()
      return { status: 'killed', outcome: { result, error: 'aborted', ...ids } }
    }
    if (raw.error !== undefined) {
      return { status: 'error', outcome: { result: raw.result, error: raw.error, ...ids } }
    }
    return { status: 'done', outcome: { result: raw.result, ...ids } }
  }

  function broadcastEnd(
    agentId: string,
    parentSessionId: string,
    result: string,
    isError: boolean
  ): void {
    deps.broadcast({
      type: 'sub_session_end',
      sessionId: agentId,
      parentSessionId,
      result,
      isError
    })
  }

  /** 任务条目：没有就建、落定了就重开、在跑就复用（PIN-14） */
  function ensureTask(
    agentId: string,
    sessionId: string,
    title: string,
    subject: { profileName: string; depth: number; parentToolCallId?: string }
  ): void {
    const tasks = deps.tasks
    if (tasks === undefined) return
    const existing = tasks.get(agentId)
    if (existing === undefined) {
      tasks.create({
        taskId: agentId,
        kind: 'agent',
        sessionId,
        title,
        subject: { kind: 'agent', ...subject },
        // 停 = 软停止（保留已产出的部分结果、按「已完成」收尾），与面板上那枚中断按钮同义
        stop: () =>
          interrupt(agentId).catch((error: unknown) => {
            deps.logger?.warn(`interrupting agent ${agentId} failed: ${errorText(error)}`)
          })
        // 刻意不给 formatNotice：派发恒为同步等待，结果由那次调用交回；面板追问的结果在面板里
      })
    } else if (existing.endedAt !== null) {
      tasks.reopen(agentId)
    }
  }

  function parentOf(session: DurableSession, conversationId: number, sessionId: string): string {
    const identity = session.agentIdentity(conversationId)
    return identity?.kind === 'spawned' && identity.callerId ? identity.callerId : sessionId
  }

  async function runToolTask(params: RunTaskParams, scope: ToolCallScope): Promise<RunTaskOutcome> {
    const { sessionId, agentType, prompt, description, parentToolCallId, resultContract } = params
    const session = deps.sessions.get(sessionId)
    if (session === undefined) {
      const text = `Session is not open: ${sessionId}`
      return { result: text, error: text }
    }
    const parentSessionId = parentOf(session, scope.conversationId, sessionId)

    /** 这一次 runTask 里已登记的 agentId（onCreated 可能来两次：重新挂上，PIN-14） */
    let created: string | undefined
    let joined: Promise<unknown> | undefined

    const onCreated = (info: SpawnCreatedInfo): void => {
      const { agentId } = info
      index.set(agentId, {
        sessionId,
        conversationId: info.conversationId,
        parentSessionId,
        displayName: info.displayName,
        profileName: agentType.name,
        depth: info.depth
      })
      running.add(agentId)
      deps.broadcast({
        type: 'sub_session_register',
        sessionId: agentId,
        parentSessionId,
        parentToolCallId,
        subAgentName: agentType.name,
        displayName: info.displayName,
        description: info.description,
        systemPrompt: agentType.systemPrompt,
        prompt,
        depth: info.depth,
        rootSessionId: sessionId
      })
      ensureTask(agentId, sessionId, info.displayName, {
        profileName: agentType.name,
        depth: info.depth,
        parentToolCallId
      })
      if (created !== agentId) {
        created = agentId
        // 同步等待：把等待者挂在任务上 —— 落定时「还有人在等」，枢纽因此不发完成通知
        joined = deps.tasks?.join(agentId)
      }
      deps.logger?.info(
        `${info.reattached ? 'Re-attached' : 'Spawned'} agent=${agentId} profile=${agentType.name} session=${sessionId} conversation=${info.conversationId} depth=${info.depth}`
      )
    }

    const finish = async (
      agentId: string,
      status: SettleStatus,
      result: string,
      isError: boolean
    ): Promise<void> => {
      running.delete(agentId)
      soft.delete(agentId)
      deps.tasks?.settle(agentId, { status })
      broadcastEnd(agentId, parentSessionId, result, isError)
      await joined
    }

    let raw: SpawnOutcome
    try {
      raw = await session.agents.spawn(
        {
          owner: { tool: scope.api },
          profile: agentType,
          prompt,
          description,
          ...(resultContract === undefined ? {} : { resultContract }),
          onCreated
        },
        scope.context
      )
    } catch (error) {
      // 子 agent 已建好之后协调器抛了（不该发生；兜底）：照样落定、照样收尾，再原样抛出
      if (created !== undefined) await finish(created, 'error', errorText(error), true)
      throw error
    }

    // 子 agent 根本没建起来（深度 / 模型 / 解析失败；或重新挂上时记录坏了）：没有登记过任何东西，原样交回
    // （不带子对话 id —— 派发工具据此把原因前缀 `Error:`，PIN-04）
    const agentId = created
    if (agentId === undefined) {
      const { result, error } = raw
      return error === undefined ? { result } : { result, error }
    }
    const aborted = scope.signal?.aborted === true || params.signal?.aborted === true
    const verdict = settleOf(raw, aborted, soft.has(agentId))
    await finish(agentId, verdict.status, verdict.outcome.result, verdict.status !== 'done')
    return verdict.outcome
  }

  async function interrupt(agentId: string): Promise<void> {
    const entry = index.get(agentId)
    if (entry === undefined) return
    // 会话关着 = 什么都没在跑（从不为中断打开会话，PIN-11）
    const session = deps.sessions.get(entry.sessionId)
    if (session === undefined) return
    // 同步记下软停止（紧跟着的中止也要看得到它，ME-25）
    if (running.has(agentId)) soft.add(agentId)
    await session.agents.interrupt(entry.conversationId)
  }

  async function destroy(agentId: string): Promise<void> {
    const entry = index.get(agentId)
    if (entry === undefined) return
    index.delete(agentId)
    soft.delete(agentId)
    try {
      const session = deps.sessions.get(entry.sessionId)
      if (session !== undefined) await session.agents.destroy(entry.conversationId)
    } finally {
      // 任务条目随之消失（用户从面板关掉了这条）。先落定再销：还在跑的那次 runTask 正挂在这条任务上等着
      deps.tasks?.settle(agentId, { status: 'killed' })
      deps.tasks?.dismiss(agentId)
    }
  }

  return {
    async runTask(params: RunTaskParams): Promise<RunTaskOutcome> {
      const { owner } = params
      if (!('tool' in owner)) {
        // 宿主派发（hook 的锚 / reviewer 的任务拥有者）在 P2-08 接上；在那之前如实报「还没有」
        throw new PhasePendingError('host-dispatched agents', 2)
      }
      return runToolTask(params, owner.tool)
    },

    async continueTask(params): Promise<void> {
      const { subSessionId: agentId, text, inlineTokens } = params
      const entry = index.get(agentId)
      if (entry === undefined) throw new Error(`Sub-session not found: ${agentId}`)
      if (running.has(agentId)) throw new Error(`Sub-session is busy: ${agentId}`)
      running.add(agentId)
      let session: DurableSession | undefined
      try {
        session = deps.sessions.get(entry.sessionId) ?? (await deps.sessions.peek(entry.sessionId))
      } catch (error) {
        running.delete(agentId)
        throw error
      }
      if (session === undefined) {
        // 存储没了（会话被删）：这个 agentId 再也到不了
        running.delete(agentId)
        index.delete(agentId)
        throw new Error(`Sub-session not found: ${agentId}`)
      }

      // 面板那条任务行代表的是**这个 agent**（不是它的某一轮），追问让它回到运行态
      ensureTask(agentId, entry.sessionId, entry.displayName, {
        profileName: entry.profileName,
        depth: entry.depth
      })

      // 内联 Token（slash 命令等）：原文 + tokens 落进消息 metadata 供面板渲染标签；发给 agent 的是解析后的文本
      const hasTokens = inlineTokens !== undefined && Object.keys(inlineTokens).length > 0
      const promptText = hasTokens ? resolveTokensForAgent(text, inlineTokens) : text
      deps.broadcast({
        type: 'user_message',
        sessionId: agentId,
        message: JSON.stringify({
          id: `${agentId}-user-${Date.now()}`,
          sessionId: agentId,
          role: 'user' as const,
          type: 'text' as const,
          content: text,
          metadata: hasTokens ? { inlineTokens } : null,
          model: '',
          createdAt: Date.now()
        })
      })

      let verdict: Verdict
      try {
        const raw = await session.agents.continue(entry.conversationId, promptText)
        verdict = settleOf(raw, false, soft.has(agentId))
      } catch (error) {
        verdict = {
          status: 'error',
          outcome: { result: errorText(error), error: errorText(error) }
        }
      }
      running.delete(agentId)
      soft.delete(agentId)
      deps.tasks?.settle(agentId, { status: verdict.status })
      broadcastEnd(
        agentId,
        entry.parentSessionId,
        verdict.outcome.result,
        verdict.status !== 'done'
      )
    },

    interrupt,

    destroy,

    has(agentId: string): boolean {
      return index.has(agentId)
    },

    locate(agentId: string): SubAgentLocation | undefined {
      const entry = index.get(agentId)
      return entry === undefined
        ? undefined
        : { sessionId: entry.sessionId, conversationId: entry.conversationId }
    },

    async getRuntimeInfo(): Promise<AgentRuntimeInfo | null> {
      return null
    }
  }
}
