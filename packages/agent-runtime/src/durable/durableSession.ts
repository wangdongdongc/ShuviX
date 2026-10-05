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
 *  - **身份**（P2-01，`agentDirectory.ts`）：`agentIdentity(对话)` 同步认人 —— 派生 agent 的对话按它
 *    `AgentStateDoc` 里的记录，其余对话都认成根（随锁现取，未锁 = undefined）。缓存由提交发布与打开时
 *    对每个任务拥有的对话的扫描喂养。
 *  - **辅助工作**（P2-01，`dispatch: 'hook'` 及其名下的对话）：宿主派发的 hook agent（起标题、权限审查）
 *    **从不续跑** —— 打开时把它们活着的任务逐个打上中止标记（`harness.abortTask`，只提交标记、不开启
 *    调度器），下一次任何开启调度器的调用让它们以 aborted 收场。它们不算中断、不进运行状态镜像（侧栏
 *    不会因为在起标题而显示忙）；但在跑时照样挡着 LRU（`evictable` = 什么都没在跑），跑完时宿主据此
 *    再修剪一次（PIN-07）。宿主派发的后台锚任务（`shuvix.spawn.anchor`，P2-08）在根里，但它拥有的对话全是
 *    辅助工作时同样不算（PIN-02）；拥有 `tool` 子对话的后台任务与拥有审查员的工具任务照样算。
 *  - **派生 agent**（P2-03，`spawn.ts`）：`agents` 是这条会话的派生 agent 协调器 —— 子 agent 是派发工具任务
 *    拥有的子对话。打开时（锁重建之后、任何续跑之前）有活任务的非辅助子对话按记录重建；`destroyAgent`
 *    对任何非辅助的 run（含面板追问、只剩被中断的子 agent）都先中止，并卸掉所有 `shuvix.agent.*`；压缩
 *    余量取锁定模型与在跑的派生 agent 模型里最小的窗口（Q-P2-08）。
 *  - **子会话原语**（P2-09）：
 *    - `submitUser` 带一个当前对话里已有的 requestId = **重新挂上**那条输入：已落定的直接读结果（纯读，
 *      不建 agent、不开启调度器）；没落定的跳过忙拒绝、中断策略、发送前送达、日期通知、显示侧车与受理
 *      回调，被中断时按「继续」的准备（建 agent、重开询问、`place` 送达推迟通知、`resume()`）续上但不等
 *      空闲，然后等那条输入落定；排着队却没有 run 能带走它 → 立刻 `{ code: 'queued' }`，绝不挂住。同一
 *      requestId 是一条写入 → `{ error }`。
 *    - `requestState` / `lastAnswer`：当前对话上的只读查询（从不开启调度器）；`resumeInterrupted`：不等
 *      空闲的「继续」，没被中断就什么都不做。
 *    - 通知的 requestId：同一 requestId 在当前对话里已有提交 / 在待送达里 / 在合并窗口里 → 不再送；
 *      合并的一轮单条沿用自己的 id，多条用 `notices:<排序去重的 id>`；各种退回写入 / 关停保存都保留
 *      每条通知自己的 id。送达推迟通知时同一 requestId 已有提交（不论类型）就跳过 —— 类型不符绝不让
 *      继续 / 中止 / 送达抛出。
 *    - driven-run 标记（`SessionState.driven`）：被父会话驱动的发送受理之后写下；那条输入落定时
 *      （进程内由提交发布察觉，打开时由扫描察觉、`open()` 落定之后再报）调宿主的 `onDrivenSettled`，
 *      每个进程至多一次，回调成功后清掉标记。
 */
import { copyJson } from '@earendil-works/chord'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  ConversationBusy,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  UserEntry,
  type CommitPublication,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type Harness,
  type JsonObject,
  type Submission,
  type SubmissionId,
  type SubmissionRecord,
  type TaskId,
  type UserInput
} from '@earendil-works/pi-durable'
import type { HarnessSettings, Registry, ToolRegistration } from '@earendil-works/pi-durable'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import type { PromptVars, PromptVarsCtx } from '../agentProfile/promptVars'
import type { RuntimeEventSink, RuntimeLogger } from '../types'
import { AgentDirectory } from './agentDirectory'
import { rootAgentIdentity, type AgentIdentity } from './agentRecord'
import { backgroundContext as BG, errorText, isClosedError } from './context'
import {
  AgentStateDoc,
  DisplayDoc,
  SessionStateDoc,
  noticeEntryDraft,
  type DeferredNotice,
  type DrivenRun,
  type SessionState
} from './docs'
import { PendingInputRequests } from './inputRequests'
import {
  AGENT_EXTENSION_PREFIX,
  AgentCreationError,
  AgentLock,
  type CreateAgentOptions,
  type LockRecord
} from './lock'
import { maybeAnnounceDate } from './prompt/dateNotice'
import { renderSystemPrompt, replaySections, type PromptExtensions } from './prompt/sections'
import type { AgentConfig, InterruptedSendPolicy, ModelCatalog, RunState, ToolHost } from './seams'
import { SpawnCoordinatorImpl, type SpawnCoordinator } from './spawn'
import type { LockModel, ModelSelection } from '../models/lockModel'

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
  /** 重新挂上的那条输入还排在收件箱里、却没有 run 会带走它（只有下一次发送会放下它，P2-09 PIN-04） */
  | 'queued'

/** 发送 / 继续的结果：成功 = `{}`；失败 = `{ error, code? }`（code 缺省 = 未知原因） */
export interface SubmitResult {
  error?: string
  code?: SubmitErrorCode
}

/** steer / followUp 的结果：受理即返回（不等 run 结束），附 submission id 供需要时等待 */
export interface AdmitResult extends SubmitResult {
  submissionId?: SubmissionId
}

/** 被父会话驱动的发送（P2-09，子会话）：受理之后写下 driven-run 标记 */
export interface DrivenSendOptions {
  /** 驱动它的父会话 id */
  parentId: string
  /** 后台提示（父会话不在前台等它） */
  background: boolean
}

