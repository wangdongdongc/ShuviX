import type { ChatGateway } from './ChatGateway'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import {
  MAX_RESOLVE_PLACEHOLDERS,
  isPlaceholder,
  type RedactionMarkInfo
} from '@shuvix/chat-protocol/utils/redactionPlaceholders'
import type {
  AgentInitResult,
  AgentRuntimeInfo,
  ThinkingLevel,
  WithdrawQueuedResult
} from '../../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { sessionService } from '../../services/sessionService'
import type { AgentSession, DriveOptions } from '../../services/agentSession'
import type { InputSource } from '@shuvix/agent-runtime'
import {
  currentInputOrigin,
  getOperationContext,
  operationContext
} from '../../utils/operationContext'
import {
  suggestionGroupKey,
  suggestionToAccept,
  type AcceptSuggestionResult
} from '@shuvix/chat-protocol/suggestions'
import type { SuggestionRef } from '@shuvix/chat-protocol/types/inputOrigin'
import '../../tools/allTools'
import { getPlatformBuiltinToolEntries } from '../../services/toolRegistry'
import { messageService } from '../../services/messageService'
import {
  recordSessionModel,
  recordSessionThinkingLevel,
  storageRefusalOf
} from '../../services/sessionStorage'
import { respondToUserInput } from '../../services/userInputBroker'
import { dbManager } from '../../services/builtinMcp/dbConnections'
import { sshDisconnectRuntime, sshRuntimeStatuses } from '../../services/builtinMcp/sshServer'
import { mcpService } from '../../services/mcpService'
import { skillService } from '../../services/skillService'
import type { ChatMessage, InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { sessionRecords } from '../../services/sessionRecords'
import { projectDao } from '../../dao/projectDao'
import {
  AgentCreationError,
  SessionClosedError,
  WORK_PROFILE_NAME,
  type SubmitErrorCode
} from '@shuvix/agent-runtime'
import { agentService } from '../../services/agentService'
import { chatFrontendRegistry } from './ChatFrontendRegistry'
import { t } from '../../i18n'
import { createLogger } from '../../logger'

const log = createLogger('ChatGateway')

/** 会话打不开时报给界面的文案：旧格式会话只读；其余（会话不存在、退出中）沿用原来的那句 */
function unavailableSessionError(sessionId: string): string {
  return storageRefusalOf(sessionId) === 'legacy'
    ? t('chat.legacySessionReadOnly')
    : 'Agent 未初始化'
}

/**
 * ChatGateway 默认实现 — 聚合 Service 层，提供统一的会话级操作入口
 */
/** 回退之后原样重发、沿用来源的窗口（§19.7） */
const RESEND_WINDOW_MS = 120_000

/** 刚送出的提议在这段时间里不能再送一次（会话不在跑时；在跑时一直不能，见 sentSuggestions） */
const SUGGESTION_SEND_GRACE_MS = 10_000

export class DefaultChatGateway implements ChatGateway {
  /**
   * 回退掉一条父会话代发的用户消息之后，紧接着原样重发同一句 ——「重新生成」与「回退后原样发送」—— 沿用它的来源
   * （§19.7）：否则父会话写的话经一次重发就成了「人亲手打的」，被自动审查当成用户的意思。只在主进程里记，
   * 只会让重发的那句「更不算人话」，渲染端借不到它做别的。
   */
  private readonly resendSources = new Map<
    string,
    { text: string; source: InputSource; at: number }
  >()

  /**
   * 刚送出去的提议（会话 id + 组键 → 送出的时刻）：送出到那条用户消息出现在会话里之间有一段空档（steer 先排队，到下一步
   * 才落下；空闲时起的一轮也要等受理），这段时间里同一组再点一次不能再发一遍。记号只在**会话还在跑、或送出不到
   * `SUGGESTION_SEND_GRACE_MS`** 时算数：之后那句话要么已经在会话里（会话记录自己就把这组判成关闭），要么随回退 /
   * 撤回没了（卡片又开着，就该能再点）。没送出去时立刻撤掉
   */
  private readonly sentSuggestions = new Map<string, number>()

  // ─── Agent 对话 ──────────────────────────────

  startChat(sessionId: string): Promise<AgentInitResult> {
    return sessionService.initAgent(sessionId)
  }

  async prompt(
    sessionId: string,
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>,
    inlineTokens?: Record<string, InlineToken>,
    drive?: DriveOptions
  ): Promise<{ error?: string; code?: SubmitErrorCode }> {
    // 「重新生成」/ 回退后原样重发一条父会话代发的消息：沿用它的来源（§19.7）。只认紧接着的那一次、原文一字不差、
    // 两分钟之内 —— 改过的文字是人的话；不管用没用上、这次发送成不成都撤掉（在打开会话之前就取走），免得留给以后的某次发送
    // 采纳提议发的话不沿用：它的来源就是这次点击（连接 + 提议引用），哪怕碰巧与那条重发的原文相同
    const resend =
      drive === undefined && getOperationContext()?.suggestion === undefined
        ? this.resendSources.get(sessionId)
        : undefined
    this.resendSources.delete(sessionId)
    const resent =
      resend && resend.text === text && Date.now() - resend.at < RESEND_WINDOW_MS
        ? resend.source
        : undefined
    // 这条输入从哪来：其余的按这次操作的连接盖章（本机窗口、远程连接……，从不取载荷里的）。被驱动的发送由门面记
    // 驱动它的会话
    const source = drive === undefined ? (resent ?? currentInputOrigin()) : undefined

    // lastActiveAt 与日历不在这里 bump：门面在用户条目落下时按条目 id 入账（当场落下的在 onAdmitted，
    // 排队之后被放下的在 onPlaced，P3-07）。打不开 / 被拒 / 被撤回的发送不会落进会话，却会误记一天。
    // 这里只打开会话；agent 在第一次发送时由运行时创建（打开会话 / 笔记本不创建）
    const session = await sessionService.ensureAgentSession(sessionId)
    if (!session) {
      const error = unavailableSessionError(sessionId)
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error })
      return { error }
    }

    // ─── 内联 Token 处理 ───
    // LLM 收展开后的全文（树里的 user 消息即真理源）；标记态原文 + tokens 作为
    // 显示侧车（纯 custom entry）落在 user 消息之前，投影层据此还原芯片气泡。
    const hasTokens = !!inlineTokens && Object.keys(inlineTokens).length > 0
    const promptText = hasTokens ? resolveTokensForAgent(text, inlineTokens) : text
    const display = hasTokens ? { content: text, tokens: inlineTokens } : undefined

    // 会话配置（档案、扩展能力、模型）在第一次发送创建 agent 时才读，所以「发送第一条消息前
    // 调整配置」的语义保持不变。

    // 用户消息不由网关落库：会话运行时把它作为条目追加。发送失败由门面报给界面。
    // 其它前端经会话视图（投影）看到这条用户消息，没有单独的用户消息事件。
    // 发送结果原样上交：子会话的驱动方靠它区分「没发出去」与「发出去了没回话」。
    // `drive` 只有子会话的驱动方（subSessionRunner，主进程内）给：幂等键 + driven-run 标记（P2-10）
    return await session.prompt(promptText, images, display, drive, source)
  }

  steer(sessionId: string, text: string): void {
    const origin = currentInputOrigin()
    this.enqueue(sessionId, (session) => session.steer(text, origin))
  }

  async steerDriven(
    sessionId: string,
    text: string,
    drive: { requestId: string; parentId: string }
  ): Promise<{ error?: string; code?: SubmitErrorCode }> {
    const session = sessionService.getAgentSession(sessionId)
    if (!session) return { error: 'The session is not open', code: 'closed' }
    try {
      const result = await session.admitSteer(text, {
        requestId: drive.requestId,
        source: sessionRecords.drivingSourceOf(sessionId, drive.parentId)
      })
      return result.error ? { error: result.error, code: result.code } : {}
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  followUp(sessionId: string, text: string): void {
    const origin = currentInputOrigin()
    this.enqueue(sessionId, (session) => session.followUp(text, origin))
  }

  async acceptSuggestion(sessionId: string, ref: SuggestionRef): Promise<AcceptSuggestionResult> {
    const key = `${sessionId}\n${suggestionGroupKey(ref.messageId, ref.toolCallId)}`
    if (this.recentlySent(key, sessionId)) return { success: false, reason: 'closed' }
    const found = suggestionToAccept(await messageService.listBySession(sessionId), ref)
    if (!found.ok) return { success: false, reason: found.reason }
    // 二次核对与送出之间没有 await 让出：同一组的第二次点击在这里就会撞上
    if (this.recentlySent(key, sessionId)) return { success: false, reason: 'closed' }
    this.sentSuggestions.set(key, Date.now())
    const release = (error: string): AcceptSuggestionResult => {
      this.sentSuggestions.delete(key)
      return { success: false, reason: 'failed', error }
    }
    // 来源 = 这次操作的连接 + 提议引用：在派生的操作上下文里发，网关的 prompt / steer 照常按它盖章
    const ctx = getOperationContext()
    const stamped = <T>(work: () => T): T =>
      ctx === undefined ? work() : operationContext.run({ ...ctx, suggestion: { ...ref } }, work)
    const live = sessionService.getAgentSession(sessionId)
    if (live?.isStreaming) {
      try {
        await stamped(() => live.steer(found.message, currentInputOrigin()))
        return { success: true }
      } catch (error) {
        return release(error instanceof Error ? error.message : String(error))
      }
    }
    // 空闲：起一轮。prompt 要等整轮结束才交回，所以不等它；出错由门面报给界面。出错就撤掉记号 —— 那句话若其实已经
    // 落进会话（运行中途才失败），会话里的记录照样把这组提议判成关闭，撤掉记号不会让它被发第二遍
    void stamped(() => this.prompt(sessionId, found.message))
      .then((result) => {
        if (result.error !== undefined) release(result.error)
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        release(message)
        log.warn(`accept suggestion failed session=${sessionId}: ${message}`)
      })
    return { success: true }
  }

  /** 这组提议刚送出过、记号还算数（见 sentSuggestions）；不算数的顺手清掉 */
  private recentlySent(key: string, sessionId: string): boolean {
    const at = this.sentSuggestions.get(key)
    if (at === undefined) return false
    if (
      Date.now() - at < SUGGESTION_SEND_GRACE_MS ||
      sessionService.getAgentSession(sessionId)?.isStreaming
    ) {
      return true
    }
    this.sentSuggestions.delete(key)
    return false
  }

  async withdrawQueued(sessionId: string, submissionId: number): Promise<WithdrawQueuedResult> {
    // 不规范的 id 不碰运行时（IPC 载荷不可信：'3'、1.5、NaN、0、负数）
    if (!Number.isSafeInteger(submissionId) || submissionId <= 0) return 'not_found'
    // 只对打开着的会话：撤回只对一条正在用的会话有意义，网关不为它打开 / peek 会话
    const session = sessionService.getAgentSession(sessionId)
    if (!session) return 'not_found'
    const result = await session.withdrawQueued(submissionId)
    return result === 'closed' ? 'not_found' : result
  }

  /**
   * 两条队列（steer / followUp）共用的入队骨架。
   *
   * 只交给打开着的会话：插话 / 追加只对一条正在用的会话有意义，网关不为它打开会话。
   * 被拒（模型被拒、会话已关……）的文案报给界面。
   */
  private enqueue(sessionId: string, push: (session: AgentSession) => Promise<void>): void {
    const session = sessionService.getAgentSession(sessionId)
    if (!session) {
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }
    void push(session).catch((error: unknown) => {
      chatFrontendRegistry.broadcast({
        type: 'error',
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  async abort(sessionId: string): Promise<{ success: boolean }> {
    // harness 会把带 stopReason='aborted' 的部分消息正常落成 entry，
    // 不再需要网关回传「抢救出来的半条消息」。
    await sessionService.getAgentSession(sessionId)?.abort()
    return { success: true }
  }

  async continue(sessionId: string): Promise<{ error?: string; code?: SubmitErrorCode }> {
    // 只 get / peek（PIN-16）：「继续」作用在一条已经存在的存储上，绝不为它建存储
    const session =
      sessionService.getAgentSession(sessionId) ??
      (await sessionService.peekAgentSession(sessionId))
    if (!session) return {}
    return await session.continue()
  }

  // ─── 交互响应 ─────────────────────────────────

  respondToInput(
    _sessionId: string,
    requestId: string,
    response: InputResponse,
    meta?: { clientId?: string }
  ): boolean {
    // broker 按 requestId 找归属（各参与方各自认领）。**不拿 sessionId 去选参与方** —— 那等于
    // 把前端以为的归属当成真相。
    //
    // 无人认领 = 请求早已被取消（会话停了、run 超时了）或别的前端先答了：不再补发「已落定」
    // （P3-08）—— 待答卡片来自视图的 `asks`，询问一落定视图就不再有它，每个前端的卡片自己消失。
    // broker 记一行「没人认领」的日志
    return respondToUserInput(requestId, response, meta)
  }

  // ─── 运行时调整 ────────────────────────────────

  /**
   * 以下两个 setter 是模型类运行配置的**唯一写入口**（会话设置 `settings.model` / `.thinkingLevel`）。
   *
   * 模型只在没有 agent 的时候可改：它与扩展能力勾选一样在创建 agent 那一刻读一次。锁住期间
   * （打开着看运行时的锁，没开着看锁镜像）一律拒绝、什么也不写 —— 用户要换模型，先在会话横幅的
   * agent 胶囊上把 agent 销毁（destroyAgent）。
   *
   * 思考档位不在此列：设置恒写；有 agent 时再现场交给它（下一次请求生效）—— 会话开着直接给，
   * 没开着但锁着就 peek 打开再给（PIN-07），没锁就等下一次创建时读设置。
   */
  async setModel(sessionId: string, provider: string, model: string): Promise<boolean> {
    if (sessionService.hasAgentRuntime(sessionId)) return false
    await recordSessionModel(sessionId, provider, model)
    return true
  }

  async destroyAgent(sessionId: string): Promise<void> {
    // invalidate 而非 destroy：会话还在，下一条消息照常重建。会话级资源（内置能力服务器、
    // 决策日志、审查计数、hook 派发）随会话而不随运行时，这里一样都不碰
    await sessionService.invalidateAgent(sessionId)
  }

  async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
    await recordSessionThinkingLevel(sessionId, level)
    const agent =
      sessionService.getAgentSession(sessionId) ??
      (sessionService.hasAgentRuntime(sessionId)
        ? await sessionService.peekAgentSession(sessionId)
        : undefined)
    if (agent) await agent.setThinkingLevel(level)
  }

  /**
   * 根 agent 的运行时快照（P3-06）：系统提示词与下一次请求逐字节相同、工具按请求次序、模型、活的思考档位。
   *
   *  - 不带 `ensure`：只读已有的 agent —— 会话开着读门面；没开着但锁着（LRU 关掉了）就 peek 打开再读
   *    （PIN-03，与 setThinkingLevel 同一口径；从不新建存储、从不续跑）；没锁 → null。
   *  - 带 `ensure`：打开会话（必要时建存储）→ 创建 agent（上锁，**不请求 LLM**、不续跑被中断的 run）→ 读。
   *    没有可用模型 / 创建被取消 → null 并记警告（PIN-01：这不是一次发送，不报 error 事件）；会话不存在 /
   *    旧格式 / 退出中 → null；其余创建失败原样上抛（IPC 拒绝）。
   */
  async getAgentInfo(
    sessionId: string,
    options?: { ensure?: boolean }
  ): Promise<AgentRuntimeInfo | null> {
    if (options?.ensure) {
      const session = await sessionService.ensureAgentSession(sessionId)
      if (!session) return null
      try {
        await session.createAgent()
      } catch (error) {
        if (error instanceof AgentCreationError && error.code !== 'extra_tools') {
          log.warn(`getInfo ensure: agent not created session=${sessionId}: ${error.message}`)
          return null
        }
        if (error instanceof SessionClosedError) return null
        throw error
      }
      return await session.getRuntimeInfo()
    }
    const session =
      sessionService.getAgentSession(sessionId) ??
      (sessionService.hasAgentRuntime(sessionId)
        ? await sessionService.peekAgentSession(sessionId)
        : undefined)
    return (await session?.getRuntimeInfo()) ?? null
  }

  // ─── 消息操作 ─────────────────────────────────

  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    return await messageService.listBySession(sessionId)
  }

  async clearMessages(sessionId: string): Promise<void> {
    // PIN-08：先销毁 agent（中止还在跑的 run、广播 agent_closing 一对），再关掉并删掉存储、镜像归位
    await sessionService.invalidateAgent(sessionId)
    await messageService.clear(sessionId)
  }

  /**
   * 回退到某条消息之前（P3-10b）：交给运行时的 `rollbackTo` —— 它先只读地校验目标，合格才停下在跑的 run、
   * 销毁 agent（`agent_closing` 一对）、建 fork；不合格什么都不动。所以这里**不**预先 invalidate（PIN-03）：
   * 那样一个无效目标也会把在跑的 run 停掉。真回退了再清桌面侧随 agent 的状态（fileTime 的「已读」记录），
   * 运行时的销毁不管这一份。旧格式会话只读、id 不是条目 id、目标不在 → false，什么都不动。
   */
  async rollbackMessage(sessionId: string, messageId: string): Promise<boolean> {
    // 每次回退都换掉上一次留下的记录：沿用只属于「紧接着这次回退」的那一次发送
    this.resendSources.delete(sessionId)
    const resend = await this.sourceOfMessage(sessionId, messageId)
    const rolledBack = await messageService.rollbackToMessage(sessionId, messageId)
    if (rolledBack) sessionService.clearAgentScopedState(sessionId)
    if (rolledBack && resend) this.resendSources.set(sessionId, { ...resend, at: Date.now() })
    return rolledBack
  }

  /**
   * 回退掉的那条用户消息若是别的会话代发的（父会话、或被授权的别的会话，有来源记录），交回它的原文与来源 ——
   * 紧接着原样重发时沿用（见 `resendSources`）。读不了就当没有（重发照旧当作人发的 —— 与改动之前一样）。
   */
  private async sourceOfMessage(
    sessionId: string,
    messageId: string
  ): Promise<{ text: string; source: InputSource } | undefined> {
    try {
      const agent =
        sessionService.getAgentSession(sessionId) ??
        (await sessionService.peekAgentSession(sessionId))
      if (!agent) return undefined
      const sources = await agent.inputSources()
      const source = sources.get(messageId)
      if (!source) return undefined
      const message = (await agent.sessionView()).messages.find((m) => m.id === messageId)
      return message?.role === 'user' ? { text: message.content, source } : undefined
    } catch {
      return undefined
    }
  }

  // ─── 自动脱敏 ──────────────────────────────────

  async resolveRedactions(
    sessionId: string,
    placeholders: string[]
  ): Promise<Record<string, RedactionMarkInfo>> {
    const wanted = (Array.isArray(placeholders) ? placeholders : [])
      .filter((p): p is string => typeof p === 'string' && isPlaceholder(p))
      .slice(0, MAX_RESOLVE_PLACEHOLDERS)
    const result: Record<string, RedactionMarkInfo> = {}
    if (wanted.length === 0) return result
    const agent =
      sessionService.getAgentSession(sessionId) ??
      (await sessionService.peekAgentSession(sessionId))
    const redaction = agent?.durable.redaction
    if (!redaction) return result
    const table = await redaction.table()
    for (const placeholder of wanted) {
      const item = table.get(placeholder)
      if (!item) continue
      result[placeholder] =
        item.value === undefined
          ? { category: item.category }
          : { category: item.category, value: item.value }
    }
    return result
  }

  // ─── 运行时资源 ──────────────────────────────────

  async getRuntimeStatuses(sessionId: string): Promise<Record<string, RuntimeStatus>> {
    const result: Record<string, RuntimeStatus> = {}

    const db = dbManager.runtimeStatus(sessionId)
    if (db) result['db'] = db

    // 每台连着的 ssh 主机一枚（`ssh:<alias>`）—— 没有这一份，切走再切回 / 刷新窗口后胶囊就没了。
    // 异步：会话名下有 socket 时要读 ~/.ssh/config，那次读不能挂住主进程（会话没有 socket 则根本不读）
    Object.assign(result, await sshRuntimeStatuses(sessionId))

    return result
  }

  async destroyRuntime(sessionId: string, runtimeId: string): Promise<{ success: boolean }> {
    const broadcastDestroy = (): void => {
      chatFrontendRegistry.broadcast({
        type: 'runtime_event',
        sessionId,
        runtimeId,
        status: null
      })
    }

    // ssh 胶囊（`ssh:<alias>`）：真的断开那一台。本来就没连着（master 空闲到点已自己退出）
    // 也照样收掉胶囊 —— 它亮着本身就是过时的
    const sshClosed = sshDisconnectRuntime(sessionId, runtimeId)
    if (sshClosed) {
      await sshClosed
      broadcastDestroy()
      return { success: true }
    }
    if (runtimeId === 'db') {
      if (!dbManager.getConnectionInfo(sessionId)) return { success: false }
      await dbManager.disconnect(sessionId)
      broadcastDestroy()
      return { success: true }
    }
    return { success: false }
  }

  // ─── 工具发现 ──────────────────────────────────

  listTools(
    sessionId?: string,
    options?: { profile?: string }
  ): Array<{
    name: string
    label: string
    hint?: string
    group?: string
    defaultEnabled?: boolean
    serverStatus?: string
    isBuiltin?: boolean
    declaredBy?: string
  }> {
    // 解析项目路径（用于发现项目级 skills）
    let projectPath: string | undefined
    if (sessionId) {
      const session = sessionRecords.findById(sessionId)
      const project = session?.projectId ? projectDao.pick(session.projectId, ['path']) : null
      projectPath = project?.path
    }
    // 默认勾选 = 这条会话根 Agent 档案的白名单：档案由会话形态推导（项目 work / 无项目 chat /
    // 笔记本 notebook / bot 会话 bot，子会话可能被父级钉成 coding），含用户 ~/.shuvix/agents/<name>.md
    // 覆盖 —— 覆盖后会话真的按它创建，UI 的默认勾选就该跟着走。没有会话时按调用方说的档案
    // （欢迎页：直接发送新建的是无项目会话 → chat），没说回落 work（项目编辑页画的是项目会话）
    const profileName = sessionId
      ? sessionService.resolveAgentProfileName(sessionId)
      : options?.profile || WORK_PROFILE_NAME
    const profile = agentService.getProfile(profileName)
    const defaultProfileTools = profile?.tools ?? []
    // 档案声明的 mcp:/skill: 项对这条会话缺省生效（名单归一），选择器据此画成默认勾上、可以取消
    //（取消写成勾选里的 `-<name>` 记号，见 chat-protocol toolSelection）；值是档案显示名，悬停时说「谁声明的」
    const declared = new Set(defaultProfileTools)
    const declaredBy = (name: string): string | undefined =>
      declared.has(name) ? profile?.displayName || profileName : undefined
    /** 内置工具（从注册表读取，system 分组不在 UI 中展示；另一个平台的版本不在这台机器上） */
    const builtinTools = getPlatformBuiltinToolEntries()
      .filter((e) => e.group !== 'system' && !e.hidden)
      .map((e) => ({
        name: e.name,
        label: e.getLabel(),
        hint: e.getHint(),
        group: e.group,
        // wire 契约保留：defaultEnabled 由会话档案清单派生（注册表字段已退役）
        defaultEnabled: defaultProfileTools.includes(e.name)
      }))
    // 过去的 "plugin 工具" (postgres / python) 已合并进 builtinTools，无需再单独拼接
    const merged = builtinTools

    /**
     * MCP 工具。内置 `chrome`（用户真实的 Chrome）只出现在声明它的档案（Chrome 标签页会话的 `tab`）
     * 那里 —— 别的会话选不到它：桌面自己的会话只用应用内的浏览器面板（tab 会话没有选择器，也取消不了它，
     * 见 sessionService.resolveSessionAgentContext）
     */
    const mcpTools = mcpService
      .getAllToolInfos()
      .filter((info) => info.name !== 'mcp:chrome' || declared.has(info.name))
      .map((info) => ({
        name: info.name,
        label: info.label,
        group: info.group,
        serverStatus: info.serverStatus,
        isBuiltin: info.isBuiltin,
        declaredBy: declaredBy(info.name)
      }))
    /** 已启用 Skill（含项目级 .claude/skills/） */
    const skillItems = skillService.findEnabled(projectPath).map((s) => ({
      name: `skill:${s.name}`,
      label: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
      group: '__skills__',
      declaredBy: declaredBy(`skill:${s.name}`)
    }))
    return [...merged, ...mcpTools, ...skillItems]
  }
}

/** 全局单例 */
export const chatGateway = new DefaultChatGateway()
