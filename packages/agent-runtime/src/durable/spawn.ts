/**
 * 派生 agent 协调器（SpawnCoordinator，P2-03）—— 每会话一个，由 DurableSessionImpl 持有（与锁并列）。
 *
 * 模型调 `agent` 工具时，派发工具把这一次派发交给 `session.agents.spawn(...)`：子 agent 落成这条会话里一个
 * **由派发工具任务拥有**的子对话，它的 agent 在一个提交里配好，跑完的回答交回派发工具。durable 已经把
 * 「拥有者边 + 中止级联 + 等待所拥有的工作 + 崩溃恢复」做成原生语义，这里只补 ShuviX 的那几条规矩：
 *
 *  - **创建（一个提交）**：提交之前读调用方（`api.agent()` 现取模型与思考档位；深度读调用方对话的
 *    `AgentStateDoc.depth`，宽松读，PIN-17）→ 深度校验（文案沿用旧 manager）→ 选模型（档案
 *    `shuvix-model` 经 `resolveProfileModel` + `resolveLockModel`，被拒 / 抛错 / 没有 seam 都回落调用方的
 *    模型；只有 seam 在却不可用才警告，PIN-07）与思考档位 → 归一名单 → agentId 记忆化（`api.memo`，重跑
 *    拿回同一个）→ 解析工具（`canSpawn` / `agentId` / 结果契约的 `next` 作 `extraTools`）→ 冻结人设（变量表
 *    按 agentId、cwd 为空，Q-P2-13）。然后**一个提交**里建子对话（拥有者 = 派发工具任务）、`configure`
 *    全部字段（模型、思考档位、显式扩展清单、显式工具清单、清掉 instructions / cwd —— 新对话会抄父对话
 *    的 agent，fact 1）、冻结人设、写派生 agent 记录。`shuvix.builtin` 不重建（与会话共用，沙箱钉子取
 *    根锁的，P2-04 PIN-02）。提交之后装 `shuvix.agent.<子对话>`、发布 details `{conversationId, agentId}`
 *    （PIN-15）、调 `onCreated`、以 requestId `agent:<taskId>` 提交任务、等它落定。
 *  - **结果**（PIN-02）：从这次派发的第一条 `pi.user` 起的 assistant 条目里抽（含追问轮）：同一条消息的
 *    文本部分以 '' 拼接，跨消息取最后一条有文本的；停止原因 / 报错的 `[Note]` 注记逐字沿用。
 *    `model_error` → `error` = 最后一条报错 assistant 的 errorMessage（空 = `model call failed
 *    (stopReason=error)`）；被中止且没有软停止标记 → `error: 'aborted'`；软停止（`interrupt`）→ 部分结果、
 *    不算失败。结果契约：子对话里第一条 `nextResultOf` 有值的工具结果即结构化结果（持久，跨进程可重读），
 *    `result` 是它的 JSON 文本，捕获恒为成功。
 *  - **出错即中止**：子对话存在之后的任何失败（details / 提交 / 等待 / 追问）都先中止子对话再返回 ——
 *    否则派发工具任务会以 completing 挂着、把根的这一轮拖住（fact 4）。工具自己的 signal 中止（Esc）时
 *    durable 已经级联中止了子对话：返回 `{result, error: 'aborted'}`，从不抛出（PIN-18）。
 *  - **结果契约**：任务 prompt 末尾追加契约段（PIN-16）；`next` 与别的工具同批（terminate 不成立）时，
 *    看到捕获就直接中止子对话（PIN-10，提交发布里察觉）；整批都是 `next` 但有一条没成功（不会 terminate）
 *    时同样中止；兜底：捕获之后子对话又起了新的一轮生成也中止。没捕获且这一轮正常结束 → 以
 *    `agent:<taskId>:nudge:<n>` 追问（缺省 1 次，出错 / 中止 / 软停止不追问）。
 *  - **重跑重新挂上**（PIN-06）：派发工具是 replay safe —— 崩溃后继续时它重跑，按
 *    `scanConversations({ownerTaskId})` 找到已建的子对话（`dispatch: 'tool'`），跳过深度 / 模型 / 工具 /
 *    人设各步（不调 resolve、变量表、`resolveProfileModel`），`ensureInstalled` 后以同一 requestId 提交 ——
 *    拿回原来那条提交（durable 原生去重），子对话的生成在同一个 Harness 里接着跑。
 *  - **面板**：`interrupt` = 软停止（中止子对话、记软停止标记）；`destroy` = 硬中止 + 卸掉扩展（转写与
 *    记录都留着，按需重建，PIN-03）；`continue` = 追问（`whenBusy: 'reject'`，没有 requestId，PIN-12）。
 *    中止次序沿用会话的那一套（关询问窗口 → 中止前 seam → 取消挂起的询问 → 中止对话，PIN-04），从不
 *    记「显式喊停」；子对话停下之后重开询问窗口（根的 run 可能还在跑，它的询问不该被一直挡着）。
 *  - **hook agent 用完即卸**：宿主派发的子 agent（`dispatch: 'hook'`）在那次派发 / 面板追问落定之后就卸掉
 *    按 agent 扩展（`unloadHosted`）。它是一次性的 —— 宿主派发从不重新挂上，没人再往它的工具表里调；而监控
 *    面板列的是「此刻装着的」，不卸就是每起一次标题、每审查一次多一行闲着的。转写与记录照留（任务行、追问照常）。
 *  - **重建**：`ensureInstalled(子对话)` 按记录重建按 agent 的工具（`rebuildAgentTools(record, {sessionId,
 *    extraTools: resultContractTools(record.resultContract)})`），附加工具显式拼进去
 *    （`agentExtensionTools(set)` 不读 `set.extraTools`）。打开时的重建由 DurableSession 调
 *    `restoreAtOpen`（只重建有活任务的非辅助派生对话，失败 / 记录写坏 → 警告并给它的活任务打中止标记，
 *    绝不挡打开，PIN-05）。
 *
 * 协调器不发任何 ChatEvent、不碰任务登记（那是 P2-05 的路由）。
 */
import type { Context } from '@earendil-works/chord'
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  CompactionEntry,
  ConversationBusy,
  ToolResultEntry,
  UserEntry,
  configure,
  type CommitChange,
  type Conversation,
  type ConversationHandle,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  type Harness,
  type Registry,
  type SettledSubmissionRecord,
  type Submission,
  type SubmissionRecord,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx
} from '@earendil-works/pi-durable'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import type { PromptVars, PromptVarsCtx } from '../agentProfile/promptVars'
import { resolveLockModel, type LockModel, type ModelSelection } from '../models/lockModel'
import {
  NEXT_NUDGE_TEXT,
  NEXT_TOOL_NAME,
  buildResultContractNote,
  nextResultOf,
  resultContractTools,
  validateContractSchema,
  type ResultContract
} from '../subagent/nextTool'
import type { InProcessAgentType } from '../subagent/types'
import type { RuntimeLogger } from '../types'
import type { AgentDirectory } from './agentDirectory'
import { SpawnAnchor } from './anchor'
import {
  MAX_AGENT_DEPTH,
  canSpawnAt,
  writeSpawnedAgentRecord,
  type LockRecord,
  type SpawnedAgentRecord
} from './agentRecord'
import { normalizeToolNames, resolveThinkingLevel } from './agentSpec'
import { backgroundContext as BG, errorText, isClosedError } from './context'
import { AgentStateDoc } from './docs'
import {
  SHUVIX_BUILTIN_EXTENSION,
  agentExtension,
  agentExtensionName,
  composeAgentTools
} from './lock'
import { computeFrozenAgentPrompt, freezePersona } from './prompt/persona'
import type { PromptExtensions } from './prompt/sections'
import type { ModelCatalog, ToolHost } from './seams'