export interface UserSendOptions {
  /**
   * 幂等键（作用域 = 当前对话）：当前对话里已有这条输入时**重新挂上**它（P2-09）—— 已落定直接返回
   * 结果；没落定就等它（被中断先续上）。不会再落一条、再起一轮。
   */
  requestId?: string
  /** 被父会话驱动（P2-09）：必须同时给 requestId；受理后（`onAdmitted` 之前）写 driven-run 标记 */
  driven?: DrivenSendOptions
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

/** `notify` 的选项（P2-09：requestId 去重） */
export interface NotifyOptions {
  /** 通知种类；缺省 `background` */
  kind?: string
  /**
   * 幂等键：当前对话里已有这个 requestId 的提交（任何类型）、或它还在待送达 / 合并窗口里 → 不再送。
   * 缺省自动生成。
   */
  requestId?: string
}

/** 某个 requestId 在当前对话里的状态（P2-09）：没有 / 未落定（排队或在跑）/ 已落定 */
export type RequestState = 'none' | 'pending' | 'settled'

/** 某个任务的存活情况（P2-10，`taskLiveness`） */
export interface TaskLiveness {
  /** 还没终结（pending / running / waiting / completing） */
  live: boolean
  /** 带着中止标记（终结之后也保留：被中止收场的任务据此认得出来） */
  abortRequested: boolean
}

/** 当前对话这一轮的回答（P2-09）：文本部分拼起来；模型报错时是错误文案并带 `isError` */
export interface LastAnswer {
  text: string
  isError?: true
}

/** 子会话被驱动的那一轮落定了（P2-09，`SessionHostDeps.onDrivenSettled` 的参数） */
export interface DrivenSettledEvent {
  /** 子会话 id */
  sessionId: string
  parentId: string
  requestId: string
  background: boolean
  conversationId: ConversationId
  submissionId: SubmissionId
  /** 父会话那条完成通知的 requestId：`subsession-done:<子会话 id>:<submission id>` */
  noticeRequestId: string
  /** 与 `submitUser` 同口径的结果 */
  result: SubmitResult
  record: { status: 'done' | 'unanswered'; reason?: string }
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
  /** 存储里有 run 但调度器停着（上个进程中途退出）；辅助工作（hook agent）不算 */
  isInterrupted(): boolean
  /**
   * 在这个对话上发起调用的 agent 的身份（同步，从不开启调度器）：派生 agent 的对话 → 它的派生身份
   * （`callerId` = agentId；记录写坏了也绝不认成根）；其余对话（锁所在的对话、fork、旁支、不认识的 id）
   * → 根的身份（随锁现取；未锁 = undefined）。句柄已关 → undefined。
   */
  agentIdentity(conversationId: number): AgentIdentity | undefined
  /** 继续被中断的工作，等当前对话空闲；空闲且未中断时立刻返回 */
  continue(): Promise<SubmitResult>
  /**
   * 不等空闲的「继续」（P2-09）：被中断时建 agent、重开询问、放下推迟的通知、开启调度器就返回；
   * 没被中断 = 什么都不做、返回 `{}`。和 `continue()` 一样开启的是整个调度器。
   */
  resumeInterrupted(): Promise<SubmitResult>
  /**
   * 某个 requestId 在当前对话里的状态（P2-09；不分输入 / 写入，只读，从不开启调度器）。
   * 句柄已关 → 以 `SessionClosedError` 拒绝。
   */
  requestState(requestId: string): Promise<RequestState>
  /**
   * 当前对话这一轮的回答（P2-09；只读）：从新到旧找，先碰到 `pi.user` = 这一轮还没有回答
   * （undefined），先碰到 `pi.assistant` = 它（文本部分拼接；`stopReason: 'error'` → 错误文案 +
   * `isError`）。压缩不会藏起它，也从不返回摘要。句柄已关 → 以 `SessionClosedError` 拒绝。
   */
  lastAnswer(): Promise<LastAnswer | undefined>
  /**
   * 此刻的 driven-run 标记（P2-10；同步，从不开启调度器）：被父会话驱动、还没报过落定的那一轮。
   * 没有 / 句柄已关 → undefined。宿主据此认出「被中断的这件事是谁驱动的」（父会话中止的级联、停止）。
   */
  readonly drivenRun: DrivenRun | undefined
  /**
   * 某个任务的存活情况（P2-10；只读，从不开启调度器）：`live` = 还没终结；`abortRequested` = 带着中止
   * 标记（终结了也保留）。不存在 → undefined。句柄已关 → 以 `SessionClosedError` 拒绝。
   */
  taskLiveness(taskId: number): Promise<TaskLiveness | undefined>
  /** 发送用户输入并等这一轮落定（R3：结果对象，从不抛出）；已有的 requestId = 重新挂上（P2-09） */
  submitUser(content: UserInput, options?: UserSendOptions): Promise<SubmitResult>
  /** 运行中插话（空闲时起一轮，R4） */
  steer(content: UserInput, options?: { requestId?: string }): Promise<AdmitResult>
  /** 本轮结束后接着说（空闲时起一轮） */
  followUp(content: UserInput, options?: { requestId?: string }): Promise<AdmitResult>
  /** 写一条系统通知（`shuvix.notice`），必要时推迟（R1 / Q3） */
  writeNotice(notice: NoticeInput): Promise<NoticeResult>
  /** 送达后台完成通知（R13 的路由：steer / 自动续跑 / 写入 / 推迟；requestId 去重，P2-09） */
  notify(text: string, options?: NotifyOptions): Promise<void>
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
   * 一个对话上 agent 的运行时快照（P3-06；纯读：不写、不开启调度器、不调任何创建 seam、不连 MCP）：
   *  - `systemPrompt`：现渲染的段落（PIN-07）—— 与**下一次请求**逐字节相同；一段抛错保留它已显示的文本、
   *    记一条警告，从不拒绝；
   *  - `tools`：对话的 agent 此刻提供的工具，按请求次序（锁的 K6 次序），带 label 与参数名；
   *  - `model`：按注册表现查；查不到（provider 被删）→ 只有 provider / id 的兜底（PIN-05），从不抛；
   *  - `thinkingLevel`：活的（`setThinkingLevel` 之后立刻可见）；
   *  - `messageCount`：上下文里非 system 的消息数（PIN-04）；
   *  - `isStreaming`：这个对话有 run 且调度器在跑（被中断 = false）。
   * 锁所在的对话与派生 agent（含宿主派发的 hook agent）的对话有快照；没锁的根、不认识的对话 → undefined
   * （PIN-02）。句柄已关 → 以 `SessionClosedError` 拒绝。
   */
  agentInfo(conversationId: number): Promise<AgentRuntimeInfo | undefined>
  /**
   * 派生 agent 协调器（P2-03）：派发工具经它建子对话、等回答；面板的追问 / 软停止 / 销毁也走它。
   * 不发 ChatEvent（那是 P2-05 的路由）。
   */
  readonly agents: SpawnCoordinator
  /**
   * 创建 agent（上锁）。已锁返回现有记录、不调任何 seam；并发调用合流成一次。模型被拒 / 被取消 /
   * 附加工具 → 抛 `AgentCreationError`；其余失败原样抛出。从不开启调度器。
   */
  createAgent(options?: CreateAgentOptions): Promise<LockRecord>
  /**
   * 销毁 agent（解锁）：任何非辅助的 run 在跑 / 被中断（含面板追问的子 agent）先中止；卸掉所有
   * `shuvix.agent.*`（派生 agent 的记录留着，按需重建）。没锁 = 无操作
   */
  destroyAgent(): Promise<void>
  /**
   * 这个 Harness 实际在用的 settings（同步 getter；压缩余量按锁定模型与在跑的派生 agent 模型里最小的
   * 窗口算，K14 / Q-P2-08）
   */
  readonly effectiveSettings: HarnessSettings
}

/** 关停原因：destroy = 删除会话（合并窗口里的通知随之丢弃），其余照常保存待送达通知 */
export type SessionCloseReason = 'remove' | 'invalidate' | 'destroy'

// ─────────────────────────── 结算映射（R3，纯函数） ───────────────────────────

/** `settlementResult` 在 model_error 没有细节时的文案 */
const MODEL_ERROR_FALLBACK = 'The model request failed'

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
      return { error: detail ?? MODEL_ERROR_FALLBACK, code: 'model_error' }
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

function isSettled(record: SubmissionRecord): boolean {
  return record.status === 'done' || record.status === 'unanswered'
}

/** 合并的一轮通知的 requestId（PIN-10）：单条沿用自己的；多条 = `notices:` + 排序去重后以 `,` 连接 */
function combinedNoticeId(notices: readonly PendingNotice[]): string {
  const ids = [...new Set(notices.map((notice) => notice.requestId))].sort()
  return ids.length === 1 ? ids[0]! : `notices:${ids.join(',')}`
}

/**
 * 模型错误文案，与 `submitUser` 的 `error` 逐字相同（P2-09 PIN-07，P2-10 的裁定）：durable 把
 * `errorMessage ?? 'Model response ended with stop reason …'` 记作运行细节，`settlementResult` 再把空细节
 * 换成兜底文案 —— 所以缺省时按停止原因说，空串时是兜底文案。
 */
function modelErrorText(message: AssistantMessage): string {
  if (message.errorMessage === undefined) {
    return `Model response ended with stop reason ${message.stopReason}`
  }
  return message.errorMessage || MODEL_ERROR_FALLBACK
}

/** 一条 `pi.assistant` 条目的回答（PIN-07）：文本部分拼接；报错 → 错误文案 + isError */
function answerOf(message: AssistantMessage | undefined): LastAnswer {
  if (message === undefined) return { text: '' }
  if (message.stopReason === 'error') return { text: modelErrorText(message), isError: true }
  let text = ''
  for (const part of message.content) if (part.type === 'text') text += part.text
  return { text }
}

function liveTaskOf(record: {
  readonly conversationId: ConversationId
  readonly kind: string
  readonly abortRequested: boolean
  readonly background: boolean
}): LiveTask {
  return {
    conversationId: record.conversationId,
    kind: record.kind,
    abortRequested: record.abortRequested,
    background: record.background
  }
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
  /**
   * 进行中的调用全部结束，或最后一件在跑的工作结束（辅助工作跑完时运行状态不变，PIN-07）—— 它可能
   * 刚变得可回收，宿主据此修剪
   */
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
  /** 被驱动的那一轮落定（P2-09）；缺省 = 不察觉（标记留着） */
  onDrivenSettled?: (event: DrivenSettledEvent) => void | Promise<void>
  /** 派生 agent 档案的 `shuvix-model` → 模型选择（P2-03；缺省 = 不支持档案模型，回落调用方的模型） */
  resolveProfileModel?: (
    spec: string
  ) => ModelSelection | null | undefined | Promise<ModelSelection | null | undefined>
  /** 派生层级上限（缺省 `MAX_AGENT_DEPTH`） */
  maxAgentDepth?: number
  /**
   * 这条 submission 的落定在本进程里报过没有：第一次返回 true 并记下（宿主按进程记，LRU 关了再开
   * 也不重报）。缺省 = 只在这个实例里记。
   */
  claimDrivenEmission?: (submissionId: SubmissionId) => boolean
}

interface LiveTask {
  readonly conversationId: ConversationId
  readonly kind: string
  readonly abortRequested: boolean
  /** 对话拥有的后台任务（锚、后台压缩） */
  readonly background: boolean
}

interface PendingNotice {
  readonly text: string
  readonly kind: string
  /** 每条都有（缺省时进窗口那一刻生成）：退回写入 / 关停保存都沿用它（PIN-11） */
  readonly requestId: string
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
  /** 每个对话上的 agent 是谁、哪些对话是辅助工作（P2-01） */
  private readonly directory: AgentDirectory
  /** 根身份的缓存：跟着锁记录对象走（锁一变就重算） */
  private rootIdentity: { lock: LockRecord; identity: AgentIdentity } | undefined
  /** 上次重算时有没有东西在跑（含辅助工作；PIN-07 的跑完检测） */
  private wasRunning = false
  /** 打开扫描期间被提交发布摸过的 AgentStateDoc（扫描读到的旧值不能盖掉它们） */
  private scanTouched: Set<ConversationId> | undefined
  /** 打开途中：状态只在打开完成时静默设定一次（打开时的中止标记等提交不触发状态通知） */
  private initializing = true
  /** 此刻的 driven-run 标记（P2-09）：由打开时的读取与 SessionStateDoc 的提交发布同步维护 */
  private drivenMarker: DrivenRun | undefined
  /** 没有宿主记账时，本实例报过的 driven 落定 */
  private readonly drivenClaimed = new Set<SubmissionId>()
  /** 派生 agent 协调器（P2-03） */
  private readonly spawner: SpawnCoordinatorImpl

