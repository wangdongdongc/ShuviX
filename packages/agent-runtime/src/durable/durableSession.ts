/**
 * DurableSession —— 一条会话（一个 pi-durable 存储、一个 Harness）之上的 ShuviX 运行时语义。
 *
 * durable 已经把「会话树 + run + 工具 + 重试 + 压缩 + 崩溃恢复」做成了持久化的任务；这里只补
 * ShuviX 自己的那几条规矩：
 *
 *  - **当前对话**：`SessionStateDoc.currentConversation`（回退 fork 之后指向新分支），指向不存在的
 *    对话时回退到根并记警告（R11）。发送、中止、思考档位都作用在当前对话上。
 *  - **运行状态**（R2）：`isBusy` = 当前对话有 run 且调度器在跑；`isInterrupted` = 存储里有 run 但
 *    调度器停着。打开会话**从不** `resume()` —— 上个进程留下的 run 停在原地，等用户「继续」或发送。
 *    状态由提交发布（`subscribeCommits`，同步）维护，所以 `submitUser` 落定的那一刻读到的就是真值。
 *    调度器是否在跑：durable 只有「打开时停着、任何要求进展的调用都会开启、此后一直开着」，
 *    这里经包一层 harness 代理记下每一次会开启调度器的调用，并以「有任务进入 running」兜底。
 *  - **发送**（R3/R4/R5）：结果是 `{}` 或 `{ error, code }`，从不抛出；每条起跑路径都重开询问窗口；
 *    中断会话上的发送按 `interruptedSendPolicy` 处理（一行切换）。
 *  - **系统通知**（R1/Q3）：会话被中断、或空闲但收件箱里留着上次失败的输入时，通知不能直接写
 *    （任何提交都会开启调度器 / 把残留输入带着起一轮），先存进 `SessionStateDoc.deferredNotices`，
 *    在下一次发送之前、继续、中止时送达。
 *  - **自动续跑**（R13，`notify`）：运行中 → steer；空闲且允许 → 合并窗口内攒起来起一轮；空闲但
 *    不允许 → 写通知；被中断 → 推迟。显式 `abort()` 之后到下一次 `submitUser` 之前不自动续跑。
 *  - **中止顺序**：先关询问窗口 → 宿主的中止前 seam（作废进行中的自动审查）→ 取消挂起的询问 →
 *    中止对话。前三步同步完成后立刻发起对话中止，工具拿到「已取消」时 abort 标记的提交已经排在它前面。
 *  - **日期通知**（Q14，P1-08）：注入了 `today` 时，每次用户输入（submitUser / steer / followUp）之前
 *    先 `maybeAnnounceDate` —— 新的一天里第一次输入之前追加一条 `shuvix.notice`（kind `date`），
 *    排在这次输入之前。没注入 = 不发。失败只记日志，不挡用户的发送。
 *  - **锁**（P1-09，`lock.ts`）：「这条会话有 agent」。打开时、在任何续跑 / 发送之前按锁记录重建工具；
 *    没锁时，发送 / steer / followUp / 自动续跑 / 继续都先创建 agent（K3，每会话一把互斥）；模型被拒
 *    → `{ error, code: 'no_model' }`，什么都不写（K4）。中止与销毁都会取消在途的创建（K13）；销毁算一次
 *    显式喊停（K10）。
 */
import { copyJson } from '@earendil-works/chord'
import {
  ConversationBusy,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type CommitPublication,
  type Conversation,
  type ConversationId,
  type Harness,
  type JsonObject,
  type Submission,
  type SubmissionId,
  type SubmissionRecord,
  type TaskId,
  type UserInput
} from '@earendil-works/pi-durable'
import type { HarnessSettings, Registry, ToolRegistration } from '@earendil-works/pi-durable'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import type { PromptVars, PromptVarsCtx } from '../agentProfile/promptVars'
import type { RuntimeEventSink, RuntimeLogger } from '../types'
import { backgroundContext as BG, errorText, isClosedError } from './context'
import {
  DisplayDoc,
  SessionStateDoc,
  noticeEntryDraft,
  type DeferredNotice,
  type SessionState
} from './docs'
import { PendingInputRequests } from './inputRequests'
import { AgentCreationError, AgentLock, type CreateAgentOptions, type LockRecord } from './lock'
import { maybeAnnounceDate } from './prompt/dateNotice'
import type { PromptExtensions } from './prompt/sections'
import type { AgentConfig, InterruptedSendPolicy, ModelCatalog, RunState, ToolHost } from './seams'

const GENERATION_TASK_KIND = 'pi.generation'
const LIVE_TASK_STATUSES = ['pending', 'running', 'waiting', 'completing'] as const
const SCAN_PAGE_SIZE = 256

// ─────────────────────────── 公共类型 ───────────────────────────

/** 发送失败的分类（R3） */
export type SubmitErrorCode =
  | 'busy'
  | 'closed'
  | 'model_error'
  | 'no_model'
  | 'faulted'
  | 'orphaned'

/** 发送 / 继续的结果：成功 = `{}`；失败 = `{ error, code? }`（code 缺省 = 未知原因） */
export interface SubmitResult {
  error?: string
  code?: SubmitErrorCode
}

/** steer / followUp 的结果：受理即返回（不等 run 结束），附 submission id 供需要时等待 */
export interface AdmitResult extends SubmitResult {
  submissionId?: SubmissionId
}

