import {
  clearReviewState,
  clearSessionDecisions,
  SessionClosedError,
  type AdmitOptions,
  type AdmitResult,
  type DrivenRun,
  type DrivenSendOptions,
  type DurableSession,
  type InlineTokensSidecar,
  type InputResponseMeta,
  type LastAnswer,
  type NotifyOptions,
  type RequestState,
  type SubmitResult,
  type TaskLiveness,
  type WithdrawResult
} from '@shuvix/agent-runtime'
import type { JsonObject, UserInput } from '@earendil-works/pi-durable'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { chatFrontendRegistry } from '../frontend/core/ChatFrontendRegistry'
import { t } from '../i18n'
import { createLogger } from '../logger'
import type { AgentRuntimeInfo, ThinkingLevel } from '../types'
import { clearSession as clearFileTimeSession } from '../utils/toolUtils/fileTime'
import { hookService, hookTriggers } from './hookService'
import { recordUserEntry } from './sessionDayPromptService'
import { getSessionHost } from './sessionHost'
import { sessionRecords } from './sessionRecords'
import { sessionSignalsReady } from './sessionSignalSeams'
// 仅在方法体内调用：sessionService 也 import 本模块，ESM 活绑定下无初始化环
import { sessionService } from './sessionService'
import { buildTurnCompletedFacts, isDefaultTitle } from './sessionTriggerFacts'

const log = createLogger('AgentSession')

/** 模型被拒（K4）的界面文案：运行时的原因（点名 provider 显示名与模型 id）套一层本地化 */
export function noModelErrorText(reason: string): string {
  return t('chat.agentNoModel', { reason })
}

/**
 * 发送失败要不要报给界面（裁决 PIN-15）：模型被拒、模型请求失败、run 意外失败 / 接不上、未知原因 →
 * 报（投影还没接上，不报用户就什么都看不见）；忙、会话已关 → 不报（调用方自己知道）。
 * 被中止 / 创建被取消本来就是 `{}`，不是错误。返回要广播的文案，undefined = 不报。
 *
 * `queued`（P2-09 PIN-04，P2-10）：重新挂上的那条输入还排在收件箱里，没有 run 会带走它 —— 它没丢，
 * 跟着下一条消息出去。运行时的原文只说 requestId，换成用户读得懂的那句。
 */
export function reportableError(result: SubmitResult): string | undefined {
  if (!result.error) return undefined
  if (result.code === 'busy' || result.code === 'closed') return undefined
  // 模型侧的失败是会话里的一条错误条目（投影成 error_event，经视图上屏）：再发一条 `error` 事件，界面上
  // 就是两行同一个错误（本地错误行 + 视图里那行，P3-08 PIN-02 / F8）。只报没有条目的错误
  if (result.code === 'model_error') return undefined
  if (result.code === 'no_model') return noModelErrorText(result.error)
  if (result.code === 'queued') return t('chat.requestStillQueued')
  return result.error
}

/**
 * 被父会话驱动的发送（子会话，P2-10）：幂等键 `subsession:<父会话>:<任务>` + driven-run 标记。
 * 只有主进程（subSessionRunner）给 —— IPC 的 `agent:prompt` 从不带它。
 */
export interface DriveOptions {
  requestId: string
  driven: DrivenSendOptions
}

/** steer / followUp 被拒时交给调用方的错误文案（模型被拒同样本地化） */
function admissionErrorText(result: AdmitResult): string {
  return result.code === 'no_model' ? noModelErrorText(result.error!) : result.error!
}

/** 门面缓存：同一个 DurableSession 实例永远拿到同一个门面（会话被关掉重开 = 新实例 = 新门面） */
const facades = new WeakMap<DurableSession, AgentSession>()