const SCAN_PAGE_SIZE = 256
const GENERATION_TASK_KIND = 'pi.generation'

/** 调用方没有模型时的错误文案（PIN-07） */
export const NO_CALLER_MODEL_TEXT = 'No model is configured for the calling agent'

/**
 * 被中断的会话上拒绝宿主派发的文案（P2-08 PIN-07）：任何提交都会开启整个调度器、把被中断的工作续上，
 * 而宿主派发的 agent 从不替用户「继续」。
 */
export const HOSTED_INTERRUPTED_TEXT =
  'The session is interrupted; a host-dispatched agent would resume its interrupted work, so none was started'

/** 深度超限的文案（沿用旧 manager，逐字） */
export function agentDepthLimitText(max: number, callerDepth: number): string {
  return `Agent depth limit reached (max ${max}): this agent is already at depth ${callerDepth} and cannot spawn further agents. Complete the task directly instead.`
}

// ─────────────────────────── 公共类型 ───────────────────────────

/** 派发的拥有者：`{tool}` = 模型调派发工具（子对话由这次工具调用的任务拥有） */
export interface SpawnToolOwner {
  /** 派发工具这次调用的 durable API（可以是包了一层的拷贝） */
  readonly tool: ToolExecutionApi
}

/**
 * 宿主派发（判定型 hook：权限审查，Q16，P2-08）：子对话由**提问的那个工具任务**拥有。那个任务必须活着
 * （不是 completing、没终结、没打中止标记），否则创建提交被 durable 拒绝 —— 什么都不建、交回错误
 * （PIN-13，没有锚回落）。
 */
export interface SpawnTaskOwner {
  readonly task: number
}

/**
 * 宿主派发（观察型 hook：起标题；以及没有 taskId 的判定，P2-08）：同一个提交里在会话的当前对话建一个
 * 后台锚任务（`shuvix.spawn.anchor`），子对话归它。
 */
export interface SpawnAnchorOwner {
  readonly anchor: true
}

export type SpawnOwner = SpawnToolOwner | SpawnTaskOwner | SpawnAnchorOwner

/** 宿主派发才读的参数（`{task}` / `{anchor}` 拥有者） */
export interface SpawnHostedOptions {
  /** 基准模型（hook 的运行模型：锁定时 = 锁的模型，PIN-06）；缺省根锁的模型。档案 `shuvix-model` 优先 */
  model?: LockModel
  /** 基准思考档位（缺省根锁的）；档案 `shuvix-thinking` 优先 */
  thinkingLevel?: ThinkingLevel
  /** hook 文件名（进记录的 `hook`） */
  hook?: string
  /** 任务提交的 requestId（PIN-04：`hook:<runId>`）；缺省 `hook:<agentId>` */
  requestId?: string
}

/** 子 agent 刚建好（或重跑时重新挂上）的那一刻交给调用方的信息（P2-05 的路由据此登记、广播） */
export interface SpawnCreatedInfo {
  agentId: string
  conversationId: ConversationId
  depth: number
  displayName: string
  description: string
  parentConversationId: ConversationId
  /** true = 重跑找到了已建的子对话（没有新建任何东西） */
  reattached: boolean
}

export interface SpawnParams {
  owner: SpawnOwner
  profile: InProcessAgentType
  prompt: string
  description: string
  /** 结果契约：子 agent 多一个 `next` 工具，prompt 末尾追加契约段；schema 不合法 → `spawn` 拒绝（PIN-11） */
  resultContract?: ResultContract
  /**
   * 建好之后（提交 + 装扩展之后、提交任务之前）调一次；重跑重新挂上时带 `reattached: true` 再调一次。
   * 被拒（深度 / 没有模型）或提交之前就失败时从不调用。抛错只记警告，不影响派发本身。
   */
  onCreated?: (info: SpawnCreatedInfo) => void
  /** 宿主派发的参数（工具派发不读） */
  hosted?: SpawnHostedOptions
}

/**
 * 一次派发 / 追问的结果（从不因为 run 失败而抛出）：
 *  - `result` 恒为文本（转写抽取，带注记；捕获了结果契约 = 捕获对象的 JSON 文本；被拒 = 拒绝原因）；
 *  - `structured`：结果契约捕获成功时；
 *  - `error`：失败的机器可读原因（模型报错原文 / `'aborted'` / 拒绝原因 / 执行抛错）；软停止与捕获不算失败；
 *  - `conversationId` / `agentId`：子对话建成之后才有。
 */
export interface SpawnOutcome {
  result: string
  structured?: unknown
  error?: string
  conversationId?: ConversationId
  agentId?: string
}

export interface SpawnCoordinator {
  /**
   * 派发一个子 agent 并等它的回答。被拒 / 失败都在结果里（不抛出）；只有结果契约的 schema 不合法
   * （宿主编程错误）以 `invalid result contract: …` 拒绝。
   */
  spawn(params: SpawnParams, context: Context): Promise<SpawnOutcome>
  /** 软停止一个在跑的子 agent（保留部分结果，不算失败）；空闲 / 不认识 / 根 → 无操作；等它停下才返回 */
  interrupt(conversationId: number): Promise<void>
  /** 硬中止（在跑的话）并卸掉它的按 agent 扩展；转写、记录、身份都留着（之后按需重建） */
  destroy(conversationId: number): Promise<void>
  /** 面板追问：给子 agent 再发一轮（忙 → `{error}`；不是派生 agent → `{error}`） */
  continue(conversationId: number, text: string): Promise<SpawnOutcome>
  /** 子 agent 的按 agent 扩展没装就按记录重建（不是派生 agent / 记录写坏了 → 抛错） */
  ensureInstalled(conversationId: number): Promise<void>
}

// ─────────────────────────── 结果抽取（PIN-02，纯函数） ───────────────────────────

function assistantOf(entry: EntryRecord): AssistantMessage | undefined {
  if (entry.kind !== AssistantEntry.kind) return undefined
  const message = entry.model?.[0]
  return message?.role === 'assistant' ? (message as AssistantMessage) : undefined
}

/** 一条 assistant 消息的文本（文本部分以 '' 拼接）与工具调用数 */
function messageParts(message: AssistantMessage): { text: string; toolCalls: number } {
  let text = ''
  let toolCalls = 0
  for (const part of message.content) {
    if (part.type === 'text') text += part.text
    else if (part.type === 'toolCall') toolCalls++
  }
  return { text, toolCalls }
}