export interface UserSendOptions {
  /** 幂等键：同一 requestId 重复发送只落一条、只起一轮 */
  requestId?: string
  /** 会话忙时：reject（缺省，Q13）/ followUp / steer */
  whenBusy?: 'reject' | 'followUp' | 'steer'
  /** 显示侧车（内联 Token 等），记在 DisplayDoc[requestId]；没有 requestId 时自动生成一个 */
  display?: JsonObject
  /**
   * 这条输入被受理的那一刻（durable 已接下这次提交，run 还没落定）调用一次。被拒（忙 / 模型被拒 /
   * 会话已关 / 创建被取消）时从不调用。抛错只记日志，不影响发送本身（桌面：`session.prompt-accepted`
   * 埋点与活跃时间入账在这里）。
   */
  onAdmitted?: () => void
}

export interface NoticeInput {
  text: string
  /** 通知种类（`background` / `date` / …），进 `NoticeEntry.data.kind` */
  kind: string
  /** 幂等键；缺省自动生成 */
  requestId?: string
  data?: JsonObject
}

export interface NoticeResult {
  /** submitted = 已交给 durable（空闲当场落条目，忙时排进收件箱）；deferred = 存进待送达 */
  status: 'submitted' | 'deferred' | 'closed' | 'failed'
  submissionId?: SubmissionId
  requestId?: string
  error?: string
}