  private constructor(private readonly deps: DurableSessionDeps) {
    this.sessionId = deps.sessionId
    this.raw = deps.harness
    this.harness = observeResumes(deps.harness, () => this.markResumed())
    this.inputs = new PendingInputRequests(deps.sessionId, deps.eventSink)
    this.directory = new AgentDirectory({ sessionId: deps.sessionId, logger: deps.logger })
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
    this.spawner = new SpawnCoordinatorImpl({
      sessionId: deps.sessionId,
      harness: this.harness,
      raw: deps.harness,
      registry: deps.registry,
      toolHost: deps.toolHost,
      modelCatalog: deps.modelCatalog,
      promptExtensions: deps.promptExtensions,
      promptVars: deps.promptVars,
      ...(deps.resolveProfileModel === undefined
        ? {}
        : { resolveProfileModel: deps.resolveProfileModel }),
      ...(deps.maxAgentDepth === undefined ? {} : { maxAgentDepth: deps.maxAgentDepth }),
      logger: deps.logger,
      now: deps.now,
      directory: this.directory,
      rootLock: () => this.agentLock.current,
      liveTasksOf: (conversationId) => this.liveTasksOf(conversationId),
      liveConversationIds: () => [...new Set([...this.live.values()].map((t) => t.conversationId))],
      isInterrupted: () => this.isInterrupted(),
      isClosed: () => this.closedFlag,
      currentConversation: () => this.currentConversation(),
      stopConversation: (conversationId) => this.stopConversation(conversationId),
      reopenInputs: () => this.reopenInputs(),
      op: (work) => this.op(work)
    })
  }