/**
 * AgentSession —— 一条会话（pi-durable 存储 + Harness）的桌面门面，公共面与切换前一致。
 *
 * 会话语义都在运行时的 DurableSession 里：锁（「有没有 agent」，没锁时第一次发送先创建，K3）、
 * 通知路由（运行中 steer / 空闲自动续跑 + 500ms 合并窗口 / 显式喊停之后只写不跑 / 被中断推迟）、
 * 中断会话上的发送策略、询问的挂起与中止顺序。这里**不再**有第二份。
 *
 * 门面只留桌面自己的事：
 *  - hook 埋点：`session.prompt-accepted`（输入被受理那一刻，`onAdmitted`）与 `session.turn-completed`
 *    （受理过的发送 / `continue()` 落定之后；被拒的不发，自动续跑不发 —— PIN-19），payload 是会话事实；
 *  - 用户条目落下即入账活跃时间与日历（P3-07 PIN-15/16）：按 `pi.user` 条目 id（= 界面消息 id）记 ——
 *    当场落下的在 `onAdmitted{entryId}`，排进队列的在 `onPlaced`（被撤回的从不记）；prompt / steer /
 *    followUp 都记；
 *  - 发送失败报给界面（PIN-15；运行时不广播）；
 *  - 销毁 agent / 删除会话时的桌面清理：fileTime、（删除时）决策日志与审查状态、
 *    hook 派发出去的 run。ssh / MCP 等内置能力服务器的寿命归会话，由 sessionService.delete 经
 *    `mcpService.closeSession` 释放（PIN-23）。
 *
 * bot 会话的「正文视同已读」（`recordRead`）不在这里：P1-11 的 `PromptHost.resolveBotContext` 每次
 * 解析出 bot 段落时授予，是唯一的授予点。
 *
 * 只经 `AgentSession.of(durable)` 取得；会话由 SessionHost 打开 / 关闭（sessionService 的
 * getAgentSession / ensureAgentSession）。
 */
export class AgentSession {
  readonly sessionId: string

  private constructor(readonly durable: DurableSession) {
    this.sessionId = durable.sessionId
  }

  /** 某个打开着的 DurableSession 的门面（缓存） */
  static of(durable: DurableSession): AgentSession {
    let facade = facades.get(durable)
    if (!facade) {
      facade = new AgentSession(durable)
      facades.set(durable, facade)
    }
    return facade
  }

  // ─── 发送 ──────────────────────────────────────

  /**
   * 发送一条用户消息（可附图）并等这一轮落定。结果原样上交（`{}` 或 `{ error, code }`）：调用方要能区分
   * 「没发出去」与「发出去了没回话」—— 子会话的驱动方据此报错而不是假装排队。
   */
  async prompt(
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>,
    display?: InlineTokensSidecar,
    drive?: DriveOptions
  ): Promise<SubmitResult> {
    log.info(
      `prompt session=${this.sessionId} text=${text.slice(0, 50)}... images=${images?.length || 0}`
    )
    const content: UserInput =
      images && images.length > 0 ? [{ type: 'text', text }, ...images] : text
    // 会话信号先就绪（PIN-09）：投影句柄挂上之前开跑的一轮没有 agent_start / agent_end
    await sessionSignalsReady(this.sessionId)
    let admitted = false
    const dayPrompt = this.dayPromptCallbacks()
    // 重新挂上（已有的 requestId）时运行时不调受理回调（P2-09 PIN-02）：埋点 / 入账都不会重复
    const result = await this.durable.submitUser(content, {
      ...(display === undefined ? {} : { display: display as unknown as JsonObject }),
      ...(drive === undefined ? {} : { requestId: drive.requestId, driven: drive.driven }),
      onAdmitted: (info) => {
        admitted = true
        dayPrompt.onAdmitted(info)
        this.onPromptAdmitted(text)
      },
      onPlaced: dayPrompt.onPlaced
    })
    // 轮结束埋点只给受理过的发送（不 await；payload 组装失败只记日志，绝不影响会话主流程）
    if (admitted) {
      void this.fireTurnCompleted().catch((err) => log.warn(`turn-completed 埋点失败: ${err}`))
    }
    this.reportFailure(result)
    return result
  }

  /** 运行中插话（空闲时起一轮）。被拒 → reject（调用方把文案报给界面） */
  async steer(text: string): Promise<void> {
    const result = await this.durable.steer(text, this.dayPromptCallbacks())
    if (result.error) throw new Error(admissionErrorText(result))
  }

  /** 本轮结束后接着说（空闲时起一轮）。被拒 → reject */
  async followUp(text: string): Promise<void> {
    const result = await this.durable.followUp(text, this.dayPromptCallbacks())
    if (result.error) throw new Error(admissionErrorText(result))
  }

  /** 撤回一条排着的用户输入（P3-11）：结果原样上交（含 `closed`，由网关收成 `not_found`） */
  withdrawQueued(submissionId: number): Promise<WithdrawResult> {
    return this.durable.withdrawQueued(submissionId)
  }

  /** 继续被中断的工作（上个进程中途退出留下的 run）；空闲且没被中断时立刻返回 `{}` */
  async continue(): Promise<SubmitResult> {
    await sessionSignalsReady(this.sessionId)
    const result = await this.durable.continue()
    if (!result.error) {
      void this.fireTurnCompleted().catch((err) => log.warn(`turn-completed 埋点失败: ${err}`))
    }
    this.reportFailure(result)
    return result
  }

