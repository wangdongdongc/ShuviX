/**
 * 目标模式的宿主侧（docs/goal-mode-design.md）：把 agent-runtime 的目标状态机接到运行结束、判定型埋点 `goal.check`、
 * 自动续跑与界面上。
 *
 * 一条会话的生命线：
 *  1. 用户 `/goal <条件>` → `act(set)`：建目标记录（`GoalDoc`），以人的来源发出那条消息（原文 + 「目标」Token）；
 *     消息末尾的说明让干活的 agent 第一轮先把目标整理成验收规格（只问用户自己才能定的事，写一份 md，回复里一行
 *     `Acceptance spec: <路径>`），再开工 —— 只靠提示词，宿主不派别的 agent、不设卡点（§15）；
 *  2. 每次根运行结束（会话信号的 `ended`，`onRootRunEnded`）→ 目标还没有规格文件就从这期间的回复里认一次
 *     （`pickUpSpec`）→ `afterRun` 决定暂停 / 等后台工作 / 判定；
 *  3. 判定（`hookTriggers.decide('goal.check')`，内置 goal-check → goal-judge）→ `applyVerdict` 决定续跑 / 结束 / 暂停；
 *  4. 续跑 = `notify(<goal-continue>, { resume: 'goal' })`：走自动续跑那条路，起下一轮；结局 = 写一条 `<goal-status>`
 *     通知（不起轮）+ 系统通知。
 *
 * 宿主规则（§4–§8）：
 *  - 同一会话的目标操作串行（`serial`）；用户的暂停 / 清除 / 编辑先中止在途的判定，判定回来发现被中止就丢掉结论；
 *  - 后台工作（后台 bash、在跑的子会话）没跑完不判定：它们的完成通知会起一轮；等太久（30 分钟起，翻倍到 2 小时）
 *    写一条检查通知让 agent 看看；
 *  - 预算在运行中也查（会话事件节流到每 10 秒一次）：越线就暂停并 steer 一条收尾通知；
 *  - 启动时（`sweepOnStartup`）进行中的目标：会话空闲 → 暂停（restart）；会话被中断 → 不动，等用户点继续；
 *  - 进行中 / 暂停中的会话记在设置 `goal.sessions`（会话 id → 状态）：侧栏徽标、启动扫描、通知的「目标进行中」都读它，
 *    不用打开每条会话的存储。
 */
import {
  afterRun,
  applyVerdict,
  budgetCrossed,
  createGoal,
  editGoal,
  goalRecordOf,
  mergeLimits,
  pauseGoal,
  readGoal,
  renderGoalBudget,
  renderGoalCheckin,
  renderGoalContinue,
  renderGoalResumed,
  renderGoalStatus,
  renderGoalUpdated,
  resumeBlockedBy,
  resumeGoal,
  sessionCostUsd,
  updateGoal,
  type DurableSession,
  type GoalStatusEvent
} from '@shuvix/agent-runtime'
import { goalSetMessage, lastAcceptanceSpecPath } from '@shuvix/chat-protocol/goalSet'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { chromeTabOf } from '@shuvix/chat-protocol/chromeTabSession'
import {
  DEFAULT_GOAL_LIMITS,
  GOAL_OBJECTIVE_MAX_CHARS,
  goalActiveMs,
  isGoalAction,
  type GoalAction,
  type GoalLimits,
  type GoalLimitsPatch,
  type GoalPauseReason,
  type GoalRecord,
  type GoalStatus,
  type GoalVerdict,
  type GoalView
} from '@shuvix/chat-protocol/types/goal'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import type { GoalCheckPayload } from '@shuvix/agent-runtime'
import type { JsonObject } from '@earendil-works/pi-durable'
import { randomUUID } from 'crypto'
import { statSync } from 'fs'
import { normalize as normalizePath } from 'path'
import { resolveProjectConfig } from './toolContext'
import { resolveToCwd } from '../utils/toolUtils/pathUtils'
import { chatFrontendRegistry } from '../frontend/core'
import { t } from '../i18n'
import { createLogger } from '../logger'
import { hookService, hookTriggers } from './hookService'
import { notifyGoalEnded } from './notificationService'
import { sessionRecords } from './sessionRecords'
import { getSessionHost } from './sessionHost'
import { sessionService } from './sessionService'
import { sessionSignalsReady } from './sessionSignalSeams'
import { settingsService } from './settingsService'
import { taskRegistry } from './taskRegistry'
import { readSessionTranscript } from './transcriptSource'

const log = createLogger('Goal')

/** 进行中 / 暂停中的会话（会话 id → 状态）—— 终态与没有目标的不记 */
export const GOAL_SESSIONS_SETTING = 'goal.sessions'
/** 新目标的缺省上限（设置页可改；`off` = 不限花费） */
export const GOAL_DEFAULT_COST_SETTING = 'goal.defaultCostUsd'
export const GOAL_DEFAULT_TURNS_SETTING = 'goal.defaultMaxTurns'
export const GOAL_STALL_TURNS_SETTING = 'goal.stallTurns'

/** 后台工作等了多久写第一条检查通知；之后每次翻倍，最多到 4 倍（Claude Code 的退避） */
const CHECKIN_FIRST_MS = 30 * 60_000
const CHECKIN_MAX_FACTOR = 4
/** 运行中查预算的间隔 */
const BUDGET_CHECK_INTERVAL_MS = 15_000

