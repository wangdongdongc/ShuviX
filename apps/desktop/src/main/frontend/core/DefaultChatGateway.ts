import type { ChatGateway } from './ChatGateway'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import type { AgentInitResult, AgentRuntimeInfo, ThinkingLevel } from '../../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { sessionService } from '../../services/sessionService'
import type { AgentSession, DriveOptions } from '../../services/agentSession'
import '../../tools/allTools'
import { getPlatformBuiltinToolEntries } from '../../services/toolRegistry'
import { messageService } from '../../services/messageService'
import {
  appendModelChange,
  appendThinkingLevelChange,
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
import { WORK_PROFILE_NAME, type SubmitErrorCode } from '@shuvix/agent-runtime'
import { agentService } from '../../services/agentService'
import { chatFrontendRegistry } from './ChatFrontendRegistry'
import { t } from '../../i18n'

/** 会话打不开时报给界面的文案：旧格式会话只读；其余（会话不存在、退出中）沿用原来的那句 */
function unavailableSessionError(sessionId: string): string {
  return storageRefusalOf(sessionId) === 'legacy'
    ? t('chat.legacySessionReadOnly')
    : 'Agent 未初始化'
}

/**
 * ChatGateway 默认实现 — 聚合 Service 层，提供统一的会话级操作入口
 */
export class DefaultChatGateway implements ChatGateway {
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
    // lastActiveAt 在这条输入被会话受理时入账（门面的 onAdmitted），不在这里 bump：
    // 打不开 / 被拒的发送不会落进会话，却会误记一天。
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
    // TODO(pi-durable p3): 其它前端看到这条用户消息靠投影（durable 不发 user_message 事件）。
    // 发送结果原样上交：子会话的驱动方靠它区分「没发出去」与「发出去了没回话」。
    // `drive` 只有子会话的驱动方（subSessionRunner，主进程内）给：幂等键 + driven-run 标记（P2-10）
    return await session.prompt(promptText, images, display, drive)
  }

  steer(sessionId: string, text: string): void {
    this.enqueue(sessionId, (session) => session.steer(text))
  }

  followUp(sessionId: string, text: string): void {
    this.enqueue(sessionId, (session) => session.followUp(text))
  }

  nextTurn(sessionId: string, text: string): void {
    this.enqueue(sessionId, (session) => session.nextTurn(text))
  }

  /**
   * 三条队列共用的入队骨架（nextTurn 在门面里垫成 followUp，直到 phase 3）。
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

  // ─── 交互响应 ─────────────────────────────────

  respondToInput(sessionId: string, requestId: string, response: InputResponse): void {
    // broker 按 requestId 找归属（各参与方各自认领）。**不拿 sessionId 去选
    // 参与方** —— 那等于把前端以为的归属当成真相；它在这里只有一个用途：无人认领时
    // 把那张卡片从界面上收走。
    //
    // 无人认领 = 请求早已被取消（会话停了、run 超时了），而前端那张待答卡还在：它只认
    // `input_request_resolved`，后端既然不会再发，就在这里补一条。少了它，用户面对的是
    // 一个点下去毫无反应的按钮，而唯一的线索在主进程日志里
    if (respondToUserInput(requestId, response)) return
    chatFrontendRegistry.broadcast({ type: 'input_request_resolved', sessionId, requestId })
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
    await appendModelChange(sessionId, provider, model)
    return true
  }

  async destroyAgent(sessionId: string): Promise<void> {
    // invalidate 而非 destroy：会话还在，下一条消息照常重建。会话级资源（内置能力服务器、
    // 决策日志、审查计数、hook 派发）随会话而不随运行时，这里一样都不碰
    await sessionService.invalidateAgent(sessionId)
  }

  async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
    await appendThinkingLevelChange(sessionId, level)
    const agent =
      sessionService.getAgentSession(sessionId) ??
      (sessionService.hasAgentRuntime(sessionId)
        ? await sessionService.peekAgentSession(sessionId)
        : undefined)
    if (agent) await agent.setThinkingLevel(level)
  }

  /**
   * Agent 运行时快照。durable 的请求是现解析的，没有一个「内存里的 Agent 对象」可读 —— 在 phase 3 的
   * 视图接上之前恒为 null，`ensure` 也不再为它打开会话 / 创建 agent（PIN-14）。TODO(pi-durable p3)
   */
  async getAgentInfo(
    sessionId: string,
    _options?: { ensure?: boolean }
  ): Promise<AgentRuntimeInfo | null> {
    return (await sessionService.getAgentSession(sessionId)?.getRuntimeInfo()) ?? null
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
   * 回退到某条消息之前（durable 会话：phase 3，`resolveRollbackTarget` 抛 PhasePendingError；
   * 旧格式会话只读，没有可回退的目标）。
   *
   * **顺序是关键**：先把 agent 彻底停下并解锁，再动会话。反过来等于在一个还在写的 run 脚下
   * 改历史 —— 它接下来的消息会挂到回退后的分支上，和新 run 交叉。
   */
  async rollbackMessage(sessionId: string, messageId: string): Promise<void> {
    // 先只读地解析目标：目标不存在就什么都不做 —— 不值得为一次无效回退把正在跑的 Agent 停掉
    const target = await messageService.resolveRollbackTarget(sessionId, messageId)
    if (!target) return
    await sessionService.invalidateAgent(sessionId)
    await messageService.applyRollback(sessionId, target.targetId)
  }

  // ─── 运行时资源 ──────────────────────────────────

  getRuntimeStatuses(sessionId: string): Record<string, RuntimeStatus> {
    const result: Record<string, RuntimeStatus> = {}

    const db = dbManager.runtimeStatus(sessionId)
    if (db) result['db'] = db

    // 每台连着的 ssh 主机一枚（`ssh:<alias>`）—— 没有这一份，切走再切回 / 刷新窗口后胶囊就没了
    Object.assign(result, sshRuntimeStatuses(sessionId))

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
    // 档案声明的 mcp:/skill: 项对这条会话恒生效（createAgent 的名单归一），选择器据此画成已勾、锁住；
    // 值是档案显示名，悬停时说「谁声明的」—— 要去掉只能覆盖那份档案，会话里取消不了
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
     * 那里，以锁住的已勾形态 —— 别的会话选不到它：桌面自己的会话只用应用内的浏览器面板
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