  get agents(): SpawnCoordinator {
    return this.spawner
  }

  /** 接管一个刚打开的 Harness：订阅提交、装载活着的任务、解析当前对话 */
  static async attach(deps: DurableSessionDeps): Promise<DurableSessionImpl> {
    const session = new DurableSessionImpl(deps)
    await session.init()
    return session
  }

  private async init(): Promise<void> {
    this.unsubscribe = this.raw.subscribeCommits((publication) => this.observe(publication))
    this.scanTouched = new Set()
    // 在串行线上扫一遍活着的任务与全部对话，并在回调末尾**同步**装载：此前的发布被这次扫描覆盖，
    // 此后的发布来自更晚的提交、叠加在它上面 —— 两者之间没有缝。（只读提交不产生发布。）
    const taskOwned = await this.raw.commit(async (tx) => {
      const records: {
        id: TaskId
        conversationId: ConversationId
        kind: string
        abortRequested: boolean
        background: boolean
      }[] = []
      for (const status of LIVE_TASK_STATUSES) {
        let cursor: Parameters<typeof tx.scanTasks>[2]
        do {
          const page = await tx.scanTasks({ status }, SCAN_PAGE_SIZE, cursor)
          for (const record of page.items) records.push(record)
          cursor = page.next
        } while (cursor !== undefined)
      }
      const conversations: ConversationRecord[] = []
      let next: Parameters<typeof tx.scanConversations>[2]
      do {
        const page = await tx.scanConversations({}, SCAN_PAGE_SIZE, next)
        for (const record of page.items) conversations.push(record)
        next = page.next
      } while (next !== undefined)
      this.live.clear()
      for (const record of records) this.live.set(record.id, liveTaskOf(record))
      for (const record of conversations) this.directory.observeConversation(record)
      return conversations.filter((record) => record.owner !== undefined).map(({ id }) => id)
    }, BG)
    // 身份与辅助分类：每个任务拥有的对话（PIN-03）。扫描之后被发布摸过的以发布为准
    for (const conversationId of taskOwned) {
      const value = await this.raw.snapshot(AgentStateDoc, conversationId, BG)
      if (this.scanTouched.has(conversationId)) continue
      this.directory.observeAgentState(conversationId, value as JsonObject | undefined)
    }
    this.scanTouched = undefined
    const pointer = await this.raw.snapshot(SessionStateDoc, BG)
    this.drivenMarker = pointer?.driven
    await this.currentConversation()
    // 在任何续跑 / 发送之前按锁重建工具（打开从不续跑，所以在这里重建是安全的），再对一次镜像（K11）
    await this.agentLock.restore()
    // 派生 agent：有活任务的非辅助子对话按记录重建（失败 → 打中止标记，PIN-05）；同样在任何续跑之前
    await this.spawner.restoreAtOpen()
    // 辅助工作从不续跑：活着的任务打上中止标记（只提交标记，不开启调度器）
    await this.markAuxiliaryWork()
    // 初始状态静默设定：宿主在打开完成时统一报一次（PIN-R），这里再排一次通知就会报两遍
    this.state = this.computeState()
    this.wasRunning = this.running
    this.initializing = false
    this.agentLock.reconcileMirror()
    await this.scanDrivenAtOpen()
  }

  /**
   * 打开时的扫描（PIN-13）：标记指着的那条输入已经落定（上个进程没接 seam、回调失败、或崩在清标记
   * 之前）→ 在 `open()` 落定之后再报（宿主那次打开时的运行状态先报）。只读，从不续跑。还没落定的
   * 由提交发布在它落定时察觉。
   */
  private async scanDrivenAtOpen(): Promise<void> {
    const marker = this.drivenMarker
    if (marker === undefined || this.deps.onDrivenSettled === undefined) return
    const record = await this.findRequest(marker.conversationId, marker.requestId)
    if (record === undefined || record.type !== 'input' || !isSettled(record)) return
    setTimeout(() => {
      if (!this.closedFlag) this.scheduleDriven(marker, record)
    }, 0)
  }