/** payload 的截断 */
const MAX_TOOL_CALLS = 40
const MAX_SUMMARY = 200
const MAX_OUTPUT_TAIL = 1500
const MAX_ASSISTANT_TEXT = 3000
const MAX_USER_MESSAGES = 10
const MAX_USER_TEXT = 1500
const MAX_VERDICT_REASON = 500
const MAX_VERDICT_NEXT_STEP = 300

export interface GoalServiceDeps {
  now(): number
  /** 检查通知的首个间隔（测试缩短） */
  checkinFirstMs?: number
  /** 运行中查预算的间隔（测试缩短） */
  budgetCheckMs?: number
}

export type GoalActResult = { ok: true } | { ok: false; error: string }

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text
}

function finitePositive(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** 一条工具调用的参数摘要：命令首行 / 路径 / 参数 JSON（截断） */
function argsSummary(args: Record<string, unknown> | undefined): string {
  if (args === undefined) return ''
  for (const key of ['command', 'path', 'file_path', 'pattern', 'url', 'query']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return clip(value.trim().split('\n')[0], MAX_SUMMARY)
    }
  }
  try {
    return clip(JSON.stringify(args), MAX_SUMMARY)
  } catch {
    return ''
  }
}

interface RunFacts {
  toolCalls: number
  toolSucceeded: number
  lastRun: GoalCheckPayload['lastRun']
}

/** 判定时点之后的消息里宿主记下的事实（§4.3）：工具调用、写过的文件、助手最后的正文 */
export function runFactsOf(messages: readonly ChatMessage[], since: number): RunFacts {
  const toolCalls: GoalCheckPayload['lastRun']['toolCalls'] = []
  const filesWritten = new Set<string>()
  let succeeded = 0
  let total = 0
  let assistantText = ''
  for (const message of messages) {
    if (message.role !== 'assistant' || message.createdAt < since) continue
    if (typeof message.content === 'string' && message.content.trim() !== '') {
      assistantText = message.content
    }
    for (const block of message.blocks ?? []) {
      if (block.type !== 'tool') continue
      total += 1
      const details = block.details as { type?: string; exitCode?: unknown } | undefined
      const exitCode =
        details && (details.type === 'bash' || details.type === 'powershell')
          ? details.exitCode
          : undefined
      const failed =
        block.isError === true ||
        block.result === undefined ||
        (typeof exitCode === 'number' && exitCode !== 0)
      if (!failed) succeeded += 1
      if ((details?.type === 'write' || details?.type === 'edit') && !block.isError) {
        const path = block.args?.path ?? block.args?.file_path
        if (typeof path === 'string') filesWritten.add(path)
      }
      const result = typeof block.result === 'string' ? block.result : ''
      toolCalls.push({
        tool: block.toolName,
        summary: argsSummary(block.args),
        outcome: failed ? 'error' : 'ok',
        ...(result !== '' ? { outputTail: tail(result, MAX_OUTPUT_TAIL) } : {}),
        ...(block.spill?.path ? { outputPath: block.spill.path } : {})
      })
    }
  }
  return {
    toolCalls: total,
    toolSucceeded: succeeded,
    lastRun: {
      assistantText: tail(assistantText, MAX_ASSISTANT_TEXT),
      toolCalls: toolCalls.slice(-MAX_TOOL_CALLS),
      filesWritten: [...filesWritten]
    }
  }
}

/**
 * 设定之后（`since` 起）助手回复里最后一行 `Acceptance spec: <路径>` 点名的路径（原样，未解析）。逐个正文块看 ——
 * `content` 是各块直接拼起来的，块与块之间未必有换行。
 */