  /**
   * 送达系统侧通知（后台任务 / 子会话跑完）。路由全在运行时：运行中 steer、空闲且允许自动续跑 →
   * 合并窗口内攒起来起一轮、显式喊停之后 / 开关关掉 → 写成通知条目、被中断 → 推迟到继续 / 下一次发送。
   */
  async notify(text: string, options?: NotifyOptions): Promise<void> {
    // 不带选项时原样只传正文（bash 的后台通知走这条，契约不变）
    if (options === undefined) await this.durable.notify(text)
    else await this.durable.notify(text, options)
  }

  /** 不等空闲的「继续」：被中断就续上（子会话的 wait 重跑，P2-10）；没被中断 = 无操作 */
  resumeInterrupted(): Promise<SubmitResult> {
    return this.durable.resumeInterrupted()
  }

  /** 某个 requestId 在当前对话里的状态（子会话 prompt 的重新挂上判定，P2-10） */
  requestState(requestId: string): Promise<RequestState> {
    return this.durable.requestState(requestId)
  }

  /** 当前对话这一轮的回答（子会话的答复，P2-10；这一轮还没回答 → undefined） */
  lastAnswer(): Promise<LastAnswer | undefined> {
    return this.durable.lastAnswer()
  }

  /** 此刻的 driven-run 标记（被父会话驱动、还没报过落定的那一轮） */
  get drivenRun(): DrivenRun | undefined {
    return this.durable.drivenRun
  }

  /** 某个任务的存活情况（父会话中止的级联与完成通知的抑制，P2-10） */
  taskLiveness(taskId: number): Promise<TaskLiveness | undefined> {
    return this.durable.taskLiveness(taskId)
  }

  /** 中止当前 run（显式喊停：到下一条用户消息之前不自动续跑） */
  async abort(): Promise<void> {
    await this.durable.abort()
  }