/** 会话已关停（LRU 回收 / 退出 / 删除）；句柄失效，绝不悄悄重开 */
export class SessionClosedError extends Error {
  readonly code = 'closed' as const
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is closed`)
    this.name = 'SessionClosedError'
  }
}

export interface DurableSession {
  readonly sessionId: string
  /**
   * 底层 Harness（只读用途：测试与诊断）。经代理包装 —— 经它发起的会开启调度器的调用会被记下，
   * 运行状态因此保持准确；但绕过本类直接提交会跳过这里的规矩（询问窗口、推迟通知……）。
   */
  readonly harness: Harness
  /** 句柄是否已关停 */
  readonly closed: boolean
  /** 存储级运行状态（R2） */
  readonly runState: RunState
  /** 当前对话（R11：指向不存在的对话时回退到根） */
  currentConversation(): Promise<Conversation>
  /** 当前对话有 run 且调度器在跑 */
  isBusy(): boolean
  /** 存储里有 run 但调度器停着（上个进程中途退出） */
  isInterrupted(): boolean
  /** 继续被中断的工作，等当前对话空闲；空闲且未中断时立刻返回 */
  continue(): Promise<SubmitResult>
  /** 发送用户输入并等这一轮落定（R3：结果对象，从不抛出） */
  submitUser(content: UserInput, options?: UserSendOptions): Promise<SubmitResult>
  /** 运行中插话（空闲时起一轮，R4） */
  steer(content: UserInput, options?: { requestId?: string }): Promise<AdmitResult>
  /** 本轮结束后接着说（空闲时起一轮） */
  followUp(content: UserInput, options?: { requestId?: string }): Promise<AdmitResult>
  /** 写一条系统通知（`shuvix.notice`），必要时推迟（R1 / Q3） */
  writeNotice(notice: NoticeInput): Promise<NoticeResult>
  /** 送达后台完成通知（R13 的路由：steer / 自动续跑 / 写入 / 推迟） */
  notify(text: string, options?: { kind?: string }): Promise<void>
  /** 中止当前对话（显式喊停：到下一次 submitUser 之前不自动续跑） */
  abort(): Promise<void>
  /** 设置当前对话的思考档位（下一次请求生效；从不开启调度器） */
  setThinkingLevel(level: ThinkingLevel): Promise<void>
  /** 发起一条用户询问（工具用） */
  requestUserInput(request: InputRequest): Promise<InputResponse>
  /** 应答一条挂起的询问；不存在时返回 false */
  respondToInput(requestId: string, response: InputResponse): boolean
  /** 挂起中的询问数（>0 = 卡在等人回答） */
  readonly pendingInputCount: number
  /** 待答询问的人读摘要 */
  readonly pendingInputSummaries: string[]
  /** 此刻的锁记录（同步；undefined = 这条会话现在没有 agent） */
  readonly lock: LockRecord | undefined
  /**
   * 创建 agent（上锁）。已锁返回现有记录、不调任何 seam；并发调用合流成一次。模型被拒 / 被取消 /
   * 附加工具 → 抛 `AgentCreationError`；其余失败原样抛出。从不开启调度器。
   */
  createAgent(options?: CreateAgentOptions): Promise<LockRecord>
  /** 销毁 agent（解锁）：忙 / 被中断先中止；没锁 = 无操作 */
  destroyAgent(): Promise<void>
  /** 这个 Harness 实际在用的 settings（同步 getter；压缩余量按锁定模型的窗口算，K14） */
  readonly effectiveSettings: HarnessSettings
}

/** 关停原因：destroy = 删除会话（合并窗口里的通知随之丢弃），其余照常保存待送达通知 */
export type SessionCloseReason = 'remove' | 'invalidate' | 'destroy'

// ─────────────────────────── 结算映射（R3，纯函数） ───────────────────────────

function detailText(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined
  if (typeof detail === 'string') return detail.length > 0 ? detail : undefined
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/**
 * 把 durable 的 submission 落定记录映射成发送结果（R3）。
 *
 * aborted / stale / reset 都不是错误（有人喊停 / 被压缩越过 / 被重置截断）；model_error 带 provider 的
 * 原文；被孤立的 run 在 durable 里以「为什么接不上」作原因落定（missing_task / task_too_old /
 * migration_failed），这里一并归到 `orphaned`。
 */
export function settlementResult(
  record: Pick<SubmissionRecord, 'status'> & {
    readonly reason?: string
    readonly detail?: unknown
  }
): SubmitResult {
  if (record.status === 'done') return {}
  if (record.status !== 'unanswered') return { error: `Submission is still ${record.status}` }
  const reason = record.reason ?? ''
  const detail = detailText(record.detail)
  switch (reason) {
    case 'aborted':
    case 'stale':
    case 'reset':
      return {}
    case 'model_error':
      return { error: detail ?? 'The model request failed', code: 'model_error' }
    case 'no_model':
      return { error: detail ?? 'No model is configured for this conversation', code: 'no_model' }
    case 'faulted':
      return { error: detail ?? 'The run failed unexpectedly', code: 'faulted' }
    case 'orphaned':
    case 'missing_task':
    case 'task_too_old':
    case 'migration_failed':
      return { error: detail ?? `The run can no longer continue (${reason})`, code: 'orphaned' }
    default:
      return { error: reason }
  }
}

function resultOfError(error: unknown): SubmitResult {
  if (error instanceof SessionClosedError) return { error: error.message, code: 'closed' }
  if (error instanceof ConversationBusy) return { error: error.message, code: 'busy' }
  return { error: errorText(error) }
}

function randomId(): string {
  return globalThis.crypto.randomUUID()
}

// ─────────────────────────── 调度器开启观测（harness 代理） ───────────────────────────

/** 会开启调度器的 Harness 方法（durable 文档列出的那几个） */
const HARNESS_RESUMES = new Set<PropertyKey>(['resume', 'waitForTask', 'waitForIdle'])
/** 会开启调度器的 Conversation 方法（`reset` 走 submit，同样开启） */
const CONVERSATION_RESUMES = new Set<PropertyKey>(['compact', 'abort', 'waitForIdle', 'reset'])

type AnyMethod = (...args: unknown[]) => unknown

function observeSubmission(submission: Submission, onResume: () => void): Submission {
  return {
    id: submission.id,
    status: (context) => submission.status(context),
    wait: (context) => {
      onResume()
      return submission.wait(context)
    },
    abort: (context) => submission.abort(context)
  }
}

function observeConversation(conversation: Conversation, onResume: () => void): Conversation {
  return new Proxy(conversation, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      const method = value as AnyMethod
      if (prop === 'submit') {
        return async (...args: unknown[]) => {
          onResume()
          return observeSubmission((await method.apply(target, args)) as Submission, onResume)
        }
      }
      if (prop === 'fork') {
        return async (...args: unknown[]) =>
          observeConversation((await method.apply(target, args)) as Conversation, onResume)
      }
      if (CONVERSATION_RESUMES.has(prop)) {
        return (...args: unknown[]) => {
          onResume()
          return method.apply(target, args)
        }
      }
      return method.bind(target)
    }
  })
}

/** 包一层 Harness：所有会开启调度器的入口先记一笔（返回的对话 / submission 句柄同样包装） */
export function observeResumes(harness: Harness, onResume: () => void): Harness {
  return new Proxy(harness, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      const method = value as AnyMethod
      if (prop === 'root' || prop === 'conversation' || prop === 'createConversation') {
        return async (...args: unknown[]) => {
          const found = (await method.apply(target, args)) as Conversation | undefined
          return found === undefined ? undefined : observeConversation(found, onResume)
        }
      }
      if (prop === 'submission') {
        return async (...args: unknown[]) => {
          const found = (await method.apply(target, args)) as Submission | undefined
          return found === undefined ? undefined : observeSubmission(found, onResume)
        }
      }
      if (HARNESS_RESUMES.has(prop)) {
        return (...args: unknown[]) => {
          onResume()
          return method.apply(target, args)
        }
      }
      return method.bind(target)
    }
  })
}

// ─────────────────────────── 实现 ───────────────────────────

export interface DurableSessionDeps {
  sessionId: string
  /** 刚打开、尚未开启调度器的 Harness（本类接管它的关停） */
  harness: Harness
  eventSink: RuntimeEventSink
  interruptedSendPolicy: InterruptedSendPolicy
  /** 自动续跑开关（现读） */
  autoResume: () => boolean
  noticeCoalesceMs: number
  beforeAbort?: () => void
  onInputsReopened?: () => void
  /** 运行状态变化（已经推迟到微任务里调用，且关停后不再调用） */
  onStateChange: (state: RunState, previous: RunState) => void
  /** 每次被使用（LRU 新近度） */
  onUse: () => void
  /** 进行中的调用全部结束（它可能刚变得可回收 —— 宿主据此修剪） */
  onSettled?: () => void
  logger: RuntimeLogger
  now: () => number
  /** 今天的本地日期（`YYYY-MM-DD`）；缺省 = 不发日期通知 */
  today?: () => string
  /** 这条会话自己的注册表（K1；段落扩展已装好） */
  registry: Registry<ToolRegistration>
  toolHost: ToolHost
  resolveAgentConfig: (sessionId: string) => AgentConfig | Promise<AgentConfig>
  modelCatalog: ModelCatalog
  promptExtensions: PromptExtensions
  promptVars: (ctx: PromptVarsCtx) => PromptVars | Promise<PromptVars>
  onLockChange?: (sessionId: string, locked: boolean) => void
  /** 传给 Harness.open 的那份 settings（`effectiveSettings` 原样交出） */
  settings: HarnessSettings
}

interface LiveTask {
  readonly conversationId: ConversationId
  readonly kind: string
}

interface PendingNotice {
  readonly text: string
  readonly kind: string
}

export class DurableSessionImpl implements DurableSession {
  readonly sessionId: string
  readonly harness: Harness
  private readonly raw: Harness
  private readonly inputs: PendingInputRequests
  /** 此刻活着（非终态）的任务：由提交发布同步维护 */
  private readonly live = new Map<TaskId, LiveTask>()
  private schedulerRunning = false
  private state: RunState = 'idle'
  private current: ConversationId = ROOT_CONVERSATION_ID
  private closedFlag = false
  private closing: Promise<void> | undefined
  private activeOps = 0
  /** 有人显式喊停过：到下一次 submitUser 之前不自动续跑 */
  private stoppedByUser = false
  private pendingNotices: PendingNotice[] = []
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  private unsubscribe: () => void = () => {}
  private readonly agentLock: AgentLock

  private constructor(private readonly deps: DurableSessionDeps) {
    this.sessionId = deps.sessionId
    this.raw = deps.harness
    this.harness = observeResumes(deps.harness, () => this.markResumed())
    this.inputs = new PendingInputRequests(deps.sessionId, deps.eventSink)
    this.agentLock = new AgentLock({
      sessionId: deps.sessionId,
      harness: deps.harness,
      registry: deps.registry,
      toolHost: deps.toolHost,
      resolveAgentConfig: deps.resolveAgentConfig,
      modelCatalog: deps.modelCatalog,
      promptExtensions: deps.promptExtensions,
      promptVars: deps.promptVars,
      eventSink: deps.eventSink,
      ...(deps.onLockChange === undefined ? {} : { onLockChange: deps.onLockChange }),
      logger: deps.logger,
      now: deps.now,
      currentConversation: () => this.currentConversation(),
      stopForDestroy: () => this.stopForDestroy()
    })
  }

  /** 接管一个刚打开的 Harness：订阅提交、装载活着的任务、解析当前对话 */
  static async attach(deps: DurableSessionDeps): Promise<DurableSessionImpl> {
    const session = new DurableSessionImpl(deps)
    await session.init()
    return session
  }

  private async init(): Promise<void> {
    this.unsubscribe = this.raw.subscribeCommits((publication) => this.observe(publication))
    // 在串行线上扫一遍活着的任务，并在回调末尾**同步**装载：此前的发布被这次扫描覆盖，
    // 此后的发布来自更晚的提交、叠加在它上面 —— 两者之间没有缝。（只读提交不产生发布。）
    await this.raw.commit(async (tx) => {
      const records: { id: TaskId; conversationId: ConversationId; kind: string }[] = []
      for (const status of LIVE_TASK_STATUSES) {
        let cursor: Parameters<typeof tx.scanTasks>[2]
        do {
          const page = await tx.scanTasks({ status }, SCAN_PAGE_SIZE, cursor)
          for (const record of page.items) records.push(record)
          cursor = page.next
        } while (cursor !== undefined)
      }
      this.live.clear()
      for (const record of records) {
        this.live.set(record.id, { conversationId: record.conversationId, kind: record.kind })
      }
    }, BG)
    await this.currentConversation()
    // 在任何续跑 / 发送之前按锁重建工具（打开从不续跑，所以在这里重建是安全的），再对一次镜像（K11）
    await this.agentLock.restore()
    // 初始状态静默设定：宿主在打开完成时统一报一次（PIN-R），这里再排一次通知就会报两遍
    this.state = this.computeState()
    this.agentLock.reconcileMirror()
  }

  // ─── 运行状态 ───────────────────────────────────

  get closed(): boolean {
    return this.closedFlag
  }

  get runState(): RunState {
    return this.state
  }

  isBusy(): boolean {
    return this.schedulerRunning && this.hasRun(this.current)
  }

  isInterrupted(): boolean {
    return !this.schedulerRunning && this.hasRun(undefined)
  }

  /** LRU 能不能关它：不忙、没有挂起的询问、没有进行中的调用、没有待合并的通知 */
  get evictable(): boolean {
    return (
      !this.closedFlag &&
      this.state !== 'busy' &&
      this.inputs.count === 0 &&
      this.activeOps === 0 &&
      this.pendingNotices.length === 0
    )
  }

  private hasRun(conversationId: ConversationId | undefined): boolean {
    for (const task of this.live.values()) {
      if (task.kind !== GENERATION_TASK_KIND) continue
      if (conversationId === undefined || task.conversationId === conversationId) return true
    }
    return false
  }

  private computeState(): RunState {
    if (this.live.size === 0) return 'idle'
    if (this.schedulerRunning) return 'busy'
    return this.hasRun(undefined) ? 'interrupted' : 'idle'
  }

  /** 状态即时更新（同步读取永远是真值），通知推迟到微任务（提交监听里不许回调宿主） */
  private recompute(): void {
    const next = this.computeState()
    if (next === this.state) return
    const previous = this.state
    this.state = next
    queueMicrotask(() => {
      if (!this.closedFlag) this.deps.onStateChange(next, previous)
    })
  }

  private markResumed(): void {
    if (this.schedulerRunning || this.closedFlag) return
    this.schedulerRunning = true
    this.recompute()
  }

  /** 提交发布监听（同步，在 Session 串行线上）：维护活着的任务与当前对话指针 */
  private observe(publication: CommitPublication): void {
    if (this.closedFlag) return
    let changed = false
    for (const change of publication.changes) {
      if (change.type === 'task') {
        const record = change.value
        if (record.state.status === 'terminal') {
          if (this.live.delete(record.id)) changed = true
          continue
        }
        this.live.set(record.id, { conversationId: record.conversationId, kind: record.kind })
        // 只有开启了的调度器会把任务置为 running（打开时残留的 running 会被改回 pending）
        if (record.state.status === 'running') this.schedulerRunning = true
        changed = true
      } else if (
        change.type === 'document' &&
        change.record.kind === SessionStateDoc.definition.kind &&
        change.value !== null
      ) {
        // 锁缓存：谁写了 SessionStateDoc.lock 都跟着变（同步，读取永远是真值）
        this.agentLock.observe((change.value as SessionState).lock)
        const pointer = (change.value as SessionState).currentConversation ?? ROOT_CONVERSATION_ID
        if (pointer !== this.current) {
          this.current = pointer
          // 指针可能指向不存在的对话（R11）：校验是读操作，不能在提交监听里做
          queueMicrotask(() => void this.currentConversation().catch(() => undefined))
        }
      }
    }
    if (changed) this.recompute()
  }

  // ─── 当前对话 ───────────────────────────────────

  async currentConversation(): Promise<Conversation> {
    this.assertOpen()
    const pointer = (await this.harness.snapshot(SessionStateDoc, BG))?.currentConversation
    if (pointer !== undefined && pointer !== ROOT_CONVERSATION_ID) {
      const found = await this.harness.conversation(pointer, BG)
      if (found !== undefined) {
        this.current = found.id
        return found
      }
      this.deps.logger.warn(
        `session ${this.sessionId}: current conversation ${pointer} does not exist; using the root`
      )
    }
    this.current = ROOT_CONVERSATION_ID
    return (
      (await this.harness.conversation(ROOT_CONVERSATION_ID, BG)) ?? (await this.harness.root(BG))
    )
  }

  // ─── 发送 ───────────────────────────────────────

  async submitUser(content: UserInput, options: UserSendOptions = {}): Promise<SubmitResult> {
    try {
      return await this.op(async () => {
        // 用户又开口了 —— 上一次「显式喊停」的收敛到此为止；合并窗口里的通知随这一轮插话送达
        this.stoppedByUser = false
        // 没锁先创建 agent（K3）；被拒 / 被取消就到此为止，什么都不写
        const refused = await this.ensureAgent()
        if (refused !== undefined) return refused
        const joining = this.takePendingNotices()
        let whenBusy = options.whenBusy ?? 'reject'
        if (this.isInterrupted()) whenBusy = await this.applyInterruptedPolicy(whenBusy)
        // 明摆着会被拒（忙且不是同一 requestId 的重发）：别先写显示侧车、别动待送达通知。
        // 竞态下仍由 durable 的受理兜底（ConversationBusy）
        if (whenBusy === 'reject' && options.requestId === undefined && this.isBusy()) {
          if (joining.length > 0) await this.steerNotices(await this.currentConversation(), joining)
          return { error: 'The conversation is busy', code: 'busy' }
        }
        this.reopenInputs()
        const conversation = await this.currentConversation()
        let requestId = options.requestId
        if (options.display !== undefined) {
          requestId ??= randomId()
          await this.recordDisplay(conversation, requestId, options.display)
        }
        if (whenBusy !== 'reject' || !this.isBusy()) {
          await this.flushDeferred(conversation, 'beforeSend')
          await this.announceDate(conversation)
        }
        let submission: Submission
        try {
          submission = await conversation.submit(
            { type: 'input', content, whenBusy, ...(requestId === undefined ? {} : { requestId }) },
            BG
          )
        } catch (error) {
          if (joining.length > 0) await this.steerNotices(conversation, joining)
          throw error
        }
        this.admitted(options.onAdmitted)
        if (joining.length > 0) await this.steerNotices(conversation, joining)
        return settlementResult(await submission.wait(BG))
      })
    } catch (error) {
      return resultOfError(error)
    }
  }

  /** 受理回调（`UserSendOptions.onAdmitted`）：抛错只记日志 */
  private admitted(callback: (() => void) | undefined): void {
    if (callback === undefined) return
    try {
      callback()
    } catch (error) {
      this.deps.logger.warn(`onAdmitted failed session=${this.sessionId}: ${errorText(error)}`)
    }
  }

  steer(content: UserInput, options: { requestId?: string } = {}): Promise<AdmitResult> {
    return this.admitUser(content, 'steer', options.requestId)
  }

  followUp(content: UserInput, options: { requestId?: string } = {}): Promise<AdmitResult> {
    return this.admitUser(content, 'followUp', options.requestId)
  }

  private async admitUser(
    content: UserInput,
    mode: 'steer' | 'followUp',
    requestId: string | undefined
  ): Promise<AdmitResult> {
    try {
      return await this.op(async () => {
        const refused = await this.ensureAgent()
        if (refused !== undefined) return refused
        let whenBusy: 'steer' | 'followUp' | 'reject' = mode
        if (this.isInterrupted()) whenBusy = await this.applyInterruptedPolicy(whenBusy)
        this.reopenInputs()
        const conversation = await this.currentConversation()
        await this.flushDeferred(conversation, 'beforeSend')
        await this.announceDate(conversation)
        const submission = await conversation.submit(
          { type: 'input', content, whenBusy, ...(requestId === undefined ? {} : { requestId }) },
          BG
        )
        return { submissionId: submission.id }
      })
    } catch (error) {
      return resultOfError(error)
    }
  }

  /** 中断会话上的用户输入（R5）：返回这次提交该用的 whenBusy */
  private async applyInterruptedPolicy(
    whenBusy: 'reject' | 'followUp' | 'steer'
  ): Promise<'reject' | 'followUp' | 'steer'> {
    if (this.deps.interruptedSendPolicy === 'abort-then-send') {
      // 用户已经往前走了：中止被中断的工作（上个进程留下的排队输入随之撤回），再正常发送
      await this.abortConversation()
      return whenBusy
    }
    // 先让被中断的 run 跑完，这条排在它后面
    return whenBusy === 'steer' ? 'steer' : 'followUp'
  }

  async continue(): Promise<SubmitResult> {
    try {
      return await this.op(async () => {
        const refused = await this.ensureAgent()
        if (refused !== undefined) return refused
        this.reopenInputs()
        const conversation = await this.currentConversation()
        // 被中断的 run 还在：推迟的通知进收件箱，在它的下一个边界落下
        await this.flushDeferred(conversation, 'place')
        this.harness.resume()
        await conversation.waitForIdle(BG)
        return {}
      })
    } catch (error) {
      return resultOfError(error)
    }
  }

  // ─── 日期通知 ───────────────────────────────────

  /**
   * 用户输入之前的日期通知（Q14）。在送达推迟的通知**之后**调用：之前推迟的通知（发生得更早）先排进
   * 收件箱，日期通知紧挨着这次输入。它自己被推迟（被中断 / 空闲但留着失败输入）时立刻再送一次，
   * 好让它同样排在这次输入之前。
   *
   * 没注入 `today` 就什么都不做；失败只记日志 —— 日期通知是给模型的背景信息，不值得挡住用户的发送
   * （没记下日期，下一次输入会再试）。关停照常向上抛。
   */
  private async announceDate(conversation: Conversation): Promise<void> {
    const today = this.deps.today
    if (today === undefined) return
    try {
      const result = await maybeAnnounceDate(this, conversation, {
        today: today(),
        now: this.deps.now()
      })
      if (result.status === 'deferred') await this.flushDeferred(conversation, 'beforeSend')
      else if (result.status === 'failed') {
        this.deps.logger.warn(
          `date notice failed session=${this.sessionId}: ${result.error ?? 'unknown error'}`
        )
      }
    } catch (error) {
      if (this.closedFlag || isClosedError(error) || error instanceof SessionClosedError)
        throw error
      this.deps.logger.warn(`date notice failed session=${this.sessionId}: ${errorText(error)}`)
    }
  }

  // ─── 系统通知 ───────────────────────────────────

  async writeNotice(notice: NoticeInput): Promise<NoticeResult> {
    const requestId = notice.requestId ?? randomId()
    try {
      return await this.op(async () => {
        const deferred: DeferredNotice = {
          requestId,
          text: notice.text,
          kind: notice.kind,
          ...(notice.data === undefined ? {} : { data: notice.data })
        }
        // 被中断：任何提交都会开启调度器、把被中断的 run 续上（Q3）
        if (this.isInterrupted()) {
          await this.deferNotices([deferred])
          return { status: 'deferred', requestId }
        }
        const conversation = await this.currentConversation()
        if (!this.isBusy()) {
          // 空闲但收件箱里留着上次失败的输入：写入会让 durable 带着它们起一轮（R1）
          const inbox = await this.harness.snapshot(InboxDoc, conversation.id, BG)
          if (inbox?.items.some((item) => item.mode !== 'write')) {
            await this.deferNotices([deferred])
            return { status: 'deferred', requestId }
          }
        }
        const submission = await conversation.submit(
          { type: 'write', entry: noticeEntryDraft(deferred, this.deps.now()), requestId },
          BG
        )
        return { status: 'submitted', submissionId: submission.id, requestId }
      })
    } catch (error) {
      if (error instanceof SessionClosedError) {
        return { status: 'closed', requestId, error: error.message }
      }
      return { status: 'failed', requestId, error: errorText(error) }
    }
  }

  async notify(text: string, options: { kind?: string } = {}): Promise<void> {
    if (this.closedFlag) return
    const kind = options.kind ?? 'background'
    try {
      await this.op(async () => {
        if (this.isInterrupted()) {
          await this.writeNotice({ text, kind })
          return
        }
        if (this.isBusy()) {
          await this.steerNotices(await this.currentConversation(), [{ text, kind }])
          return
        }
        if (!this.canAutoResume()) {
          await this.writeNotice({ text, kind })
          return
        }
        // 合并同一时刻到达的多条：三个子会话同一秒跑完不该起三轮
        this.pendingNotices.push({ text, kind })
        this.noticeTimer ??= setTimeout(() => void this.fireNotices(), this.deps.noticeCoalesceMs)
      })
    } catch (error) {
      if (!(error instanceof SessionClosedError)) {
        this.deps.logger.warn(`notify failed session=${this.sessionId}: ${errorText(error)}`)
      }
    }
  }

  private canAutoResume(): boolean {
    if (this.stoppedByUser) return false
    try {
      return this.deps.autoResume()
    } catch {
      return true
    }
  }

  /** 合并窗口到期：起自动续跑那一轮（这期间被中断 / 被关掉开关 / 被喊停就退回写通知） */
  private async fireNotices(): Promise<void> {
    this.noticeTimer = undefined
    const notices = this.pendingNotices.splice(0)
    if (notices.length === 0 || this.closedFlag) return
    try {
      await this.op(async () => {
        if (this.isInterrupted() || !this.canAutoResume()) {
          for (const notice of notices) await this.writeNotice(notice)
          return
        }
        // 没锁先创建 agent（K3）；创建不成（被拒 / 被取消）就退回写通知，通知不丢
        if ((await this.ensureAgent()) !== undefined) {
          for (const notice of notices) await this.writeNotice(notice)
          return
        }
        this.reopenInputs()
        const conversation = await this.currentConversation()
        await this.flushDeferred(conversation, 'beforeSend')
        // 期间用户先开了一轮 → 作为插话汇入；仍空闲 → 起一轮
        await conversation.submit(
          { type: 'input', content: notices.map((n) => n.text).join('\n\n'), whenBusy: 'steer' },
          BG
        )
      })
    } catch (error) {
      if (!(error instanceof SessionClosedError)) {
        this.deps.logger.warn(`auto-resume failed session=${this.sessionId}: ${errorText(error)}`)
      }
    }
  }

  private takePendingNotices(): PendingNotice[] {
    if (this.noticeTimer !== undefined) {
      clearTimeout(this.noticeTimer)
      this.noticeTimer = undefined
    }
    return this.pendingNotices.splice(0)
  }

  private async steerNotices(conversation: Conversation, notices: PendingNotice[]): Promise<void> {
    try {
      this.reopenInputs()
      await conversation.submit(
        { type: 'input', content: notices.map((n) => n.text).join('\n\n'), whenBusy: 'steer' },
        BG
      )
    } catch (error) {
      if (this.closedFlag || isClosedError(error)) return
      this.deps.logger.warn(`notice steer failed session=${this.sessionId}: ${errorText(error)}`)
    }
  }

  /** 存进待送达（同一 requestId 只存一份） */
  private async deferNotices(notices: DeferredNotice[]): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(SessionStateDoc)
      for (const notice of notices) {
        if (state.deferredNotices.some((n) => n.requestId === notice.requestId)) continue
        state.deferredNotices.push(
          copyJson(notice, { omitUndefinedProperties: true }) as DeferredNotice
        )
      }
    }, BG)
  }

  /**
   * 送达待送达通知。
   *  - `beforeSend`：一个提交里把它们作为排队的写入放进收件箱（并从待送达移除）—— 紧接着的发送
   *    在同一个边界里先落写入、再落用户消息，于是通知恰好排在这次发送之前；
   *  - `place`：对话有 run、或收件箱里留着输入时同上（下一个边界 / 下一次发送带走）；
   *    否则逐条直接写入（当场落条目），再清掉待送达。两步之间崩溃无妨：requestId 去重。
   */
  private async flushDeferred(
    conversation: Conversation,
    mode: 'beforeSend' | 'place'
  ): Promise<void> {
    const deferred = (await this.harness.snapshot(SessionStateDoc, BG))?.deferredNotices ?? []
    if (deferred.length === 0) return
    if (mode === 'beforeSend') return this.enqueueDeferred(conversation.id)
    const live = await this.harness.snapshot(LiveDoc, conversation.id, BG)
    const inbox = await this.harness.snapshot(InboxDoc, conversation.id, BG)
    if (live?.run !== undefined || inbox?.items.some((item) => item.mode !== 'write')) {
      return this.enqueueDeferred(conversation.id)
    }
    for (const notice of deferred) {
      await conversation.submit(
        {
          type: 'write',
          entry: noticeEntryDraft(notice, this.deps.now()),
          requestId: notice.requestId
        },
        BG
      )
    }
    const delivered = new Set(deferred.map((notice) => notice.requestId))
    await this.harness.commit(async (tx) => {
      const notices = (await tx.doc(SessionStateDoc)).deferredNotices
      for (let index = notices.length - 1; index >= 0; index--) {
        if (delivered.has(notices[index]!.requestId)) notices.splice(index, 1)
      }
    }, BG)
  }

  /**
   * 一个提交：待送达通知 → 收件箱里的排队写入，同时从待送达移除。自己实现这一小段受理
   * （`tx.createSubmission` 文档允许），因为 `submit()` 在空闲时会立刻跑一个边界；
   * 已有同 requestId 的 submission（上次送到一半）只移除、不重复。
   */
  private async enqueueDeferred(conversationId: ConversationId): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(SessionStateDoc)
      const notices = state.deferredNotices.map((n) => copyJson(n) as DeferredNotice)
      if (notices.length === 0) return
      // 表读必须先于本提交的第一次表写
      const known: boolean[] = []
      for (const notice of notices) {
        known.push((await tx.submissionByRequest(conversationId, notice.requestId)) !== undefined)
      }
      const inbox = await tx.doc(InboxDoc, conversationId)
      const now = this.deps.now()
      for (let index = 0; index < notices.length; index++) {
        if (known[index]) continue
        const notice = notices[index]!
        const record = await tx.createSubmission({
          conversationId,
          requestId: notice.requestId,
          type: 'write',
          status: 'queued'
        })
        const entry = copyJson(noticeEntryDraft(notice, now), {
          omitUndefinedProperties: true
        }) as JsonObject
        inbox.items.push({ id: record.id, mode: 'write', entry })
      }
      state.deferredNotices.splice(0, notices.length)
    }, BG)
  }

  private async recordDisplay(
    conversation: Conversation,
    requestId: string,
    display: JsonObject
  ): Promise<void> {
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(DisplayDoc, conversation.id)
      doc.items[requestId] = copyJson(display, { omitUndefinedProperties: true }) as JsonObject
    }, BG)
  }

  // ─── 中止 ───────────────────────────────────────

  async abort(): Promise<void> {
    if (this.closedFlag) return
    this.stoppedByUser = true
    const pending = this.takePendingNotices()
    try {
      await this.op(async () => {
        // 在途的创建一并取消（K13）：它什么都不写，等着它的发送当作被中止
        await this.agentLock.cancelCreation()
        await this.abortConversation()
        // 推迟的通知被中断 / 残留输入挡着 —— 中止把它们清掉了，现在送达
        await this.flushDeferred(await this.currentConversation(), 'place')
        // 合并窗口里的通知不再起轮，改为写入
        for (const notice of pending) await this.writeNotice(notice)
      })
    } catch (error) {
      if (!(error instanceof SessionClosedError)) throw error
    }
  }

  /**
   * 中止顺序：关询问窗口 → 中止前 seam → 取消挂起的询问 → 中止对话。后三步同步衔接：
   * 对话中止的 abort 标记提交在任何工具拿到「已取消」继续执行之前就已排上串行线。
   */
  private async abortConversation(): Promise<void> {
    const conversation = await this.currentConversation()
    this.inputs.closeInputs('aborted')
    try {
      this.deps.beforeAbort?.()
    } catch (error) {
      this.deps.logger.warn(`beforeAbort failed session=${this.sessionId}: ${errorText(error)}`)
    }
    this.inputs.cancelAll('aborted')
    await conversation.abort(BG)
  }

  // ─── 锁（P1-09） ─────────────────────────────────

  get lock(): LockRecord | undefined {
    return this.agentLock.current
  }

  get effectiveSettings(): HarnessSettings {
    return this.deps.settings
  }

  async createAgent(options?: CreateAgentOptions): Promise<LockRecord> {
    return this.op(() => this.agentLock.ensure(options))
  }

  async destroyAgent(): Promise<void> {
    if (this.closedFlag) return
    try {
      await this.op(() => this.agentLock.destroy())
    } catch (error) {
      if (!(error instanceof SessionClosedError)) throw error
    }
  }

  /**
   * 起跑之前确保有 agent（K3）。成功 = undefined；被拒 → `{ error, code: 'no_model' }`；被取消（中止 /
   * 销毁打断了创建，K13）→ `{}`；其余失败 → `{ error }`。关停照常向上抛（op 收成 closed）。
   */
  private async ensureAgent(): Promise<SubmitResult | undefined> {
    try {
      await this.agentLock.ensure()
      return undefined
    } catch (error) {
      if (this.closedFlag || isClosedError(error)) throw error
      if (error instanceof AgentCreationError) {
        if (error.code === 'cancelled') return {}
        if (error.code === 'no_model') return { error: error.message, code: 'no_model' }
        return { error: error.message }
      }
      this.deps.logger.warn(`agent creation failed session=${this.sessionId}: ${errorText(error)}`)
      return { error: errorText(error) }
    }
  }

  /**
   * 销毁之前让会话停下（K10）：显式喊停（到下一次 submitUser 之前不自动续跑）；忙 / 被中断就中止
   * （与 abort 同一套：询问取消、审查作废），再送达被中断挡着的推迟通知；空闲不中止 —— 收件箱里
   * 残留的输入、当前对话、推迟通知都原样留着。合并窗口里的通知改为写入。
   */
  private async stopForDestroy(): Promise<void> {
    this.stoppedByUser = true
    const pending = this.takePendingNotices()
    if (this.isBusy() || this.isInterrupted()) {
      await this.abortConversation()
      await this.flushDeferred(await this.currentConversation(), 'place')
    }
    for (const notice of pending) await this.writeNotice(notice)
  }

  // ─── 配置 ───────────────────────────────────────

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.op(async () => {
      const conversation = await this.currentConversation()
      await conversation.configure({ thinkingLevel: level }, BG)
    })
  }

  // ─── 用户询问 ───────────────────────────────────

  requestUserInput(request: InputRequest): Promise<InputResponse> {
    return this.inputs.request(request)
  }

  respondToInput(requestId: string, response: InputResponse): boolean {
    return this.inputs.respond(requestId, response)
  }

  get pendingInputCount(): number {
    return this.inputs.count
  }

  get pendingInputSummaries(): string[] {
    return this.inputs.summaries
  }

  private reopenInputs(): void {
    this.inputs.reopenInputs()
    try {
      this.deps.onInputsReopened?.()
    } catch (error) {
      this.deps.logger.warn(
        `onInputsReopened failed session=${this.sessionId}: ${errorText(error)}`
      )
    }
  }

  // ─── 生命周期 ───────────────────────────────────

  /**
   * 关停（宿主经 SessionManager 调用）。先保存合并窗口里的通知（删除时丢弃），再关询问窗口并
   * 取消挂起的询问（否则一个等人回答的工具会让 Harness 的关停永远等下去），最后关 Harness。
   * 忙碌中关停不发任何运行状态事件：存储里留下的 run 在下次打开时报 interrupted。
   */
  close(reason: SessionCloseReason = 'remove'): Promise<void> {
    this.closing ??= this.doClose(reason)
    return this.closing
  }

  private async doClose(reason: SessionCloseReason): Promise<void> {
    const pending = this.takePendingNotices()
    if (pending.length > 0 && reason !== 'destroy') {
      try {
        await this.deferNotices(pending.map((notice) => ({ ...notice, requestId: randomId() })))
      } catch (error) {
        this.deps.logger.warn(
          `saving notices failed session=${this.sessionId}: ${errorText(error)}`
        )
      }
    }
    this.closedFlag = true
    this.agentLock.dispose()
    this.unsubscribe()
    this.inputs.closeInputs('closed')
    this.inputs.cancelAll('closed')
    await this.raw.close(BG)
  }

  private assertOpen(): void {
    if (this.closedFlag) throw new SessionClosedError(this.sessionId)
  }

  /** 一次会话调用：关停后拒绝；期间计入进行中（LRU 不关它）并刷新新近度；关停错误统一成 SessionClosedError */
  private async op<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen()
    this.activeOps++
    this.deps.onUse()
    try {
      return await work()
    } catch (error) {
      if (this.closedFlag || isClosedError(error)) throw new SessionClosedError(this.sessionId)
      throw error
    } finally {
      this.activeOps--
      if (this.activeOps === 0 && !this.closedFlag) this.deps.onSettled?.()
    }
  }
}