/**
 * 从一段转写（最旧在前）的 assistant 条目抽结果文本（旧 `extractResult` 的口径，PIN-02）：最后一条有文本
 * 的消息即回答；停止原因不是 stop / 有报错 / 执行抛错 → `[Note]` 注记；没有文本 → 说明句。
 *
 * 压缩条目之前的停止原因与报错不算数（P2-11 J5-02）：溢出 → 阻塞压缩 → 重试成功时，那条报错的 assistant
 * 条目留在转写里，但它已经被这次压缩收复了 —— 旧运行时里它不在消息表里，回答不该再带一条 `error=` 注记。
 *
 * 被重试收复的失败尝试同理（P3-16 裁定）：报错的 assistant 条目之后同一 `byTaskId` 还有更晚的 assistant
 * 条目 = 这次运行重试过、接着往下跑了 —— 这条尝试整条不算（不计数、不取文本、不带注记），与界面投影的
 * 重试折叠同一口径（Q-P3-06）。最后一次尝试仍失败的运行，那条报错就是同一任务的最后一条，注记照留。
 */
export function extractSpawnResult(entries: readonly EntryRecord[], execError?: string): string {
  // 每个任务最后一条 assistant 条目的位置：更早的报错条目是被重试收复的尝试
  const lastOfTask = new Map<number, number>()
  entries.forEach((entry, index) => {
    if (entry.kind === AssistantEntry.kind && entry.byTaskId !== undefined) {
      lastOfTask.set(entry.byTaskId, index)
    }
  })
  let lastText = ''
  let lastStopReason = ''
  let lastErrorMessage = ''
  let assistantCount = 0
  let toolUseCount = 0
  for (const [index, entry] of entries.entries()) {
    if (entry.kind === CompactionEntry.kind) {
      lastStopReason = ''
      lastErrorMessage = ''
      continue
    }
    const message = assistantOf(entry)
    if (message === undefined) continue
    const task = entry.byTaskId
    if (
      message.stopReason === 'error' &&
      task !== undefined &&
      (lastOfTask.get(task) ?? -1) > index
    ) {
      continue
    }
    assistantCount++
    if (message.stopReason) lastStopReason = message.stopReason
    if (message.errorMessage) lastErrorMessage = message.errorMessage
    const { text, toolCalls } = messageParts(message)
    if (text) lastText = text
    toolUseCount += toolCalls
  }
  if (lastText) {
    const notes: string[] = []
    if (lastStopReason && lastStopReason !== 'stop') notes.push(`stopReason=${lastStopReason}`)
    if (lastErrorMessage) notes.push(`error=${lastErrorMessage}`)
    if (execError) notes.push(`execError=${execError}`)
    return notes.length > 0 ? `${lastText}\n\n[Note] ${notes.join('; ')}` : lastText
  }
  const parts: string[] = [
    `Agent did not produce a final text response (${assistantCount} assistant message(s), ${toolUseCount} tool call(s)).`
  ]
  if (lastStopReason) parts.push(`stopReason=${lastStopReason}.`)
  if (lastErrorMessage) parts.push(`Model errorMessage: ${lastErrorMessage}.`)
  if (execError) parts.push(`Execution threw: ${execError}.`)
  return parts.join(' ')
}

/** 模型报错的原因（turnError 的模型一行）：最后一条 assistant 报错 → errorMessage，空 = 通用文案 */
function modelErrorOf(entries: readonly EntryRecord[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = assistantOf(entries[index]!)
    if (message === undefined) continue
    if (message.stopReason !== 'error') return undefined
    return message.errorMessage || 'model call failed (stopReason=error)'
  }
  return undefined
}

/** 转写次序里第一条成功的 `next` 结果 */
function firstCapture(entries: readonly EntryRecord[]): Record<string, unknown> | undefined {
  for (const entry of entries) {
    const value = nextResultOf(entry)
    if (value !== undefined) return value
  }
  return undefined
}

function capturedOutcome(
  value: Record<string, unknown>,
  ids: { conversationId: ConversationId; agentId: string }
): SpawnOutcome {
  return { result: JSON.stringify(value, null, 2), structured: value, ...ids }
}