export function specPathNamedIn(
  messages: readonly ChatMessage[],
  since: number
): string | undefined {
  let named: string | undefined
  for (const message of messages) {
    if (message.role !== 'assistant' || message.createdAt < since) continue
    const texts = (message.blocks ?? [])
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
    for (const text of texts.length > 0 ? texts : [message.content]) {
      named = lastAcceptanceSpecPath(text) ?? named
    }
  }
  return named
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 判定 / 结局的一句人话（系统通知正文） */
function outcomeText(goal: GoalRecord, event: GoalStatusEvent): string {
  switch (event.event) {
    case 'met':
      return t('goal.notifyMet', { reason: event.reason })
    case 'impossible':
      return t('goal.notifyImpossible', { reason: event.reason })
    case 'paused':
      return t(`goal.pause.${event.reason}`)
    default:
      return goal.objective
  }
}

/** 暂停的原因里哪些值得弹系统通知：用户自己按的不弹 */
function pauseNotifies(reason: GoalPauseReason): boolean {
  // 出错那一轮已经弹过「运行失败」，不再弹第二条
  return reason !== 'user' && reason !== 'stopped' && reason !== 'forked' && reason !== 'run-error'
}

function validObjective(objective: string): boolean {
  const trimmed = objective.trim()
  return trimmed !== '' && trimmed.length <= GOAL_OBJECTIVE_MAX_CHARS
}

export class GoalService {
  private readonly deps: GoalServiceDeps
  /** 同一会话的目标操作串行 */
  private readonly serial = new Map<string, Promise<unknown>>()
  /** 在途的判定（用户操作先中止它） */
  private readonly judging = new Map<string, AbortController>()
  /** 等后台工作时的检查计时器 */
  private readonly checkins = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; delayMs: number; since: number }
  >()
  /** 会话正忙时攒下的结局通知（这一轮结束时写） */
  private readonly pendingStatus = new Map<string, Array<{ text: string; requestId: string }>>()
  /** 运行中查预算的计时器（根运行开始时起，结束时停） */
  private readonly budgetTimers = new Map<string, ReturnType<typeof setInterval>>()
  private statusCache: Record<string, GoalStatus> | undefined

  constructor(deps: GoalServiceDeps) {
    this.deps = deps
  }

  // ─── 状态表（设置 goal.sessions） ─────────────────────────

  statuses(): Record<string, GoalStatus> {
    if (this.statusCache === undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(settingsService.get(GOAL_SESSIONS_SETTING) ?? '{}')
      } catch {
        parsed = {}
      }
      const out: Record<string, GoalStatus> = {}
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [id, status] of Object.entries(parsed as Record<string, unknown>)) {
          if (status === 'active' || status === 'paused') out[id] = status
        }
      }
      this.statusCache = out
    }
    return { ...this.statusCache }
  }

  /** 有进行中的目标（通知判定「完成」时读，同步） */
  isActive(sessionId: string): boolean {
    return this.statuses()[sessionId] === 'active'
  }

  private recordStatus(sessionId: string, goal: GoalRecord | undefined): void {
    this.recordStatusValue(sessionId, goal?.status)
  }

  private recordStatusValue(sessionId: string, status: GoalStatus | undefined): void {
    const current = this.statuses()
    if (status === 'active' || status === 'paused') {
      if (current[sessionId] === status) return
      current[sessionId] = status
    } else {
      if (current[sessionId] === undefined) return
      delete current[sessionId]
    }
    this.statusCache = current
    settingsService.set(GOAL_SESSIONS_SETTING, JSON.stringify(current))
  }

  // ─── 通用 ───────────────────────────────────────────

  private queue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(sessionId) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.catch(() => undefined)
    this.serial.set(sessionId, settled)
    void settled.then(() => {
      if (this.serial.get(sessionId) === settled) this.serial.delete(sessionId)
    })
    return next
  }

  /** 中止在途的判定；回有没有中止到 */
  private abortJudging(sessionId: string): boolean {
    const controller = this.judging.get(sessionId)
    controller?.abort()
    this.judging.delete(sessionId)
    return controller !== undefined
  }

  private clearCheckin(sessionId: string): void {
    const entry = this.checkins.get(sessionId)
    if (entry !== undefined) clearTimeout(entry.timer)
    this.checkins.delete(sessionId)
  }

  /** 设置里的缺省上限 */
  defaultLimits(): GoalLimits {
    const costRaw = settingsService.get(GOAL_DEFAULT_COST_SETTING)
    const cost =
      costRaw?.trim() === 'off'
        ? undefined
        : (finitePositive(costRaw) ?? DEFAULT_GOAL_LIMITS.costUsd)
    return {
      ...(cost !== undefined ? { costUsd: cost } : {}),
      maxTurns: Math.max(
        1,
        Math.round(
          finitePositive(settingsService.get(GOAL_DEFAULT_TURNS_SETTING)) ??
            DEFAULT_GOAL_LIMITS.maxTurns
        )
      ),
      stallTurns: Math.max(
        1,
        Math.round(
          finitePositive(settingsService.get(GOAL_STALL_TURNS_SETTING)) ??
            DEFAULT_GOAL_LIMITS.stallTurns
        )
      )
    }
  }

  /** 目标期间的花费：会话自己的增量 + 目标期间新建的子会话的全部 */
  private async goalCost(session: DurableSession, goal: GoalRecord): Promise<number> {
    let cost = Math.max(0, (await sessionCostUsd(session.harness)) - goal.baselineCostUsd)
    for (const child of sessionRecords.findChildren(session.sessionId)) {
      if (child.createdAt < goal.setAt) continue
      try {
        const opened = await getSessionHost().peek(child.id)
        if (opened !== undefined) cost += await sessionCostUsd(opened.harness)
      } catch (error) {
        log.warn(`读子会话花费失败 session=${child.id}: ${String(error)}`)
      }
    }
    return cost
  }

  private checkerMissing(): boolean {
    try {
      return hookService.agentsBoundTo('goal.check').size === 0
    } catch {
      return false
    }
  }

  private async viewOf(
    session: DurableSession,
    goal: GoalRecord | undefined
  ): Promise<GoalView | null> {
    if (goal === undefined) return null
    return {
      ...goal,
      sessionId: session.sessionId,
      costUsd: await this.goalCost(session, goal),
      judging: this.judging.has(session.sessionId),
      checkerMissing: this.checkerMissing()
    }
  }

  private async broadcast(session: DurableSession, goal: GoalRecord | undefined): Promise<void> {
    this.recordStatus(session.sessionId, goal)
    try {
      chatFrontendRegistry.broadcast({
        type: 'goal',
        sessionId: session.sessionId,
        goal: await this.viewOf(session, goal)
      })
    } catch (error) {
      log.warn(`目标广播失败 session=${session.sessionId}: ${String(error)}`)
    }
  }

  /**
   * 写一条目标结局通知（不起轮）。会话正忙（用户在一轮中途暂停 / 清除 / 换目标）：不 steer 进当前轮 —— 那会让 agent 为了
   * 回应它多跑一次模型（e2e 截图里看到的多出来的一轮）—— 先攒着，这一轮结束时再写（`flushPendingStatus`）。
   */
  private async writeStatus(
    session: DurableSession,
    goal: GoalRecord,
    event: GoalStatusEvent
  ): Promise<void> {
    const text = renderGoalStatus(goal, event)
    const requestId = `goal:${goal.id}:status:${event.event}:${this.deps.now()}`
    if (session.isBusy()) {
      const pending = this.pendingStatus.get(session.sessionId) ?? []
      pending.push({ text, requestId })
      this.pendingStatus.set(session.sessionId, pending)
      return
    }
    await session.notify(text, { kind: 'goal-status', resume: 'never', requestId })
  }

  /** 一轮结束：攒着的结局通知写进转写（只写，不起轮） */
  private async flushPendingStatus(sessionId: string): Promise<void> {
    const pending = this.pendingStatus.get(sessionId)
    if (pending === undefined) return
    this.pendingStatus.delete(sessionId)
    const session = getSessionHost().get(sessionId)
    if (session === undefined || session.closed) return
    for (const notice of pending) {
      await session.notify(notice.text, {
        kind: 'goal-status',
        resume: 'never',
        requestId: notice.requestId
      })
    }
  }

  private async paused(
    session: DurableSession,
    goal: GoalRecord,
    reason: GoalPauseReason
  ): Promise<void> {
    this.clearCheckin(session.sessionId)
    await this.writeStatus(session, goal, { event: 'paused', reason })
    await this.broadcast(session, goal)
    if (pauseNotifies(reason)) {
      notifyGoalEnded(session.sessionId, outcomeText(goal, { event: 'paused', reason }))
    }
  }

  // ─── 读 ─────────────────────────────────────────────

  async get(sessionId: string): Promise<GoalView | null> {
    const session = await getSessionHost().peek(sessionId)
    if (session === undefined) return null
    return this.viewOf(session, await readGoal(session.harness))
  }

  /** 这条会话能不能设目标（裁决 D9：人发起的根会话；不含子会话、bot、笔记本、Chrome 标签页） */
  eligible(sessionId: string): boolean {
    const record = sessionRecords.pick(sessionId, ['parentId', 'settings'])
    if (record === undefined) return false
    if (record.parentId) return false
    const settings = record.settings ?? {}
    if (settings.bot || settings.notebookPath || chromeTabOf(settings)) return false
    return !sessionRecords.isEphemeral(sessionId)
  }

  // ─── 用户操作 ─────────────────────────────────────────

  /** 前端的操作；`origin` = 网关按这次操作的连接盖的章（设定目标那条消息的来源） */
  act(sessionId: string, action: GoalAction, origin?: InputOrigin): Promise<GoalActResult> {
    // 参数来自前端（含网络客户端）：形状不对就拒，什么也不写、也不中止在途的判定
    if (!isGoalAction(action))
      return Promise.resolve({ ok: false, error: t('goal.errorInvalidAction') })
    // 会换掉「谁在推这个目标」的操作才中止在途的判定（否则它要在队列里等判定最多 60 秒）：暂停、清除、换目标、改原文。
    // 只改上限、恢复不中止 —— 判定照常回来。被中止的判定回来就丢掉结论；中止了却没起新的一轮，由 actNow 补判一次
    const abortedJudge = this.abortsJudge(sessionId, action) && this.abortJudging(sessionId)
    return this.queue(sessionId, async () => {
      try {
        return await this.actNow(sessionId, action, origin, abortedJudge)
      } catch (error) {
        log.warn(`目标操作失败 session=${sessionId} type=${action.type}: ${String(error)}`)
        return { ok: false, error: String(error instanceof Error ? error.message : error) }
      }
    })
  }

  /** 这个操作会不会换掉推目标的人（校验不过的设定 / 改写不算：它们什么也不改） */
  private abortsJudge(sessionId: string, action: GoalAction): boolean {
    switch (action.type) {
      case 'pause':
      case 'clear':
        return true
      case 'set':
        return validObjective(action.objective) && this.eligible(sessionId)
      case 'edit':
        return action.objective !== undefined && validObjective(action.objective)
      default:
        return false
    }
  }

  /**
   * 中止了在途的判定、操作本身却没起新的一轮（改写成同样的原文、设定被拒后放回旧目标）：目标还在进行中而会话空闲 ——
   * 没有任何东西会推它，就地补判一次
   */
  private async rejudgeIfStranded(sessionId: string, abortedJudge: boolean): Promise<void> {
    if (!abortedJudge) return
    const session = getSessionHost().get(sessionId)
    if (session === undefined || session.closed || session.isBusy() || session.isInterrupted())
      return
    await this.afterRunNow(sessionId, 'ok')
  }

  private async actNow(
    sessionId: string,
    action: GoalAction,
    origin: InputOrigin | undefined,
    abortedJudge: boolean
  ): Promise<GoalActResult> {
    if (action.type === 'set') {
      return this.setGoal(sessionId, action.objective, action.limits, origin, abortedJudge)
    }
    const session = await getSessionHost().peek(sessionId)
    if (session === undefined) return { ok: false, error: t('goal.errorNoGoal') }
    const now = this.deps.now()
    const before = await readGoal(session.harness)
    if (before === undefined) return { ok: false, error: t('goal.errorNoGoal') }
    switch (action.type) {
      case 'pause': {
        const goal = await updateGoal(session.harness, (g) => (g ? pauseGoal(g, 'user', now) : g))
        if (goal?.status === 'paused' && before.status === 'active')
          await this.paused(session, goal, 'user')
        return { ok: true }
      }
      case 'clear': {
        await updateGoal(session.harness, () => undefined)
        this.clearCheckin(sessionId)
        await this.writeStatus(session, before, { event: 'cleared' })
        await this.broadcast(session, undefined)
        return { ok: true }
      }
      case 'edit': {
        // 已经结束的目标不能改（界面给「沿用原文设新目标」）
        if (before.status !== 'active' && before.status !== 'paused') {
          return { ok: false, error: t('goal.errorEnded') }
        }
        const objective = action.objective?.trim()
        if (objective !== undefined && !validObjective(objective)) {
          return {
            ok: false,
            error: t('goal.errorObjectiveLength', { max: GOAL_OBJECTIVE_MAX_CHARS })
          }
        }
        const masked =
          objective === undefined ? undefined : await this.maskObjective(sessionId, objective)
        const goal = await updateGoal(session.harness, (g) =>
          g
            ? editGoal(g, {
                ...(masked !== undefined ? { objective: masked } : {}),
                ...(action.limits ? { limits: action.limits } : {})
              })
            : g
        )
        if (goal === undefined) return { ok: false, error: t('goal.errorNoGoal') }
        const changed = masked !== undefined && masked !== before.objective
        if (changed) {
          // 进行中：忙时 steer 进当前轮、空闲时起一轮接着干（用户亲手改的 = 同意接着干）；暂停中：只写，恢复时再说
          if (goal.status === 'active') session.allowAutoResume()
          await session.notify(renderGoalUpdated(goal), {
            kind: 'goal-updated',
            resume: goal.status === 'active' ? 'goal' : 'never',
            requestId: `goal:${goal.id}:updated:${now}`
          })
        }
        await this.broadcast(session, goal)
        if (!changed) await this.rejudgeIfStranded(sessionId, abortedJudge)
        return { ok: true }
      }
      case 'resume': {
        if (before.status !== 'paused') return { ok: true }
        const cost = await this.goalCost(session, before)
        // 恢复之后仍撞着的上限（预算、轮数、时长）：不恢复，请用户先调高 —— 否则白跑一整轮再暂停
        const blocked = resumeBlockedBy(before, { costUsd: cost, now })
        if (blocked !== undefined) return { ok: false, error: t(`goal.resumeBlocked.${blocked}`) }
        const goal = await updateGoal(session.harness, (g) =>
          g?.id === before.id ? resumeGoal(g, now) : g
        )
        if (goal?.status !== 'active') return { ok: true }
        // 用户亲手点的继续：撤掉之前「显式喊停」的收敛，续跑才起得了轮
        session.allowAutoResume()
        await this.broadcast(session, goal)
        // 空闲：起一轮接着干，跑完照常判定；忙 / 中断：等那一轮（中断的等用户点继续）
        if (!session.isBusy() && !session.isInterrupted()) {
          await session.notify(renderGoalResumed(goal, cost), {
            kind: 'goal-continue',
            resume: 'goal',
            requestId: `goal:${goal.id}:resumed:${now}`
          })
        }
        return { ok: true }
      }
    }
  }

  private async maskObjective(sessionId: string, objective: string): Promise<string> {
    const agent = await sessionService.ensureAgentSession(sessionId)
    if (agent === undefined) return objective
    return (await agent.maskTexts([objective]))[0] ?? objective
  }

  private async setGoal(
    sessionId: string,
    rawObjective: string,
    limitsPatch: GoalLimitsPatch | undefined,
    origin: InputOrigin | undefined,
    abortedJudge: boolean
  ): Promise<GoalActResult> {
    const objective = rawObjective.trim()
    if (!validObjective(objective)) {
      return { ok: false, error: t('goal.errorObjectiveLength', { max: GOAL_OBJECTIVE_MAX_CHARS }) }
    }
    if (!this.eligible(sessionId)) return { ok: false, error: t('goal.errorNotEligible') }
    const agent = await sessionService.ensureAgentSession(sessionId)
    if (agent === undefined) return { ok: false, error: t('goal.errorNoGoal') }
    const session = agent.durable
    this.abortJudging(sessionId)
    this.clearCheckin(sessionId)
    const masked = (await agent.maskTexts([objective]))[0] ?? objective
    const now = this.deps.now()
    const previous = await readGoal(session.harness)
    const goal = createGoal({
      id: `g_${randomUUID().slice(0, 8)}`,
      objective: masked,
      limits: mergeLimits(this.defaultLimits(), limitsPatch),
      baselineCostUsd: await sessionCostUsd(session.harness),
      now
    })
    await updateGoal(session.harness, () => goal)
    await this.broadcast(session, goal)
    // 说明里让 agent 第一轮先整理验收规格（§15）：发出去就返回 —— 它的询问卡片在那一轮里等人，不挂住这次操作
    const message = goalSetMessage({ objective: masked, goalId: goal.id })
    // 会话信号先就绪：投影句柄挂上之前开跑的一轮没有 ended，目标就收不到运行结束
    await sessionSignalsReady(sessionId)
    // 用户亲手设的目标 = 同意接着干：撤掉之前「显式喊停」的收敛（插话本身不撤它）
    session.allowAutoResume()
    // 空闲时起一轮，忙时汇入当前轮（目标从这一刻起生效）
    const result = await agent.admitSteer(message.text, {
      display: message.display as unknown as JsonObject,
      ...(origin !== undefined ? { source: origin } : {})
    })
    if (result.error) {
      // 没发出去：旧目标原样放回（被替换之前它是什么样就是什么样）
      const restored = await updateGoal(session.harness, (g) => (g?.id === goal.id ? previous : g))
      await this.broadcast(session, restored)
      if (restored?.status === 'active') await this.rejudgeIfStranded(sessionId, abortedJudge)
      return { ok: false, error: result.error }
    }
    if (previous !== undefined && (previous.status === 'active' || previous.status === 'paused')) {
      await this.writeStatus(session, previous, { event: 'replaced' })
    }
    return { ok: true }
  }

  // ─── 运行结束 → 判定 → 续跑 ────────────────────────────

  /** 根运行结束（会话信号的 `ended`，派生 agent 的不进来） */
  onRootRunEnded(sessionId: string, reason: 'ok' | 'aborted' | 'error'): void {
    this.stopBudgetTimer(sessionId)
    if (this.pendingStatus.has(sessionId)) {
      void this.queue(sessionId, () => this.flushPendingStatus(sessionId)).catch((error: unknown) =>
        log.warn(`写目标结局通知失败 session=${sessionId}: ${String(error)}`)
      )
    }
    if (this.statuses()[sessionId] !== 'active') return
    void this.queue(sessionId, () => this.afterRunNow(sessionId, reason)).catch((error: unknown) =>
      log.warn(`目标运行结束处理失败 session=${sessionId}: ${String(error)}`)
    )
  }

  private async afterRunNow(sessionId: string, reason: 'ok' | 'aborted' | 'error'): Promise<void> {
    const session = getSessionHost().get(sessionId)
    if (session === undefined || session.closed) return
    const read = await readGoal(session.harness)
    if (read === undefined || read.status !== 'active') return
    // 又起了一轮（排队的消息、刚到的通知）或者被中断了：等那一轮
    if (session.isBusy() || session.isInterrupted()) return
    const now = this.deps.now()
    const { messages } = await session.viewSnapshot()
    const goal = await this.pickUpSpec(session, read, messages)
    // 上一次判定所依据的事实截止到哪，这一次就从哪往后看（判定途中开跑的一轮不会漏）
    const since = Math.max(goal.setAt, goal.lastVerdict?.at ?? 0)
    const facts = runFactsOf(messages, since)
    const costUsd = await this.goalCost(session, goal)
    const backgroundWork =
      taskRegistry.runningCount(sessionId, 'bash') +
        taskRegistry.runningCount(sessionId, 'sub-session') >
      0
    const decision = afterRun(goal, {
      outcome: reason,
      backgroundWork,
      toolCalls: facts.toolCalls,
      toolSucceeded: facts.toolSucceeded,
      costUsd,
      now
    })
    switch (decision.action) {
      case 'none':
        return
      case 'wait':
        this.scheduleCheckin(sessionId)
        return
      case 'pause': {
        const written = await updateGoal(session.harness, (g) =>
          g?.id === goal.id ? decision.goal : g
        )
        if (written?.status === 'paused') await this.paused(session, written, decision.reason)
        return
      }
      case 'judge':
        this.clearCheckin(sessionId)
        await this.judge(session, decision.goal, facts, costUsd, {
          noProgress: decision.noProgress,
          factsAt: now
        })
        return
    }
  }

  /**
   * 验收规格文件（§15）：目标还没有 `specPath` 时，从设定之后的助手回复里找**最后**一行 `Acceptance spec: <路径>`
   * （相对路径按会话的工作目录解析，`~` 展开），文件在就记下（绝对路径）并广播。找不到 / 文件不在 → 没有规格，什么也不挡。
   * 记下之后不再自动改（干活的 agent 改的是文件内容，判定每次读它此刻的样子）。
   */
  private async pickUpSpec(
    session: DurableSession,
    goal: GoalRecord,
    messages: readonly ChatMessage[]
  ): Promise<GoalRecord> {
    if (goal.specPath) return goal
    const named = specPathNamedIn(messages, goal.setAt)
    if (named === undefined) return goal
    const sessionId = session.sessionId
    // 与文件工具同一套解析（`~`、相对工作目录）：它用 write 写下的路径怎么写，这里就怎么认
    const absolute = normalizePath(
      resolveToCwd(named, resolveProjectConfig(sessionId).workingDirectory)
    )
    if (!isFile(absolute)) {
      log.warn(`回复里点名的验收规格文件不在 session=${sessionId}: ${absolute}`)
      return goal
    }
    const written = await updateGoal(session.harness, (g) =>
      g?.id === goal.id && !g.specPath ? { ...g, specPath: absolute } : g
    )
    if (written?.id !== goal.id || written.specPath !== absolute) return goal
    await this.broadcast(session, written)
    return written
  }

  private async judge(
    session: DurableSession,
    goal: GoalRecord,
    facts: RunFacts,
    costUsd: number,
    run: { noProgress: boolean; factsAt: number }
  ): Promise<void> {
    const sessionId = session.sessionId
    const controller = new AbortController()
    this.judging.set(sessionId, controller)
    await this.broadcast(session, goal)
    let verdict: GoalVerdict | null = null
    try {
      const payload = await this.payloadOf(session, goal, facts, costUsd)
      const decision = await hookTriggers.decide('goal.check', payload, {
        signal: controller.signal
      })
      verdict = decision?.result ?? null
      // 设计稿的长度上限（§4.2）：理由 500 字、下一步 300 字 —— 它们会进续跑消息与目标栏
      if (verdict !== null) {
        verdict = {
          verdict: verdict.verdict,
          reason: clip(verdict.reason, MAX_VERDICT_REASON),
          ...(verdict.next_step !== undefined
            ? { next_step: clip(verdict.next_step, MAX_VERDICT_NEXT_STEP) }
            : {})
        }
      }
    } catch (error) {
      log.warn(`目标判定失败 session=${sessionId}: ${String(error)}`)
      verdict = null
    } finally {
      if (this.judging.get(sessionId) === controller) this.judging.delete(sessionId)
    }
    // 判定途中被用户暂停 / 清除 / 编辑 / 换了目标：结论作废
    if (controller.signal.aborted) return
    const current = await readGoal(session.harness)
    if (current === undefined || current.id !== goal.id || current.status !== 'active') {
      await this.broadcast(session, current)
      return
    }
    const now = this.deps.now()
    const outcome = applyVerdict(current, verdict, {
      costUsd,
      now,
      noProgress: run.noProgress,
      at: run.factsAt
    })
    switch (outcome.action) {
      case 'none':
        await this.broadcast(session, current)
        return
      case 'continue': {
        const written = await updateGoal(session.harness, (g) =>
          g?.id === goal.id ? outcome.goal : g
        )
        if (written?.status !== 'active') return
        await this.broadcast(session, written)
        await session.notify(
          renderGoalContinue(written, costUsd, {
            reason: written.lastVerdict?.reason ?? '',
            ...(written.lastVerdict?.nextStep ? { nextStep: written.lastVerdict.nextStep } : {})
          }),
          {
            kind: 'goal-continue',
            resume: 'goal',
            requestId: `goal:${written.id}:continue:${written.turns}`
          }
        )
        return
      }
      case 'finish': {
        const written = await updateGoal(session.harness, (g) =>
          g?.id === goal.id ? outcome.goal : g
        )
        if (written === undefined) return
        const event: GoalStatusEvent = {
          event: written.status === 'met' ? 'met' : 'impossible',
          reason: written.lastVerdict?.reason ?? ''
        }
        await this.writeStatus(session, written, event)
        await this.broadcast(session, written)
        notifyGoalEnded(sessionId, outcomeText(written, event))
        return
      }
      case 'pause': {
        const written = await updateGoal(session.harness, (g) =>
          g?.id === goal.id ? outcome.goal : g
        )
        if (written?.status === 'paused') await this.paused(session, written, outcome.reason)
        return
      }
    }
  }

  private async payloadOf(
    session: DurableSession,
    goal: GoalRecord,
    facts: RunFacts,
    costUsd: number
  ): Promise<GoalCheckPayload> {
    const sessionId = session.sessionId
    const title = sessionRecords.pick(sessionId, ['title'])?.title ?? ''
    let userMessages: GoalCheckPayload['userMessages'] = []
    try {
      userMessages = (await readSessionTranscript(sessionId))
        .filter(
          (item): item is Extract<typeof item, { kind: 'user' }> =>
            item.kind === 'user' && !item.source && item.ts > goal.setAt
        )
        .map((item) => ({ text: clip(item.text, MAX_USER_TEXT), at: item.ts }))
        .filter((item) => item.text.trim() !== '' && !item.text.startsWith(goal.objective))
        .slice(-MAX_USER_MESSAGES)
    } catch (error) {
      log.warn(`读目标期间的用户消息失败 session=${sessionId}: ${String(error)}`)
    }
    return {
      sessionId,
      profileName: sessionService.resolveAgentProfileName(sessionId),
      title,
      isDefaultTitle: false,
      goal: {
        id: goal.id,
        objective: goal.objective,
        turns: goal.turns,
        costUsd: Math.round(costUsd * 100) / 100,
        limits: goal.limits,
        activeMinutes: Math.round(goalActiveMs(goal, this.deps.now()) / 60_000),
        ...(goal.specPath ? { specPath: goal.specPath } : {})
      },
      userMessages,
      ...(goal.lastVerdict !== undefined
        ? {
            previousVerdict: {
              verdict: goal.lastVerdict.verdict,
              reason: goal.lastVerdict.reason,
              ...(goal.lastVerdict.nextStep ? { nextStep: goal.lastVerdict.nextStep } : {})
            }
          }
        : {}),
      lastRun: facts.lastRun
    }
  }

  // ─── 后台工作的检查（§4.1） ─────────────────────────────

  private scheduleCheckin(sessionId: string): void {
    if (this.checkins.has(sessionId)) return
    const delayMs = this.deps.checkinFirstMs ?? CHECKIN_FIRST_MS
    this.armCheckin(sessionId, delayMs, this.deps.now())
  }

  private armCheckin(sessionId: string, delayMs: number, since: number): void {
    const timer = setTimeout(() => {
      void this.queue(sessionId, () => this.checkinNow(sessionId, delayMs, since)).catch(
        (error: unknown) => log.warn(`目标检查失败 session=${sessionId}: ${String(error)}`)
      )
    }, delayMs)
    timer.unref?.()
    this.checkins.set(sessionId, { timer, delayMs, since })
  }

  private async checkinNow(sessionId: string, delayMs: number, since: number): Promise<void> {
    this.checkins.delete(sessionId)
    const session = getSessionHost().get(sessionId)
    if (session === undefined || session.closed) return
    const goal = await readGoal(session.harness)
    if (goal === undefined || goal.status !== 'active') return
    const first = this.deps.checkinFirstMs ?? CHECKIN_FIRST_MS
    const nextDelay = Math.min(delayMs * 2, first * CHECKIN_MAX_FACTOR)
    const background =
      taskRegistry.runningCount(sessionId, 'bash') +
        taskRegistry.runningCount(sessionId, 'sub-session') >
      0
    if (session.isInterrupted()) return
    // 后台工作已经没了、会话却空闲：完成通知没起轮（用户关了自动续跑）—— 就地当作一轮结束来判，免得目标一直「进行中」
    if (!background) {
      if (!session.isBusy()) await this.afterRunNow(sessionId, 'ok')
      return
    }
    // 忙（agent 自己在看）：下一次再说
    if (session.isBusy()) {
      this.armCheckin(sessionId, delayMs, since)
      return
    }
    const now = this.deps.now()
    const costUsd = await this.goalCost(session, goal)
    if (goal.turns >= goal.limits.maxTurns || budgetCrossed(goal, costUsd)) {
      const reason: GoalPauseReason = budgetCrossed(goal, costUsd) ? 'budget' : 'turns'
      const written = await updateGoal(session.harness, (g) =>
        g?.id === goal.id ? pauseGoal(g, reason, now) : g
      )
      if (written?.status === 'paused') await this.paused(session, written, reason)
      return
    }
    const written = await updateGoal(session.harness, (g) =>
      g?.id === goal.id ? { ...g, turns: g.turns + 1 } : g
    )
    if (written?.status !== 'active') return
    await this.broadcast(session, written)
    await session.notify(renderGoalCheckin(written, (now - since) / 60_000), {
      kind: 'goal-checkin',
      resume: 'goal',
      requestId: `goal:${written.id}:checkin:${written.turns}`
    })
    this.armCheckin(sessionId, nextDelay, since)
  }

  // ─── 运行中查预算（§6.1） ──────────────────────────────

  /** 根运行开始：进行中的目标在这一轮里每隔一会儿查一次花费（运行结束时停） */
  onRootRunStarted(sessionId: string): void {
    if (this.statuses()[sessionId] !== 'active' || this.budgetTimers.has(sessionId)) return
    const timer = setInterval(() => {
      void this.queue(sessionId, () => this.budgetCheckNow(sessionId)).catch((error: unknown) =>
        log.warn(`目标预算检查失败 session=${sessionId}: ${String(error)}`)
      )
    }, this.deps.budgetCheckMs ?? BUDGET_CHECK_INTERVAL_MS)
    timer.unref?.()
    this.budgetTimers.set(sessionId, timer)
  }

  private stopBudgetTimer(sessionId: string): void {
    const timer = this.budgetTimers.get(sessionId)
    if (timer !== undefined) clearInterval(timer)
    this.budgetTimers.delete(sessionId)
  }

  private async budgetCheckNow(sessionId: string): Promise<void> {
    const session = getSessionHost().get(sessionId)
    if (session === undefined || session.closed) {
      this.stopBudgetTimer(sessionId)
      return
    }
    if (!session.isBusy()) return
    const goal = await readGoal(session.harness)
    if (goal === undefined || goal.status !== 'active' || goal.limits.costUsd === undefined) return
    const costUsd = await this.goalCost(session, goal)
    if (!budgetCrossed(goal, costUsd)) return
    const now = this.deps.now()
    const written = await updateGoal(session.harness, (g) =>
      g?.id === goal.id ? pauseGoal(g, 'budget', now) : g
    )
    if (written?.status !== 'paused') return
    await session.notify(renderGoalBudget(written, costUsd), {
      kind: 'goal-budget',
      resume: 'never',
      requestId: `goal:${written.id}:budget:${now}`
    })
    this.clearCheckin(sessionId)
    await this.broadcast(session, written)
    notifyGoalEnded(sessionId, outcomeText(written, { event: 'paused', reason: 'budget' }))
  }

  // ─── 启动、fork、删除 ─────────────────────────────────

  /**
   * 启动扫描（§8）：进行中的目标 —— 会话空闲（上一轮已经结束，没有任何东西会把它推起来）→ 暂停（restart）；
   * 会话被中断 → 不动，等用户点继续（打开会话从不 resume，这条不改）。存储不在了的从表里删掉。
   */
  async sweepOnStartup(): Promise<void> {
    for (const [sessionId, status] of Object.entries(this.statuses())) {
      try {
        const session = await getSessionHost().peek(sessionId)
        if (session === undefined) {
          this.recordStatus(sessionId, undefined)
          continue
        }
        const goal = await readGoal(session.harness)
        if (goal === undefined || (goal.status !== 'active' && goal.status !== 'paused')) {
          this.recordStatus(sessionId, goal)
          continue
        }
        // 看存储里的状态，不看表里的（表可能落后：写完目标、记表之前进程没了）
        void status
        if (goal.status === 'active' && !session.isInterrupted()) {
          const written = await updateGoal(session.harness, (g) =>
            g?.id === goal.id ? pauseGoal(g, 'restart', this.deps.now()) : g
          )
          if (written?.status === 'paused') {
            await this.writeStatus(session, written, { event: 'paused', reason: 'restart' })
          }
          this.recordStatus(sessionId, written)
          continue
        }
        this.recordStatus(sessionId, goal)
      } catch (error) {
        log.warn(`启动时扫描目标失败 session=${sessionId}: ${String(error)}`)
      }
    }
  }

  /**
   * fork 出来的会话：运行时的拷贝收尾已把进行中的目标置为暂停（暂停中的照旧），这里只记进状态表 —— 按源会话的
   * 状态推断，不必打开 fork 的存储。
   */
  noteForked(sourceId: string, forkId: string): void {
    if (this.statuses()[sourceId] !== undefined) this.recordStatusValue(forkId, 'paused')
  }

  /** 删除会话：停掉它名下的一切 */
  forget(sessionId: string): void {
    this.abortJudging(sessionId)
    this.clearCheckin(sessionId)
    this.stopBudgetTimer(sessionId)
    this.pendingStatus.delete(sessionId)
    this.recordStatus(sessionId, undefined)
  }

  /** 退出：计时器全停 */
  dispose(): void {
    for (const id of [...this.checkins.keys()]) this.clearCheckin(id)
    for (const id of [...this.judging.keys()]) this.abortJudging(id)
    for (const id of [...this.budgetTimers.keys()]) this.stopBudgetTimer(id)
  }
}

export const goalService = new GoalService({ now: () => Date.now() })

/** 目标记录形状（测试与调试用） */
export { goalRecordOf }