  /**
   * 打开时：辅助对话（hook agent 及其名下）里每个活着、还没打标记的任务，逐个 `abortTask`。
   * 只提交中止标记 —— 不开启调度器（会话照样停着），下一次开启调度器的调用让它们走中止流程收场。
   * 失败只记警告、不挡打开（PIN-14）；分类照旧（它们照样不算中断）。
   */
  private async markAuxiliaryWork(): Promise<void> {
    const targets: TaskId[] = []
    for (const [id, task] of this.live) {
      if (!task.abortRequested && this.directory.isAuxiliary(task.conversationId)) targets.push(id)
    }
    for (const id of targets) {
      try {
        await this.raw.abortTask(id, BG)
      } catch (error) {
        if (this.closedFlag || isClosedError(error)) throw error
        this.deps.logger.warn(
          `session ${this.sessionId}: marking auxiliary task ${id} aborted failed: ${errorText(error)}`
        )
      }
    }
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

  agentIdentity(conversationId: number): AgentIdentity | undefined {
    if (this.closedFlag) return undefined
    const spawned = this.directory.identity(conversationId as ConversationId)
    if (spawned !== undefined) return spawned
    const lock = this.agentLock.current
    if (lock === undefined) return undefined
    if (this.rootIdentity?.lock !== lock) {
      this.rootIdentity = { lock, identity: rootAgentIdentity(lock) }
    }
    return this.rootIdentity.identity
  }

  /**
   * LRU 能不能关它：什么都没在跑（辅助工作在跑也不行）、没有挂起的询问、没有进行中的调用、没有
   * 待合并的通知。被中断的会话（调度器停着）可以关。
   */
  get evictable(): boolean {
    return (
      !this.closedFlag &&
      !this.running &&
      this.inputs.count === 0 &&
      this.activeOps === 0 &&
      this.pendingNotices.length === 0
    )
  }

  /** 有东西在跑：调度器开着且有活着的任务（含辅助工作、后台压缩） */
  private get running(): boolean {
    return this.schedulerRunning && this.live.size > 0
  }

  /** 有 run：指定对话里的；不指定 = 任何非辅助对话里的 */
  private hasRun(conversationId: ConversationId | undefined): boolean {
    for (const task of this.live.values()) {
      if (task.kind !== GENERATION_TASK_KIND) continue
      if (conversationId === undefined) {
        if (!this.directory.isAuxiliary(task.conversationId)) return true
      } else if (task.conversationId === conversationId) return true
    }
    return false
  }

  /**
   * 一个活任务算不算辅助工作：它在辅助对话里，或者它是后台任务、且它拥有的对话全是辅助工作（宿主派发的
   * 锚，P2-08 PIN-02）。拥有审查员的工具任务不是后台任务，从不排除。
   */
  private isAuxiliaryTask(id: TaskId, task: LiveTask): boolean {
    if (this.directory.isAuxiliary(task.conversationId)) return true
    return task.background && this.directory.ownsOnlyAuxiliary(id)
  }

  /** 有活着的非辅助任务 */
  private hasPrimaryWork(): boolean {
    for (const [id, task] of this.live) {
      if (!this.isAuxiliaryTask(id, task)) return true
    }
    return false
  }

  /** 运行状态（R2），辅助工作不算：它在跑不算忙，被打了标记停着也不算中断 */
  private computeState(): RunState {
    if (!this.hasPrimaryWork()) return 'idle'
    if (this.schedulerRunning) return 'busy'
    return this.hasRun(undefined) ? 'interrupted' : 'idle'
  }

  /**
   * 状态即时更新（同步读取永远是真值），通知推迟到微任务（提交监听里不许回调宿主）。最后一件在跑的
   * 工作结束时也通知宿主（PIN-07）：辅助工作跑完不改运行状态，没有忙→闲可以触发修剪。
   */
  private recompute(): void {
    if (this.initializing) return
    const running = this.running
    if (this.wasRunning && !running) {
      queueMicrotask(() => {
        if (!this.closedFlag) this.deps.onSettled?.()
      })
    }
    this.wasRunning = running
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

  /**
   * 提交发布监听（同步，在 Session 串行线上）：维护活着的任务、当前对话指针、锁缓存，以及 agent 目录
   * （身份与辅助分类）。一次发布里的变化次序不定，所以分类变化与任务变化都只在末尾统一重算一次。
   */
  private observe(publication: CommitPublication): void {
    if (this.closedFlag) return
    let changed = false
    let forward: CommitPublication['changes'][number][] | undefined
    for (const change of publication.changes) {
      if (change.type === 'entry' || change.type === 'task') (forward ??= []).push(change)
      if (change.type === 'task') {
        const record = change.value
        if (record.state.status === 'terminal') {
          if (this.live.delete(record.id)) changed = true
          continue
        }
        this.live.set(record.id, liveTaskOf(record))
        // 只有开启了的调度器会把任务置为 running（打开时残留的 running 会被改回 pending）
        if (record.state.status === 'running') this.schedulerRunning = true
        changed = true
      } else if (change.type === 'conversation') {
        this.directory.observeConversation(change.value)
        changed = true
      } else if (change.type === 'submission') {
        // 被驱动的那条输入落定了（P2-09）：回调放到监听之外
        const record = change.value
        const marker = this.drivenMarker
        if (
          marker !== undefined &&
          record.type === 'input' &&
          record.requestId === marker.requestId &&
          record.conversationId === marker.conversationId &&
          isSettled(record)
        ) {
          this.scheduleDriven(marker, record)
        }
      } else if (
        change.type === 'document' &&
        change.record.kind === AgentStateDoc.definition.kind &&
        change.conversationId !== undefined
      ) {
        // 身份 / 辅助分类跟着存储变（同步）。`document.copy`（fork 的 asOf 副本）不带值，不在这里处理 ——
        // fork 派生 agent 的对话不是产品路径（PIN-11），fork 出来的对话按根认人
        this.directory.observeAgentState(change.conversationId, change.value)
        this.scanTouched?.add(change.conversationId)
        changed = true
      } else if (
        change.type === 'document' &&
        change.record.kind === SessionStateDoc.definition.kind &&
        change.value !== null
      ) {
        // 锁缓存：谁写了 SessionStateDoc.lock 都跟着变（同步，读取永远是真值）
        this.agentLock.observe((change.value as SessionState).lock)
        this.drivenMarker = (change.value as SessionState).driven
        const pointer = (change.value as SessionState).currentConversation ?? ROOT_CONVERSATION_ID
        if (pointer !== this.current) {
          this.current = pointer
          // 指针可能指向不存在的对话（R11）：校验是读操作，不能在提交监听里做
          queueMicrotask(() => void this.currentConversation().catch(() => undefined))
        }
      }
    }
    // 派生 agent 的捕获观察（P2-03）：放在末尾，目录已经按这次发布更新过
    if (forward !== undefined) this.spawner.observe(forward)
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
        if (options.driven !== undefined && options.requestId === undefined) {
          return { error: 'A driven send needs a requestId' }
        }
        // 当前对话里已有这条输入：重新挂上（P2-09），下面的发送规矩一概不碰
        if (options.requestId !== undefined) {
          const conversation = await this.currentConversation()
          const existing = await this.findRequest(conversation.id, options.requestId)
          if (existing !== undefined) return await this.reattach(conversation, existing, options)
        }
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
        // driven-run 标记在受理之后、受理回调之前（PIN-12）：被拒的发送从不留下标记
        if (options.driven !== undefined) {
          await this.armDriven(conversation.id, requestId!, options.driven, submission.id)
        }
        this.admitted(options.onAdmitted)
        if (joining.length > 0) await this.steerNotices(conversation, joining)
        return settlementResult(await submission.wait(BG))
      })
    } catch (error) {
      return resultOfError(error)
    }
  }