function detailText(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined
  if (typeof detail === 'string') return detail.length > 0 ? detail : undefined
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

function randomAgentId(): string {
  return `sub-${globalThis.crypto.randomUUID()}`
}

// ─────────────────────────── 实现 ───────────────────────────

/** 协调器从会话拿的那几样（DurableSessionImpl 实现） */
export interface SpawnHost {
  readonly sessionId: string
  /** 经包装的 Harness（会开启调度器的调用被记下） */
  readonly harness: Harness
  /** 未包装的 Harness（只读提交 / 快照 / 打中止标记，从不开启调度器） */
  readonly raw: Harness
  readonly registry: Registry<ToolRegistration>
  readonly toolHost: ToolHost
  readonly modelCatalog: ModelCatalog
  readonly promptExtensions: PromptExtensions
  readonly promptVars: (ctx: PromptVarsCtx) => PromptVars | Promise<PromptVars>
  readonly resolveProfileModel?: (
    spec: string
  ) => ModelSelection | null | undefined | Promise<ModelSelection | null | undefined>
  readonly maxAgentDepth?: number
  readonly logger: RuntimeLogger
  readonly now: () => number
  readonly directory: AgentDirectory
  /** 根锁（派生 agent 的沙箱钉子取它的，P2-04） */
  rootLock(): LockRecord | undefined
  /** 某对话此刻活着的任务（id、种类、是否已打中止标记） */
  liveTasksOf(
    conversationId: ConversationId
  ): readonly { id: TaskId; kind: string; abortRequested: boolean }[]
  /** 此刻有活任务的对话 */
  liveConversationIds(): ConversationId[]
  /** 会话被中断（存储里有非辅助的 run、调度器停着）—— 宿主派发拒绝（P2-08 PIN-07） */
  isInterrupted(): boolean
  /** 句柄已关停 */
  isClosed(): boolean
  /** 会话的当前对话（锚建在它里面，P2-08 PIN-01） */
  currentConversation(): Promise<Conversation>
  /** 会话的中止次序作用在一个子对话上（关询问窗口 → 中止前 seam → 取消询问 → 中止对话 → 重开询问） */
  stopConversation(conversationId: ConversationId): Promise<void>
  /** 起跑路径的重开询问（含 `onInputsReopened`） */
  reopenInputs(): void
  /**
   * 会话的 `shuvix.builtin` 没装就装上（惰性，option A：打开一条空闲会话不建它）。子 agent 的内置工具按名从
   * 它解析，所以派生（工具 / 宿主）与重建（打开时 / 面板追问 / 重跑重新挂上）都先调它。失败原样抛出。
   */
  ensureBuiltin(): Promise<void>
  /** 一次会话调用（关停后拒绝、计入进行中） */
  op<T>(work: () => Promise<T>): Promise<T>
}

/** 驱动一次派发要用的那几样（工具派发经工具 API，宿主派发经 Harness） */
interface DriveAccess {
  /** 任务提交的 requestId（工具：`agent:<taskId>`；宿主：`hook:<runId>`） */
  requestId: string
  /** 发布 details（只有工具派发有调用槽） */
  details?: (value: { conversationId: ConversationId; agentId: string }) => Promise<void>
  conversation(child: ConversationId): Promise<ConversationHandle | undefined>
  /** 宿主派发：调用方的 signal 落下时要自己中止子对话 */
  hosted: boolean
}

/** 提交之前那几步的产物 */
interface Prepared {
  builtin: Extension | undefined
  composed: ReturnType<typeof composeAgentTools>
  promptExtensions: Extension[]
  mcp: SpawnedAgentRecord['mcp']
  resolved: Awaited<ReturnType<ToolHost['resolveAgentTools']>>
  frozen: Awaited<ReturnType<typeof computeFrozenAgentPrompt>>
}

/** 一个带结果契约的子对话的捕获观察（提交发布里同步维护，PIN-10） */
interface CaptureWatch {
  captured: boolean
  /** 这一轮的工具调用（callId → 工具名） */
  calls: Map<string, string> | undefined
  /** 发出这一轮的生成任务（之后出现的别的生成任务 = 新的一轮） */
  generation: TaskId | undefined
  /** 这一轮已落下的工具结果：callId → 是不是成功的 `next` */
  results: Map<string, boolean>
  aborting: boolean
}

export class SpawnCoordinatorImpl implements SpawnCoordinator {
  /** 被软停止的子对话（进程内；读结果时消费，追问时清掉） */
  private readonly soft = new Set<ConversationId>()
  private readonly watches = new Map<ConversationId, CaptureWatch>()
  private readonly installing = new Map<ConversationId, Promise<void>>()

  constructor(private readonly host: SpawnHost) {}

  private get maxDepth(): number {
    const max = this.host.maxAgentDepth
    return typeof max === 'number' && Number.isInteger(max) && max >= 0 ? max : MAX_AGENT_DEPTH
  }

  // ─── 派发 ───────────────────────────────────────

  async spawn(params: SpawnParams, context: Context): Promise<SpawnOutcome> {
    const { resultContract: contract } = params
    if (contract !== undefined) {
      const reason = validateContractSchema(contract.schema)
      if (reason !== null) throw new Error(`invalid result contract: ${reason}`)
    }
    const owner = params.owner
    // 宿主派发（P2-08）：每次一条新的子对话，从不重新挂上（PIN-04）
    if (!('tool' in owner)) return this.createHosted(params, owner, context)
    const api = owner.tool
    // 重跑：这次工具调用已经建过子对话（PIN-06）
    const existing = await this.discover(api, context)
    if (existing !== undefined) return this.reattach(params, existing, context)
    return this.create(params, api, context)
  }

  /** 工具派发的驱动入口：requestId `agent:<taskId>`、details、经工具 API 拿子对话句柄 */
  private toolAccess(api: ToolExecutionApi, context: Context): DriveAccess {
    return {
      requestId: `agent:${api.taskId}`,
      details: (value) => api.details(value, context),
      conversation: (child) => api.conversation(child, context),
      hosted: false
    }
  }

  /** 这个派发工具任务名下已建的 `tool` 派发子对话（宽松读 dispatch） */
  private async discover(
    api: ToolExecutionApi,
    context: Context
  ): Promise<ConversationId | undefined> {
    const owned = await api.commit(async (tx) => {
      const ids: ConversationId[] = []
      let cursor: Parameters<typeof tx.scanConversations>[2]
      do {
        const page = await tx.scanConversations({ ownerTaskId: api.taskId }, SCAN_PAGE_SIZE, cursor)
        for (const record of page.items) ids.push(record.id)
        cursor = page.next
      } while (cursor !== undefined)
      return ids
    }, context)
    for (const id of owned) {
      const state = await api.snapshot(AgentStateDoc, id, context)
      if (state?.dispatch === 'tool') return id
    }
    return undefined
  }

  private async create(
    params: SpawnParams,
    api: ToolExecutionApi,
    context: Context
  ): Promise<SpawnOutcome> {
    const { profile, description, resultContract: contract } = params
    const host = this.host
    const { sessionId, logger } = host

    // 深度（PIN-17：调用方对话的 AgentStateDoc.depth，宽松读，不要求记录合法）
    const callerState = await api.snapshot(AgentStateDoc, api.conversationId, context)
    const callerDepth = positiveInteger(callerState?.depth) ?? 0
    const max = this.maxDepth
    const depth = callerDepth + 1
    if (depth > max) {
      const text = agentDepthLimitText(max, callerDepth)
      return { result: text, error: text }
    }
    const canSpawn = canSpawnAt(depth, max)

    // 调用方（现取：模型、思考档位）与模型选择（PIN-07）
    const caller = await api.agent(context)
    const model = (await this.profileModel(profile)) ?? caller.model
    if (model === undefined) return { result: NO_CALLER_MODEL_TEXT, error: NO_CALLER_MODEL_TEXT }
    const thinkingLevel =
      resolveThinkingLevel('spawned', profile, caller.thinkingLevel as ThinkingLevel) ?? 'off'
    const names = normalizeToolNames('spawned', profile.tools, undefined)

    // agentId：这次派发的第一个持久步骤（PIN-13），重跑拿回同一个
    const agentId = await api.memo<string>('agentId', randomAgentId(), context)

    const prepared = await this.prepare(
      { profile, names, model, thinkingLevel, agentId, canSpawn, contract },
      context
    )
    if ('failure' in prepared) return prepared.failure
    const { builtin, composed, promptExtensions, mcp, resolved, frozen } = prepared
    const lockPin = host.rootLock()?.sandboxed

    // 一个提交：子对话 + pi.agent + 人设 + 记录
    let record: SpawnedAgentRecord
    try {
      record = await api.commit(async (tx) => {
        const child = await tx.createConversation({
          ownership: { kind: 'task', taskId: api.taskId }
        })
        const extensions: Extension[] = [
          builtin ?? { name: SHUVIX_BUILTIN_EXTENSION },
          ...promptExtensions,
          { name: agentExtensionName(child.id) }
        ]
        const built: SpawnedAgentRecord = {
          conversationId: child.id,
          profileName: profile.name,
          kind: 'spawned',
          model: { provider: model.provider, modelId: model.modelId },
          thinkingLevel,
          toolNames: composed.toolNames,
          extensions: extensions.map((extension) => extension.name),
          sandboxed: lockPin ?? resolved.sandboxed,
          mcp,
          skills: [...(resolved.skills ?? [])],
          createdAt: host.now(),
          agentId,
          depth,
          canSpawn,
          dispatch: 'tool',
          parentConversationId: api.conversationId,
          ownerTaskId: api.taskId,
          // 空串不写：解析按「给了就得是非空串」认，写进去整条记录会被当成写坏了
          ...(api.callId ? { ownerCallId: api.callId } : {}),
          displayName: profile.displayName,
          description,
          ...(contract === undefined ? {} : { resultContract: contract })
        }
        // 先严格序列化（非 JSON 的值在这里抛错，整个提交作废）
        await writeSpawnedAgentRecord(tx, child.id, built)
        await configure(tx, child.id, {
          model: built.model,
          thinkingLevel,
          extensions,
          tools: composed.tools,
          instructions: null,
          cwd: null
        })
        await freezePersona(tx, child.id, frozen)
        return built
      }, context)
    } catch (error) {
      if (context.abortSignal?.aborted) return { result: 'Aborted.', error: 'aborted' }
      const message = errorText(error)
      logger.warn(`session ${sessionId}: creating agent "${profile.name}" failed: ${message}`)
      return { result: `Failed to start agent "${profile.name}": ${message}`, error: message }
    }
    const child = record.conversationId
    host.registry.install(agentExtension(child, composed.agentTools))
    logger.info(
      `session ${sessionId}: spawned agent=${agentId} profile=${profile.name} conversation=${child} depth=${depth}`
    )
    return this.drive(params, record, false, context, this.toolAccess(api, context))
  }

  /**
   * 提交之前的那几步（工具派发与宿主派发共用）：解析工具（`canSpawn` / `agentId` / 结果契约的 `next`）→
   * 冻结人设（变量表按 agentId、cwd 为空）→ 拼工具清单与段落扩展。失败交回结果（被中止 → `'aborted'`）。
   */
  private async prepare(
    input: {
      profile: InProcessAgentType
      names: string[]
      model: LockModel
      thinkingLevel: ThinkingLevel
      agentId: string
      canSpawn: boolean
      contract: ResultContract | undefined
    },
    context: Context
  ): Promise<Prepared | { failure: SpawnOutcome }> {
    const { profile, names, model, thinkingLevel, agentId, canSpawn, contract } = input
    const host = this.host
    const { sessionId, logger } = host
    let resolved: Awaited<ReturnType<ToolHost['resolveAgentTools']>>
    let frozen: Awaited<ReturnType<typeof computeFrozenAgentPrompt>>
    const extraTools = resultContractTools(contract)
    try {
      // 子 agent 的内置工具取会话的那一份（下面按名单拼次序时读它）：还没装就先装
      await host.ensureBuiltin()
      resolved = await host.toolHost.resolveAgentTools(
        {
          sessionId,
          kind: 'spawned',
          rootSessionId: sessionId,
          selfSessionId: agentId,
          agentId,
          canSpawn,
          profile,
          names,
          model: { provider: model.provider, modelId: model.modelId },
          thinkingLevel,
          cwd: '',
          ...(extraTools.length > 0 ? { extraTools } : {})
        },
        { signal: context.abortSignal ?? new AbortController().signal }
      )
      frozen = await computeFrozenAgentPrompt(
        { promptVars: host.promptVars, logger },
        {
          kind: 'spawned',
          sessionId: agentId,
          rootSessionId: sessionId,
          cwd: '',
          toolNames: names,
          profile
        }
      )
    } catch (error) {
      if (context.abortSignal?.aborted) {
        return { failure: { result: 'Aborted.', error: 'aborted' } }
      }
      const message = errorText(error)
      logger.warn(`session ${sessionId}: spawning agent "${profile.name}" failed: ${message}`)
      return {
        failure: { result: `Failed to start agent "${profile.name}": ${message}`, error: message }
      }
    }

    const builtin = host.registry.snapshot().extension(SHUVIX_BUILTIN_EXTENSION)
    const composed = composeAgentTools({
      names,
      builtin: builtin?.tools ?? [],
      set: resolved,
      extraTools: resolved.extraTools
    })
    const promptExtensions = host.promptExtensions.select({
      kind: 'spawned',
      profile,
      toolNames: names
    })
    const mcp: SpawnedAgentRecord['mcp'] = {}
    for (const entry of resolved.mcp ?? []) mcp[entry.server] = [...entry.declarations]
    return { builtin, composed, promptExtensions, mcp, resolved, frozen }
  }

  /**
   * 宿主派发（P2-08）：hook 派出的 agent。与工具派发同一套模型 / 工具 / 人设 / 记录，只差几条宿主规矩：
   *  - 被中断的会话上拒绝（任何提交都会续上被中断的工作，PIN-07）；
   *  - 深度恒为 1、`canSpawn: false`、从不被深度上限拒绝（PIN-03）；记录 `dispatch: 'hook'`、`hook` = hook 名，
   *    父对话 = 拥有者任务所在的对话（锚 = 当前对话）；
   *  - 一个提交（未包装的 Harness，不开启调度器）：`{anchor}` 先在当前对话建后台锚任务，`{task}` 读那个
   *    工具任务（它必须活着，否则 durable 拒绝这个提交 —— PIN-13）；
   *  - 每次一条新的子对话（PIN-04），requestId `hook:<runId>`；
   *  - 调用方的 signal 落下（超时 / 中止）→ **中止子对话**再交回 `'aborted'`（PIN-05）：它不在任何会被原生
   *    级联到的范围里（锚是后台的；工具任务的 signal 与这条 signal 不是一回事）。
   */
  private async createHosted(
    params: SpawnParams,
    owner: SpawnTaskOwner | SpawnAnchorOwner,
    context: Context
  ): Promise<SpawnOutcome> {
    const { profile, description, resultContract: contract } = params
    const hosted = params.hosted ?? {}
    const host = this.host
    const { sessionId, logger } = host
    if (host.isClosed()) {
      const text = `Session ${sessionId} is closed`
      return { result: text, error: text }
    }
    if (host.isInterrupted()) {
      logger.info(`session ${sessionId}: host dispatch of "${profile.name}" refused: interrupted`)
      return { result: HOSTED_INTERRUPTED_TEXT, error: HOSTED_INTERRUPTED_TEXT }
    }
    if (context.abortSignal?.aborted) return { result: 'Aborted.', error: 'aborted' }

    const lock = host.rootLock()
    const model = (await this.profileModel(profile)) ?? hosted.model ?? lock?.model
    if (model === undefined) return { result: NO_CALLER_MODEL_TEXT, error: NO_CALLER_MODEL_TEXT }
    const base = hosted.thinkingLevel ?? (lock?.thinkingLevel as ThinkingLevel | undefined)
    const thinkingLevel = resolveThinkingLevel('spawned', profile, base) ?? 'off'
    const names = normalizeToolNames('spawned', profile.tools, undefined)
    const agentId = randomAgentId()
    const depth = 1
    const canSpawn = false

    const prepared = await this.prepare(
      { profile, names, model, thinkingLevel, agentId, canSpawn, contract },
      context
    )
    if ('failure' in prepared) return prepared.failure
    const { builtin, composed, promptExtensions, mcp, resolved, frozen } = prepared
    const lockPin = lock?.sandboxed

    let record: SpawnedAgentRecord
    try {
      const anchorParent = 'anchor' in owner ? (await host.currentConversation()).id : undefined
      record = await host.raw.commit(async (tx) => {
        let ownerTaskId: TaskId
        let parent: ConversationId
        if ('task' in owner) {
          // 表读先于本提交的第一次写；拥有者活不活由 durable 的创建校验裁决
          const ownerTask = await tx.task(owner.task as TaskId)
          if (ownerTask === undefined) throw new Error(`owner task ${owner.task} does not exist`)
          ownerTaskId = ownerTask.id as TaskId
          parent = ownerTask.conversationId
        } else {
          parent = anchorParent!
          ownerTaskId = await tx.createTask(SpawnAnchor, null, {
            ownership: { kind: 'conversation' },
            conversationId: parent,
            background: true
          })
        }
        const child = await tx.createConversation({
          ownership: { kind: 'task', taskId: ownerTaskId }
        })
        const extensions: Extension[] = [
          builtin ?? { name: SHUVIX_BUILTIN_EXTENSION },
          ...promptExtensions,
          { name: agentExtensionName(child.id) }
        ]
        const built: SpawnedAgentRecord = {
          conversationId: child.id,
          profileName: profile.name,
          kind: 'spawned',
          model: { provider: model.provider, modelId: model.modelId },
          thinkingLevel,
          toolNames: composed.toolNames,
          extensions: extensions.map((extension) => extension.name),
          sandboxed: lockPin ?? resolved.sandboxed,
          mcp,
          skills: [...(resolved.skills ?? [])],
          createdAt: host.now(),
          agentId,
          depth,
          canSpawn,
          dispatch: 'hook',
          parentConversationId: parent,
          ownerTaskId,
          displayName: profile.displayName,
          description,
          ...(hosted.hook === undefined ? {} : { hook: hosted.hook }),
          ...(contract === undefined ? {} : { resultContract: contract })
        }
        await writeSpawnedAgentRecord(tx, child.id, built)
        await configure(tx, child.id, {
          model: built.model,
          thinkingLevel,
          extensions,
          tools: composed.tools,
          instructions: null,
          cwd: null
        })
        await freezePersona(tx, child.id, frozen)
        return built
      }, BG)
    } catch (error) {
      const message = errorText(error)
      logger.warn(`session ${sessionId}: creating hook agent "${profile.name}" failed: ${message}`)
      return { result: `Failed to start agent "${profile.name}": ${message}`, error: message }
    }
    const child = record.conversationId
    host.registry.install(agentExtension(child, composed.agentTools))
    logger.info(
      `session ${sessionId}: host-dispatched agent=${agentId} profile=${profile.name} hook=${hosted.hook ?? ''} conversation=${child} owner=${'task' in owner ? 'task' : 'anchor'}:${record.ownerTaskId}`
    )
    try {
      return await this.drive(params, record, false, context, {
        requestId: hosted.requestId ?? `hook:${agentId}`,
        conversation: (id) => host.harness.conversation(id, BG),
        hosted: true
      })
    } finally {
      this.unloadHosted(child)
    }
  }

  private async reattach(
    params: SpawnParams,
    child: ConversationId,
    context: Context
  ): Promise<SpawnOutcome> {
    const record = this.host.directory.record(child)
    if (record === undefined) {
      const message = `conversation ${child} has a malformed spawned agent record`
      await this.abortQuietly(child)
      return { result: message, error: message, conversationId: child }
    }
    try {
      await this.ensureInstalled(child)
    } catch (error) {
      const message = errorText(error)
      await this.abortQuietly(child)
      return { result: message, error: message, conversationId: child, agentId: record.agentId }
    }
    const api = (params.owner as SpawnToolOwner).tool
    return this.drive(params, record, true, context, this.toolAccess(api, context))
  }

  /**
   * 子对话已在（新建或重跑找到）：details → onCreated → 提交任务 → 等待 → 追问 → 结果。任何失败都先
   * 中止子对话；工具自己被中止 → `error: 'aborted'`。
   */
  private async drive(
    params: SpawnParams,
    record: SpawnedAgentRecord,
    reattached: boolean,
    context: Context,
    access: DriveAccess
  ): Promise<SpawnOutcome> {
    const contract = record.resultContract
    const child = record.conversationId
    const ids = { conversationId: child, agentId: record.agentId }
    const requestId = access.requestId
    let firstEntry: EntryId | undefined
    try {
      await access.details?.({ conversationId: child, agentId: record.agentId })
      this.notifyCreated(params, record, reattached)
      // 崩溃前已经捕获过（混批里的 next 落了、协调器还没来得及中止）：直接以它收尾
      if (reattached && contract !== undefined) {
        const known = await this.raw((tx) => tx.submissionByRequest(child, requestId))
        const captured = firstCapture(await this.entriesSince(child, known?.entry))
        if (known?.entry !== undefined && captured !== undefined) {
          await this.abortQuietly(child)
          return capturedOutcome(captured, ids)
        }
      }
      const handle = await access.conversation(child)
      if (handle === undefined) throw new Error(`conversation ${child} does not exist`)
      const content =
        contract === undefined
          ? params.prompt
          : `${params.prompt}\n\n${buildResultContractNote(contract)}`
      let settled = await this.submitAndWait(handle, content, requestId, context)
      firstEntry = settled.entry
      if (contract !== undefined) {
        const nudges = contract.nudges ?? 1
        for (let n = 1; ; n++) {
          const entries = await this.entriesSince(child, firstEntry)
          const captured = firstCapture(entries)
          if (captured !== undefined) {
            this.soft.delete(child)
            return capturedOutcome(captured, ids)
          }
          if (n > nudges || settled.status !== 'done') break
          settled = await this.submitAndWait(
            handle,
            NEXT_NUDGE_TEXT,
            `${requestId}:nudge:${n}`,
            context
          )
        }
      }
      return await this.outcomeOf(child, settled, firstEntry, ids)
    } catch (error) {
      // 等待被打断时还不知道起点：按 requestId 找这次派发的那条输入
      firstEntry ??= await this.raw((tx) => tx.submissionByRequest(child, requestId))
        .then((known) => known?.entry)
        .catch(() => undefined)
      if (context.abortSignal?.aborted || isClosedError(error)) {
        this.soft.delete(child)
        // 宿主派发的子对话不在任何原生级联的范围里：调用方不再等了，就得自己停下它（PIN-05）
        if (access.hosted && !isClosedError(error)) await this.abortQuietly(child)
        const entries = await this.entriesSince(child, firstEntry).catch(() => [])
        const captured = firstCapture(entries)
        if (captured !== undefined) return capturedOutcome(captured, ids)
        return { result: extractSpawnResult(entries), error: 'aborted', ...ids }
      }
      // 出错即中止：子对话还在跑就会把派发工具任务拖在 completing 里
      const message = errorText(error)
      this.host.logger.warn(
        `session ${this.host.sessionId}: agent ${record.agentId} (conversation ${child}) failed: ${message}`
      )
      await this.abortQuietly(child)
      const entries = await this.entriesSince(child, firstEntry).catch(() => [])
      return { result: extractSpawnResult(entries, message), error: message, ...ids }
    }
  }

  private notifyCreated(
    params: SpawnParams,
    record: SpawnedAgentRecord,
    reattached: boolean
  ): void {
    if (params.onCreated === undefined) return
    try {
      params.onCreated({
        agentId: record.agentId,
        conversationId: record.conversationId,
        depth: record.depth,
        displayName: record.displayName,
        description: record.description,
        parentConversationId: record.parentConversationId,
        reattached
      })
    } catch (error) {
      this.host.logger.warn(
        `session ${this.host.sessionId}: onCreated failed for agent ${record.agentId}: ${errorText(error)}`
      )
    }
  }

  /** 提交（已有同 requestId 的提交 = 拿回它）并等落定 */
  private async submitAndWait(
    handle: ConversationHandle,
    content: string,
    requestId: string,
    context: Context
  ): Promise<SettledSubmissionRecord> {
    const submission: Submission = await handle.submit(
      { type: 'input', content, requestId },
      context
    )
    return submission.wait(context)
  }

  /** 落定记录 + 转写 → 结果（软停止标记在这里消费） */
  private async outcomeOf(
    child: ConversationId,
    settled: SubmissionRecord,
    firstEntry: EntryId | undefined,
    ids: { conversationId: ConversationId; agentId: string }
  ): Promise<SpawnOutcome> {
    const entries = await this.entriesSince(child, firstEntry)
    const soft = this.soft.delete(child)
    if (settled.status === 'done') return { result: extractSpawnResult(entries), ...ids }
    const reason = (settled as { readonly reason?: string }).reason ?? ''
    if (reason === 'aborted') {
      if (soft) return { result: extractSpawnResult(entries), ...ids }
      return { result: extractSpawnResult(entries), error: 'aborted', ...ids }
    }
    if (reason === 'model_error') {
      const error =
        modelErrorOf(entries) ??
        detailText((settled as { readonly detail?: unknown }).detail) ??
        'model call failed (stopReason=error)'
      return { result: extractSpawnResult(entries), error, ...ids }
    }
    const error =
      detailText((settled as { readonly detail?: unknown }).detail) ?? (reason || 'unanswered')
    return { result: extractSpawnResult(entries, error), error, ...ids }
  }

  /** 从 `from`（含）起到末尾的转写，最旧在前；没有起点 = 空 */
  private async entriesSince(
    conversationId: ConversationId,
    from: EntryId | undefined
  ): Promise<EntryRecord[]> {
    if (from === undefined) return []
    const entries = await this.raw(async (tx) => {
      const found: EntryRecord[] = []
      let cursor: Parameters<typeof tx.scanEntries>[2]
      do {
        const page = await tx.scanEntries(
          { conversationId, minEntryId: from },
          SCAN_PAGE_SIZE,
          cursor
        )
        for (const entry of page.items) found.push(entry)
        cursor = page.next
      } while (cursor !== undefined)
      return found
    })
    return entries.reverse()
  }

  /** 只读提交（未包装的 Harness，不开启调度器） */
  private raw<T>(read: (tx: Tx) => Promise<T>): Promise<T> {
    return this.host.raw.commit(read, BG)
  }

  /** 中止子对话（出错收尾 / 捕获后）：失败只记警告 */
  private async abortQuietly(conversationId: ConversationId): Promise<void> {
    try {
      const conversation = await this.host.harness.conversation(conversationId, BG)
      await conversation?.abort(BG)
    } catch (error) {
      if (isClosedError(error)) return
      this.host.logger.warn(
        `session ${this.host.sessionId}: aborting conversation ${conversationId} failed: ${errorText(error)}`
      )
    }
  }

  /**
   * 档案声明的模型（PIN-07）：没声明 / 没有 seam → undefined（不警告）；seam 拒绝 / 抛错 / 解析被拒 →
   * 警告一次、undefined（回落调用方的模型）。
   */
  private async profileModel(profile: InProcessAgentType): Promise<LockModel | undefined> {
    const spec = profile.model
    const resolve = this.host.resolveProfileModel
    if (!spec || resolve === undefined) return undefined
    const fallback = (reason: string): undefined => {
      this.host.logger.warn(
        `agent "${profile.name}" declares model "${spec}", which is unavailable (${reason}); using the calling agent's model`
      )
      return undefined
    }
    let selection: ModelSelection | null | undefined
    try {
      selection = await resolve(spec)
    } catch (error) {
      return fallback(errorText(error))
    }
    if (selection === null || selection === undefined) return fallback('not resolvable')
    const resolution = resolveLockModel(
      this.host.modelCatalog.registry,
      this.host.modelCatalog.port,
      selection
    )
    if (!resolution.ok) return fallback(resolution.kind)
    return resolution.model
  }

  // ─── 面板 ───────────────────────────────────────

  async interrupt(conversationId: number): Promise<void> {
    const child = conversationId as ConversationId
    if (this.host.directory.identity(child)?.kind !== 'spawned') return
    if (this.host.liveTasksOf(child).length === 0) return
    await this.host.op(async () => {
      this.soft.add(child)
      await this.host.stopConversation(child)
    })
  }

  async destroy(conversationId: number): Promise<void> {
    const child = conversationId as ConversationId
    if (this.host.directory.identity(child)?.kind !== 'spawned') return
    await this.host.op(async () => {
      this.soft.delete(child)
      if (this.host.liveTasksOf(child).length > 0) await this.host.stopConversation(child)
      this.host.registry.uninstall({ name: agentExtensionName(child) })
    })
  }

  async continue(conversationId: number, text: string): Promise<SpawnOutcome> {
    const child = conversationId as ConversationId
    const record = this.host.directory.record(child)
    if (record === undefined) {
      const message = `Conversation ${conversationId} is not a spawned agent`
      return { result: message, error: message }
    }
    const ids = { conversationId: child, agentId: record.agentId }
    try {
      return await this.host.op(async () => {
        this.soft.delete(child)
        await this.ensureInstalled(child)
        this.host.reopenInputs()
        const conversation: Conversation | undefined = await this.host.harness.conversation(
          child,
          BG
        )
        if (conversation === undefined) throw new Error(`conversation ${child} does not exist`)
        let submission: Submission
        try {
          submission = await conversation.submit(
            { type: 'input', content: text, whenBusy: 'reject' },
            BG
          )
        } catch (error) {
          if (error instanceof ConversationBusy) {
            const message = `The agent is busy: ${error.message}`
            return { result: message, error: message, ...ids }
          }
          throw error
        }
        const settled = await submission.wait(BG)
        return await this.outcomeOf(child, settled, settled.entry, ids)
      })
    } catch (error) {
      const message = errorText(error)
      return { result: message, error: message, ...ids }
    } finally {
      // 追问前 ensureInstalled 把 hook agent 装回来了：这一轮落定就再卸掉
      if (record.dispatch === 'hook') this.unloadHosted(child)
    }
  }

  /**
   * hook agent 收尾：卸掉它的按 agent 扩展（见文件头「hook agent 用完即卸」）。子对话上还有活任务（忙着拒了
   * 追问的那一轮）就不动 —— 它还在跑；会话已关同样不动（扩展表随句柄一起没了）。从不抛：收尾失败不改派发结果。
   */
  private unloadHosted(child: ConversationId): void {
    try {
      if (this.host.isClosed() || this.host.liveTasksOf(child).length > 0) return
      this.host.registry.uninstall({ name: agentExtensionName(child) })
    } catch (error) {
      this.host.logger.warn(
        `session ${this.host.sessionId}: unloading hook agent conversation ${child} failed: ${errorText(error)}`
      )
    }
  }

  // ─── 重建 ───────────────────────────────────────

  async ensureInstalled(conversationId: number): Promise<void> {
    const child = conversationId as ConversationId
    if (this.host.registry.snapshot().extension(agentExtensionName(child)) !== undefined) return
    const pending = this.installing.get(child)
    if (pending !== undefined) return pending
    const tracked = this.install(child).finally(() => {
      if (this.installing.get(child) === tracked) this.installing.delete(child)
    })
    this.installing.set(child, tracked)
    return tracked
  }

  private async install(child: ConversationId): Promise<void> {
    const record = this.host.directory.record(child)
    if (record === undefined) {
      throw new Error(
        this.host.directory.identity(child)?.kind === 'spawned'
          ? `Conversation ${child} has a malformed spawned agent record`
          : `Conversation ${child} is not a spawned agent`
      )
    }
    await this.rebuild(record)
  }

  /**
   * 按记录重建并装上按 agent 的扩展（附加工具显式拼进去）。子 agent 的内置工具按名从会话的
   * `shuvix.builtin` 解析：还没装（空闲会话打开时不建它）就先装上
   */
  private async rebuild(record: SpawnedAgentRecord): Promise<void> {
    await this.host.ensureBuiltin()
    const extraTools = resultContractTools(record.resultContract)
    const set = await this.host.toolHost.rebuildAgentTools(record, {
      sessionId: this.host.sessionId,
      extraTools
    })
    const composed = composeAgentTools({
      names: record.toolNames,
      builtin: [],
      set,
      extraTools: set.extraTools
    })
    this.host.registry.install(agentExtension(record.conversationId, composed.agentTools))
  }

  /**
   * 打开时（锁重建之后、任何续跑之前，PIN-05）：有活任务的非辅助派生对话按记录重建；重建失败 / 记录
   * 写坏 → 警告、给它的活任务打中止标记（只提交标记，不续跑）。带结果契约的顺带接上捕获观察。
   * 绝不抛出（关停除外）。
   */
  async restoreAtOpen(): Promise<void> {
    const { directory, logger, sessionId } = this.host
    const targets = new Set<ConversationId>()
    for (const id of this.host.liveConversationIds()) {
      if (directory.identity(id)?.kind !== 'spawned' || directory.isAuxiliary(id)) continue
      targets.add(id)
    }
    for (const child of targets) {
      const record = directory.record(child)
      let failure: string | undefined
      if (record === undefined) failure = 'its spawned agent record is malformed'
      else {
        try {
          await this.rebuild(record)
          if (record.resultContract !== undefined) await this.primeWatch(child)
        } catch (error) {
          if (isClosedError(error)) throw error
          failure = `rebuilding its tools failed: ${errorText(error)}`
        }
      }
      if (failure === undefined) continue
      logger.warn(
        `session ${sessionId}: spawned agent conversation ${child} cannot resume (${failure}); its work is aborted`
      )
      for (const task of this.host.liveTasksOf(child)) {
        if (task.abortRequested) continue
        try {
          await this.host.raw.abortTask(task.id, BG)
        } catch (error) {
          if (isClosedError(error)) throw error
          logger.warn(
            `session ${sessionId}: marking task ${task.id} aborted failed: ${errorText(error)}`
          )
        }
      }
    }
  }

  // ─── 捕获观察（PIN-10） ─────────────────────────

  /**
   * 打开时接上一个带契约子对话的捕获观察：从新到旧读到这一轮的 `pi.user` 为止 —— 已经捕获过、这一轮的
   * 工具调用与已落下的结果。
   */
  private async primeWatch(child: ConversationId): Promise<void> {
    const recent = await this.raw(async (tx) => {
      const found: EntryRecord[] = []
      let cursor: Parameters<typeof tx.scanEntries>[2]
      scan: do {
        const page = await tx.scanEntries({ conversationId: child }, SCAN_PAGE_SIZE, cursor)
        for (const entry of page.items) {
          if (entry.kind === UserEntry.kind) break scan
          found.push(entry)
        }
        cursor = page.next
      } while (cursor !== undefined)
      return found.reverse()
    })
    const watch = this.watchOf(child)
    for (const entry of recent) this.noteEntry(watch, entry)
  }

  private watchOf(child: ConversationId): CaptureWatch {
    let watch = this.watches.get(child)
    if (watch === undefined) {
      watch = {
        captured: false,
        calls: undefined,
        generation: undefined,
        results: new Map(),
        aborting: false
      }
      this.watches.set(child, watch)
    }
    return watch
  }

  private noteEntry(watch: CaptureWatch, entry: EntryRecord): void {
    if (entry.kind === UserEntry.kind) {
      watch.captured = false
      watch.calls = undefined
      watch.generation = undefined
      watch.results.clear()
      return
    }
    const assistant = assistantOf(entry)
    if (assistant !== undefined) {
      const calls = assistant.content.filter((part): part is ToolCall => part.type === 'toolCall')
      watch.calls = new Map(calls.map((call) => [call.id, call.name]))
      watch.generation = entry.byTaskId
      watch.results.clear()
      return
    }
    if (!ToolResultEntry.is(entry)) return
    const message = entry.model?.[0]
    if (message?.role !== 'toolResult') return
    if (nextResultOf(entry) !== undefined) watch.captured = true
    if (watch.calls?.has(message.toolCallId)) {
      watch.results.set(message.toolCallId, message.toolName === NEXT_TOOL_NAME && !message.isError)
    }
  }

  /** 捕获之后这一轮还会接着跑吗：有别的工具（混批），或整批落齐却有一条 `next` 没成功（不会 terminate） */
  private runsOn(watch: CaptureWatch): boolean {
    if (!watch.captured || watch.calls === undefined) return false
    for (const name of watch.calls.values()) if (name !== NEXT_TOOL_NAME) return true
    if (watch.results.size < watch.calls.size) return false
    for (const ok of watch.results.values()) if (!ok) return true
    return false
  }

  /**
   * 一次提交发布里的变化（同步，在 Session 串行线上；目录已经按这次发布更新过）：带契约的子对话里的
   * 条目，以及新一轮生成。一次发布里的变化次序不定 —— 条目先处理（新的 `pi.user` 重置观察），再看任务。
   */
  observe(changes: readonly CommitChange[]): void {
    for (const change of changes) {
      if (change.type !== 'entry') continue
      const conversationId = change.value.conversationId
      if (this.host.directory.record(conversationId)?.resultContract === undefined) continue
      const watch = this.watchOf(conversationId)
      this.noteEntry(watch, change.value)
      if (this.runsOn(watch)) this.abortSoon(conversationId, watch)
    }
    for (const change of changes) {
      if (change.type !== 'task') continue
      const record = change.value
      if (record.kind !== GENERATION_TASK_KIND || record.state.status !== 'pending') continue
      const watch = this.watches.get(record.conversationId)
      // 兜底：捕获之后又起了新的一轮生成（不是发出这一轮的那个）
      if (watch?.captured === true && record.id !== watch.generation) {
        this.abortSoon(record.conversationId, watch)
      }
    }
  }

  private abortSoon(conversationId: ConversationId, watch: CaptureWatch): void {
    if (watch.aborting) return
    watch.aborting = true
    queueMicrotask(() => {
      void this.abortQuietly(conversationId).finally(() => {
        watch.aborting = false
      })
    })
  }
}