  /** 设置思考深度（下一次请求生效；锁住期间照样可改） */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.durable.setThinkingLevel(level)
  }

  /** 当前上下文对应的 UI 消息列表：界面投影的 `messages`（P3-07，与 `messageService.listBySession` 同一份） */
  async listChatMessages(): Promise<ChatMessage[]> {
    return (await this.durable.viewSnapshot()).messages
  }

  /**
   * 创建 agent（上锁）而不发任何请求 —— `agent.getInfo(…, {ensure})` 用（P3-06）。已锁 = 无操作；
   * 模型被拒 / 被取消 → `AgentCreationError`，其余失败原样上抛。
   */
  async createAgent(): Promise<void> {
    await this.durable.createAgent()
  }

  /**
   * 根 agent 的运行时快照（P3-06；设置页「监视器 → 智能体」、`agent.getInfo`）：锁所在对话的
   * `agentInfo`（PIN-09：锁的对话，不重读当前对话）—— 系统提示词与下一次请求逐字节相同。没锁 → null；
   * 会话在读的途中被关掉（LRU）→ null。纯读：不创建 agent、不开启调度器。
   */
  async getRuntimeInfo(): Promise<AgentRuntimeInfo | null> {
    const lock = this.durable.lock
    if (lock === undefined) return null
    try {
      return (await this.durable.agentInfo(lock.conversationId)) ?? null
    } catch (err) {
      if (err instanceof SessionClosedError) return null
      throw err
    }
  }

  /** 当前对话有 run 在跑（被中断的会话不算：什么都没在跑） */
  get isStreaming(): boolean {
    return this.durable.isBusy()
  }

  /** 存储里有 run 但调度器停着（上个进程中途退出留下的） */
  get isInterrupted(): boolean {
    return this.durable.isInterrupted()
  }

  /** 挂起中的用户询问数（>0 = 卡在 ask 上等人回答） */
  get pendingInputCount(): number {
    return this.durable.pendingInputCount
  }

  /** 待答询问的人读摘要（父会话据此把问题转告用户） */
  get pendingInputSummaries(): string[] {
    return this.durable.pendingInputSummaries
  }

  requestUserInput(request: InputRequest): Promise<InputResponse> {
    return this.durable.requestUserInput(request)
  }

  /** 应答一条挂起的询问（先到者胜）；`meta.clientId` = 答题方，交给运行时供审计（P3-08 PIN-20） */
  respondToInput(requestId: string, response: InputResponse, meta?: InputResponseMeta): boolean {
    return meta === undefined
      ? this.durable.respondToInput(requestId, response)
      : this.durable.respondToInput(requestId, response, meta)
  }

  // ─── 生命周期 ──────────────────────────────────

  /**
   * 销毁 agent（agent 芯片上的 X、钉档案、清空之前）：运行时解锁（忙 / 被中断先中止，广播
   * agent_closing 一对），会话照常开着，下一次发送按那时的配置重建。之后清掉桌面侧随 agent 的东西：
   * fileTime 的「已读」记录（命令沙箱的钉子在锁记录里，随解锁一起没了）。销毁失败只记日志，清理照做。
   * 决策日志 / 审查状态 / 存储都不碰 —— 它们随会话而不随 agent。
   */
  async invalidate(): Promise<void> {
    try {
      await this.durable.destroyAgent()
    } catch (err) {
      log.warn(`销毁 agent 失败 session=${this.sessionId}: ${err}`)
    }
    clearAgentScopedState(this.sessionId)
    log.info(`invalidate session=${this.sessionId}`)
  }

  /** 删除会话时的整套关停（见 `destroySessionRuntime`） */
  destroy(): Promise<void> {
    return destroySessionRuntime(this.sessionId)
  }

  // ─── 业务埋点（hook 触发；payload = 会话此刻的事实，与任何具体 hook 无关） ───

  /**
   * 一次发送的日历入账回调（P3-07 PIN-15/16）：用户条目当场落下（`onAdmitted{entryId}`）或排队之后被放下
   * （`onPlaced`）时按条目 id 入账一次；没落下（排着队、被撤回）不记。同一次发送至多一行。
   */
  private dayPromptCallbacks(): Required<Pick<AdmitOptions, 'onAdmitted' | 'onPlaced'>> {
    let recorded = false
    const record = (entryId: number | undefined): void => {
      if (entryId === undefined || recorded) return
      recorded = true
      try {
        recordUserEntry(this.sessionId, entryId)
      } catch (err) {
        log.warn(`活跃时间入账失败 session=${this.sessionId}: ${err}`)
      }
    }
    return {
      onAdmitted: (info) => record(info.entryId),
      onPlaced: (info) => record(info.entryId)
    }
  }

  /** 受理那一刻：fire prompt-accepted（fire 绝不抛出） */
  private onPromptAdmitted(promptText: string): void {
    const title = sessionRecords.pick(this.sessionId, ['title'])?.title ?? ''
    hookTriggers.fire('session.prompt-accepted', {
      sessionId: this.sessionId,
      profileName: this.profileName(),
      title,
      isDefaultTitle: isDefaultTitle(title),
      promptText
    })
  }

  /** 轮结束埋点：事实由共用的构造器现算 */
  private async fireTurnCompleted(): Promise<void> {
    const facts = await buildTurnCompletedFacts(this.sessionId)
    if (!facts) return
    hookTriggers.fire('session.turn-completed', {
      sessionId: this.sessionId,
      profileName: this.profileName(),
      ...facts
    })
  }

  /** 这条会话 agent 的档案名：锁里记的那个（受理时必然已锁），否则按会话形态推导 */
  private profileName(): string {
    return this.durable.lock?.profileName ?? sessionService.resolveAgentProfileName(this.sessionId)
  }

  private reportFailure(result: SubmitResult): void {
    const error = reportableError(result)
    if (error === undefined) return
    chatFrontendRegistry.broadcast({ type: 'error', sessionId: this.sessionId, error })
  }
}

/** 随 agent 一起作废的桌面侧状态（销毁 agent / 清空 / 删除会话共用） */
export function clearAgentScopedState(sessionId: string): void {
  // 命令沙箱的钉子在锁记录里：下一个 agent 上锁时按那时的开关重新决定，这里没有要收尾的登记
  clearFileTimeSession(sessionId)
}

/**
 * 删除会话时的整套关停（会话打开与否都走一遍）：先中止 hook 派发出去的 run（titler 之类不该再往一条
 * 正在删的会话上写）→ SessionHost 关掉并删除存储（忙就中止，等它彻底停下）→ 清掉桌面侧的会话状态
 * （fileTime、决策日志、审查计数与卡片反馈）。删存储失败只记日志，清理照做。
 */
export async function destroySessionRuntime(sessionId: string): Promise<void> {
  hookService.abortSessionRuns(sessionId)
  try {
    await getSessionHost().delete(sessionId)
  } catch (err) {
    log.warn(`关停并删除会话存储失败 session=${sessionId}: ${err}`)
  }
  clearFileTimeSession(sessionId)
  clearSessionDecisions(sessionId)
  clearReviewState(sessionId)
  log.info(`destroy session=${sessionId}`)
}