  /**
   * 重新挂上当前对话里已有的那条提交（P2-09，PIN-01..04）。不重置「显式喊停」、不带走合并窗口里的
   * 通知、不调受理回调、不写显示侧车、不发日期通知、不走中断策略。
   *  - 是一条写入 → `{ error }`（没有 code）；
   *  - 已落定 → 它的结果（纯读：不建 agent、不开启调度器）；
   *  - 排着队却没有 run（也没被中断）→ 立刻 `{ code: 'queued' }`：只有下一次发送会放下它，等就会挂住；
   *  - 否则（被驱动时先补上缺的标记）被中断就按「继续」的准备续上（不等空闲），然后等它落定。
   */
  private async reattach(
    conversation: Conversation,
    record: SubmissionRecord,
    options: UserSendOptions
  ): Promise<SubmitResult> {
    const requestId = options.requestId!
    if (record.type !== 'input') {
      return {
        error: `Request ${requestId} already identifies a submission of type ${record.type}`
      }
    }
    if (isSettled(record)) return settlementResult(record)
    const interrupted = this.isInterrupted()
    if (!interrupted && record.status === 'queued') {
      const live = await this.harness.snapshot(LiveDoc, conversation.id, BG)
      if (live?.run === undefined) {
        return {
          error: `Request ${requestId} is still queued; it will be placed with the next message`,
          code: 'queued'
        }
      }
    }
    // 受理与写标记之间崩溃过：父会话安全重跑时在这里补上（PIN-12）
    const marker = this.drivenMarker
    if (
      options.driven !== undefined &&
      (marker?.requestId !== requestId || marker.conversationId !== conversation.id)
    ) {
      await this.armDriven(conversation.id, requestId, options.driven, record.id)
    }
    if (interrupted) {
      const refused = await this.resumeWork(conversation)
      if (refused !== undefined) return refused
    }
    const submission = await this.harness.submission(record.id, BG)
    if (submission === undefined) return { error: `Submission ${record.id} does not exist` }
    return settlementResult(await submission.wait(BG))
  }

  /** 某对话里带这个 requestId 的提交（只读提交，不产生发布） */
  private findRequest(
    conversationId: ConversationId,
    requestId: string
  ): Promise<SubmissionRecord | undefined> {
    return this.raw.commit((tx) => tx.submissionByRequest(conversationId, requestId), BG)
  }

  // ─── driven-run 标记（P2-09） ───────────────────

  /**
   * 写 driven-run 标记（它自己的一个提交；后写的替换先写的）。同一提交里读那条输入：已经落定（应答
   * 比标记还快）就当场安排报告 —— 否则由提交发布在它落定时察觉。关停照常抛出；其余失败只记警告
   * （父会话的安全重跑会再补，PIN-12）。
   */
  private async armDriven(
    conversationId: ConversationId,
    requestId: string,
    driven: DrivenSendOptions,
    submissionId: SubmissionId
  ): Promise<void> {
    const marker: DrivenRun = {
      requestId,
      parentId: driven.parentId,
      background: driven.background,
      conversationId
    }
    let settled: SubmissionRecord | undefined
    try {
      settled = await this.raw.commit(async (tx) => {
        // 表读先于本提交的第一次写
        const record = await tx.submissionByRequest(conversationId, requestId)
        const state = await tx.doc(SessionStateDoc)
        state.driven = { ...marker }
        return record?.id === submissionId && isSettled(record) ? record : undefined
      }, BG)
    } catch (error) {
      if (this.closedFlag || isClosedError(error)) throw error
      this.deps.logger.warn(
        `driven marker failed session=${this.sessionId} request=${requestId}: ${errorText(error)}`
      )
      return
    }
    if (settled !== undefined) this.scheduleDriven(marker, settled)
  }

  /**
   * 安排一次 `onDrivenSettled`（PIN-13）：每个进程至多一次（宿主记账），回调在提交监听之外调用。
   * 没接 seam = 什么都不做（标记留着，等接了它的进程打开时再报）。
   */
  private scheduleDriven(marker: DrivenRun, record: SubmissionRecord): void {
    const callback = this.deps.onDrivenSettled
    if (callback === undefined || this.closedFlag) return
    const claim = this.deps.claimDrivenEmission
    if (claim !== undefined) {
      if (!claim(record.id)) return
    } else {
      if (this.drivenClaimed.has(record.id)) return
      this.drivenClaimed.add(record.id)
    }
    const reason = (record as { readonly reason?: string }).reason
    const event: DrivenSettledEvent = {
      sessionId: this.sessionId,
      parentId: marker.parentId,
      requestId: marker.requestId,
      background: marker.background,
      conversationId: marker.conversationId,
      submissionId: record.id,
      noticeRequestId: `subsession-done:${this.sessionId}:${record.id}`,
      result: settlementResult(record),
      record: {
        status: record.status as 'done' | 'unanswered',
        ...(reason === undefined ? {} : { reason })
      }
    }
    queueMicrotask(() => void this.deliverDriven(event, callback))
  }

  /**
   * 调宿主的回调；成功后清掉标记（只在它仍指着这条 requestId 时）。回调抛错 / 拒绝 → 记警告、留着
   * 标记（下次打开再报）。期间计入进行中，LRU 不关它。
   */
  private async deliverDriven(
    event: DrivenSettledEvent,
    callback: (event: DrivenSettledEvent) => void | Promise<void>
  ): Promise<void> {
    this.activeOps++
    try {
      try {
        await callback(event)
      } catch (error) {
        this.deps.logger.warn(
          `onDrivenSettled failed session=${this.sessionId} request=${event.requestId}: ${errorText(error)}`
        )
        return
      }
      try {
        await this.raw.commit(async (tx) => {
          const state = await tx.doc(SessionStateDoc)
          const driven = state.driven
          if (
            driven !== undefined &&
            driven.requestId === event.requestId &&
            driven.conversationId === event.conversationId
          ) {
            delete state.driven
          }
        }, BG)
      } catch (error) {
        if (this.closedFlag || isClosedError(error)) return
        this.deps.logger.warn(
          `clearing driven marker failed session=${this.sessionId}: ${errorText(error)}`
        )
      }
    } finally {
      this.activeOps--
      if (this.activeOps === 0 && !this.closedFlag) this.deps.onSettled?.()
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
        const conversation = await this.currentConversation()
        const refused = await this.resumeWork(conversation)
        if (refused !== undefined) return refused
        await conversation.waitForIdle(BG)
        return {}
      })
    } catch (error) {
      return resultOfError(error)
    }
  }

  async resumeInterrupted(): Promise<SubmitResult> {
    try {
      return await this.op(async () => {
        // 没被中断：严格的无操作（不建 agent、不重开询问、不送达、不开启调度器，PIN-06）
        if (!this.isInterrupted()) return {}
        return (await this.resumeWork(await this.currentConversation())) ?? {}
      })
    } catch (error) {
      return resultOfError(error)
    }
  }

  /**
   * 「继续」的准备（continue / resumeInterrupted / 重新挂上被中断的输入共用，PIN-03）：没锁先建 agent
   * （被拒就交回结果）、重开询问、放下推迟的通知（被中断的 run 还在：进收件箱，在它的下一个边界
   * 落下）、开启调度器。不等空闲。
   */
  private async resumeWork(conversation: Conversation): Promise<SubmitResult | undefined> {
    const refused = await this.ensureAgent()
    if (refused !== undefined) return refused
    this.reopenInputs()
    await this.flushDeferred(conversation, 'place')
    this.harness.resume()
    return undefined
  }

  // ─── 只读查询（P2-09） ─────────────────────────

  async requestState(requestId: string): Promise<RequestState> {
    return this.op(async () => {
      const conversation = await this.currentConversation()
      const record = await this.findRequest(conversation.id, requestId)
      if (record === undefined) return 'none'
      return isSettled(record) ? 'settled' : 'pending'
    })
  }

  async lastAnswer(): Promise<LastAnswer | undefined> {
    return this.op(async () => {
      const conversation = await this.currentConversation()
      // 历史（fork 感知、含被压缩越过的条目），从新到旧；碰到这一轮的提问就停（PIN-07 / PIN-08）
      let cursor: Parameters<Conversation['entries']>[2]
      do {
        const page = await conversation.entries({}, SCAN_PAGE_SIZE, cursor, BG)
        for (const entry of page.items) {
          if (entry.kind === UserEntry.kind) return undefined
          if (entry.kind === AssistantEntry.kind) {
            return answerOf(entry.model?.[0] as AssistantMessage | undefined)
          }
        }
        cursor = page.next
      } while (cursor !== undefined)
      return undefined
    })
  }

  get drivenRun(): DrivenRun | undefined {
    if (this.closedFlag) return undefined
    const marker = this.drivenMarker
    return marker === undefined ? undefined : { ...marker }
  }

  async taskLiveness(taskId: number): Promise<TaskLiveness | undefined> {
    return this.op(async () => {
      const record = await this.raw.getTask(taskId as TaskId, BG)
      if (record === undefined) return undefined
      const status = record.state.status
      return { live: status !== 'terminal', abortRequested: record.abortRequested }
    })
  }

  // ─── 运行时快照（P3-06） ─────────────────────────

  async agentInfo(conversationId: number): Promise<AgentRuntimeInfo | undefined> {
    return this.op(async () => {
      const id = conversationId as ConversationId
      const lock = this.agentLock.current
      const spawned = this.directory.identity(id) !== undefined
      // 有 agent 的对话才有快照：派生 agent（含 hook agent）的对话，或锁所在的那个（PIN-02 / PIN-09）
      if (!spawned && lock?.conversationId !== id) return undefined
      // 原始 Harness 上的读：解析 agent、读上下文都不开启调度器
      const conversation = await this.raw.conversation(id, BG)
      if (conversation === undefined) return undefined
      const agent = await conversation.agent(BG)
      const view = await conversation.context(BG)
      const shown = replaySections(view.messages)
      // 与 durable 准备请求时同样的输入；执行环境不建（ShuviX 的段落不读它，建它可能有副作用）
      const systemPrompt = await renderSystemPrompt(
        agent.sections,
        {
          conversationId: id,
          agent,
          env: undefined,
          shown: Object.fromEntries(shown),
          read: this.raw
        },
        shown,
        (key, error) =>
          this.deps.logger.warn(
            `session ${this.sessionId}: rendering system prompt section "${key}" of conversation ${id} failed; keeping its shown text: ${errorText(error)}`
          ),
        BG
      )
      const ref = agent.model ?? (spawned ? this.directory.record(id)?.model : lock?.model)
      return {
        systemPrompt,
        model: this.modelInfo(ref),
        thinkingLevel: agent.thinkingLevel as ThinkingLevel,
        tools: agent.tools.map((tool) => ({
          name: tool.name,
          label: (tool as { label?: string }).label ?? tool.name,
          description: tool.description,
          parameters: Object.keys(
            (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ??
              {}
          )
        })),
        messageCount: view.messages.filter((message) => message.role !== 'system').length,
        isStreaming: this.schedulerRunning && this.hasRun(id)
      }
    })
  }

  /** 模型快照：注册表现查；查不到 → provider / id 之外全是零值（PIN-05） */
  private modelInfo(
    ref: { provider: string; modelId: string } | undefined
  ): AgentRuntimeInfo['model'] {
    const provider = ref?.provider ?? ''
    const id = ref?.modelId ?? ''
    const model =
      ref === undefined ? undefined : this.deps.modelCatalog.registry.models.getModel(provider, id)
    if (model === undefined) {
      return {
        provider,
        id,
        name: id,
        api: '',
        contextWindow: 0,
        maxTokens: 0,
        reasoning: false,
        input: []
      }
    }
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      input: [...model.input]
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

  async notify(text: string, options: NotifyOptions = {}): Promise<void> {
    if (this.closedFlag) return
    const kind = options.kind ?? 'background'
    try {
      await this.op(async () => {
        // 去重在路由之前（PIN-09）：送过的、待送达的、窗口里的都不再送；竞态由 durable 的去重兜底
        if (options.requestId !== undefined && (await this.noticeKnown(options.requestId))) return
        const notice: PendingNotice = { text, kind, requestId: options.requestId ?? randomId() }
        if (this.isInterrupted()) {
          await this.writeNotice(notice)
          return
        }
        if (this.isBusy()) {
          await this.steerNotices(await this.currentConversation(), [notice])
          return
        }
        if (!this.canAutoResume()) {
          await this.writeNotice(notice)
          return
        }
        // 合并同一时刻到达的多条：三个子会话同一秒跑完不该起三轮
        if (this.pendingNotices.some((pending) => pending.requestId === notice.requestId)) return
        this.pendingNotices.push(notice)
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

  /**
   * 合并窗口到期：起自动续跑那一轮（这期间被中断 / 被关掉开关 / 被喊停就退回写通知，各自沿用自己的
   * requestId）。窗口期间已经送达的先剔掉（PIN-10）；一条都不剩就不起轮。
   */
  private async fireNotices(): Promise<void> {
    this.noticeTimer = undefined
    const pending = this.pendingNotices.splice(0)
    if (pending.length === 0 || this.closedFlag) return
    try {
      await this.op(async () => {
        const notices = await this.undelivered(await this.currentConversation(), pending)
        if (notices.length === 0) return
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
          {
            type: 'input',
            content: notices.map((n) => n.text).join('\n\n'),
            whenBusy: 'steer',
            requestId: combinedNoticeId(notices)
          },
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

  /** 通知作为插话汇入（requestId = 合并 id，已送达的先剔掉） */
  private async steerNotices(conversation: Conversation, pending: PendingNotice[]): Promise<void> {
    try {
      const notices = await this.undelivered(conversation, pending)
      if (notices.length === 0) return
      this.reopenInputs()
      await conversation.submit(
        {
          type: 'input',
          content: notices.map((n) => n.text).join('\n\n'),
          whenBusy: 'steer',
          requestId: combinedNoticeId(notices)
        },
        BG
      )
    } catch (error) {
      if (this.closedFlag || isClosedError(error)) return
      this.deps.logger.warn(`notice steer failed session=${this.sessionId}: ${errorText(error)}`)
    }
  }

  /** 这些 requestId 里，某对话已有提交（任何类型）的那些（一个只读提交） */
  private knownRequests(
    conversationId: ConversationId,
    requestIds: readonly string[]
  ): Promise<Set<string>> {
    return this.raw.commit(async (tx) => {
      const known = new Set<string>()
      for (const requestId of new Set(requestIds)) {
        if ((await tx.submissionByRequest(conversationId, requestId)) !== undefined) {
          known.add(requestId)
        }
      }
      return known
    }, BG)
  }

  /** 剔掉当前对话里已经有提交的通知 */
  private async undelivered(
    conversation: Conversation,
    notices: readonly PendingNotice[]
  ): Promise<PendingNotice[]> {
    const known = await this.knownRequests(
      conversation.id,
      notices.map((notice) => notice.requestId)
    )
    return notices.filter((notice) => !known.has(notice.requestId))
  }

  /**
   * 通知去重（PIN-09）：合并窗口里已有、待送达里已有、或当前对话里已有这个 requestId 的提交
   * （不分类型）。
   */
  private async noticeKnown(requestId: string): Promise<boolean> {
    if (this.pendingNotices.some((notice) => notice.requestId === requestId)) return true
    const state = await this.harness.snapshot(SessionStateDoc, BG)
    if (state?.deferredNotices.some((notice) => notice.requestId === requestId)) return true
    const conversation = await this.currentConversation()
    return (await this.findRequest(conversation.id, requestId)) !== undefined
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
    // 同一 requestId 已有提交（上次送到一半，或被别的类型占了）：只移除、不再写 —— 类型不符时
    // durable 的受理会抛错，绝不能让它卡住继续 / 中止（P2-09 PIN-09）
    const known = await this.knownRequests(
      conversation.id,
      deferred.map((notice) => notice.requestId)
    )
    for (const notice of deferred) {
      if (known.has(notice.requestId)) continue
      try {
        await conversation.submit(
          {
            type: 'write',
            entry: noticeEntryDraft(notice, this.deps.now()),
            requestId: notice.requestId
          },
          BG
        )
      } catch (error) {
        if (this.closedFlag || isClosedError(error)) throw error
        this.deps.logger.warn(
          `deferred notice ${notice.requestId} failed session=${this.sessionId}: ${errorText(error)}`
        )
      }
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
    // 任何非辅助的 run（当前对话的、被中断的、面板追问的子 agent 的，P2-03）都算
    if (this.isBusy() || this.isInterrupted() || this.hasRun(undefined)) {
      await this.abortConversation()
      // 当前对话的中止范围之外还活着的非辅助工作（不在根的拥有者链上的子对话）逐个中止
      for (const conversationId of this.primaryConversationsWithWork()) {
        const conversation = await this.harness.conversation(conversationId, BG)
        await conversation?.abort(BG)
      }
      await this.flushDeferred(await this.currentConversation(), 'place')
    }
    for (const notice of pending) await this.writeNotice(notice)
    // 派生 agent 的按 agent 扩展一并卸掉（记录留着，下次用到时按需重建）
    for (const extension of this.deps.registry.snapshot().installed()) {
      if (
        extension.name.startsWith(AGENT_EXTENSION_PREFIX) &&
        this.directory.identity(
          Number(extension.name.slice(AGENT_EXTENSION_PREFIX.length)) as ConversationId
        ) !== undefined
      ) {
        this.deps.registry.uninstall(extension)
      }
    }
  }

  /** 有活着的非辅助任务的对话 */
  private primaryConversationsWithWork(): ConversationId[] {
    const found = new Set<ConversationId>()
    for (const [id, task] of this.live) {
      if (!this.isAuxiliaryTask(id, task)) found.add(task.conversationId)
    }
    return [...found]
  }

  /** 某对话此刻活着的任务（协调器用） */
  private liveTasksOf(
    conversationId: ConversationId
  ): { id: TaskId; kind: string; abortRequested: boolean }[] {
    const tasks: { id: TaskId; kind: string; abortRequested: boolean }[] = []
    for (const [id, task] of this.live) {
      if (task.conversationId === conversationId) {
        tasks.push({ id, kind: task.kind, abortRequested: task.abortRequested })
      }
    }
    return tasks
  }

  /**
   * 中止一个子对话（面板的软停止 / 销毁，P2-03 PIN-04）：与会话中止同一套次序（关询问窗口 → 中止前
   * seam → 取消挂起的询问 → 中止对话），不记「显式喊停」；子对话停下之后重开询问窗口 —— 根的 run
   * 可能还在跑，它之后的询问不该被一直挡着。
   */
  private async stopConversation(conversationId: ConversationId): Promise<void> {
    const conversation = await this.harness.conversation(conversationId, BG)
    if (conversation === undefined) return
    this.inputs.closeInputs('aborted')
    try {
      this.deps.beforeAbort?.()
    } catch (error) {
      this.deps.logger.warn(`beforeAbort failed session=${this.sessionId}: ${errorText(error)}`)
    }
    this.inputs.cancelAll('aborted')
    try {
      await conversation.abort(BG)
    } finally {
      if (!this.closedFlag) this.reopenInputs()
    }
  }

  /**
   * 此刻有在跑的生成的派生 agent 的模型（辅助工作也算；记录写坏了的不算）—— 压缩余量取最小窗口用
   * （Q-P2-08，PIN-08）。同步。
   */
  liveAgentModels(): LockModel[] {
    const seen = new Set<ConversationId>()
    const models: LockModel[] = []
    for (const task of this.live.values()) {
      if (task.kind !== GENERATION_TASK_KIND || seen.has(task.conversationId)) continue
      seen.add(task.conversationId)
      const record = this.directory.record(task.conversationId)
      if (record !== undefined) models.push(record.model)
    }
    return models
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
        // 每条沿用自己的 requestId（PIN-11）：下个进程同一条再到达时能认出来
        await this.deferNotices(
          pending.map(({ text, kind, requestId }) => ({ requestId, text, kind }))
        )
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
