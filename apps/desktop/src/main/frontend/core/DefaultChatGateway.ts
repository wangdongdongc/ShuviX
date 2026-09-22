import type { ChatGateway } from './ChatGateway'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import type { AgentInitResult, AgentRuntimeInfo, ThinkingLevel } from '../../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { sessionService } from '../../services/sessionService'
import type { AgentSession } from '../../services/agentSession'
import '../../tools/allTools'
import { getBuiltinToolEntries } from '../../services/toolRegistry'
import { messageService } from '../../services/messageService'
import { appendModelChange, appendThinkingLevelChange } from '../../services/sessionStorage'
import { respondToUserInput } from '../../services/userInputBroker'
import { dbManager } from '../../services/builtinMcp/dbConnections'
import { mcpService } from '../../services/mcpService'
import { skillService } from '../../services/skillService'
import type { ChatMessage, InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { sessionDao } from '../../dao/sessionDao'
import { projectDao } from '../../dao/projectDao'
import { WORK_PROFILE_NAME } from '@shuvix/agent-runtime'
import { agentService } from '../../services/agentService'
import { chatFrontendRegistry } from './ChatFrontendRegistry'

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
    inlineTokens?: Record<string, InlineToken>
  ): Promise<{ error?: string }> {
    // lastActiveAt 在用户消息真正落树并广播 user_message 时入账（electronEventSink），
    // 不在这里 bump：ensure 失败不会落树，却会误记一天。
    // 首次发送消息时才创建 Agent（打开会话/笔记本不创建）
    const session = await sessionService.ensureAgentSession(sessionId)
    if (!session) {
      const error = 'Agent 未初始化'
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error })
      return { error }
    }

    // ─── 内联 Token 处理 ───
    // LLM 收展开后的全文（树里的 user 消息即真理源）；标记态原文 + tokens 作为
    // 显示侧车（纯 custom entry）落在 user 消息之前，投影层据此还原芯片气泡。
    const hasTokens = !!inlineTokens && Object.keys(inlineTokens).length > 0
    const promptText = hasTokens ? resolveTokensForAgent(text, inlineTokens) : text
    const display = hasTokens ? { content: text, tokens: inlineTokens } : undefined

    // 指令文件/项目提示词已在 createAgent 时 append 进系统提示词（Agent 首次发言时才创建，
    // 所以"发送第一条消息前调整配置"的语义保持不变）。

    // 有根会话的用户消息不由网关落库：harness 在 message_end 把它作为 entry 追加，
    // 并经 HarnessSession 的事件翻译广播 user_message。
    // 发送结果原样上交：子会话的驱动方靠它区分「没发出去」与「发出去了没回话」
    return await session.prompt(promptText, images, display)
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
   * 三条队列共用的入队骨架。
   *
   * 只入队：消息在 pi 队列里等着，被 drain 时才由 harness 落盘，
   * 落盘与广播都在 message_end 事件里发生，网关不碰。
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
   * 以下两个 setter 是模型类运行配置的**唯一写入口**（数据库已无对应列）。
   *
   * Agent 已创建 → 交给 harness，它自己往会话树追加 change entry；
   * Agent 未创建（会话是懒创建的，用户可以在没发过消息的会话上先切模型）→
   * 直接往树上追加，不为了记一次配置而把整个 Agent 拉起来。
   */
  async setModel(
    sessionId: string,
    provider: string,
    model: string,
    baseUrl?: string,
    apiProtocol?: string
  ): Promise<void> {
    const agent = sessionService.getAgentSession(sessionId)
    if (agent) await agent.setModel(provider, model, baseUrl, apiProtocol)
    else await appendModelChange(sessionId, provider, model)
  }

  async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
    const agent = sessionService.getAgentSession(sessionId)
    if (agent) await agent.setThinkingLevel(level)
    else await appendThinkingLevelChange(sessionId, level)
  }

  /**
   * Agent 运行时快照。默认只读已存在的 Agent（未创建返回 null）；
   * ensure=true 走懒创建路径（没发过消息也要看到真实配置的调用方用）—— 构造运行时不请求 LLM。
   */
  async getAgentInfo(
    sessionId: string,
    options?: { ensure?: boolean }
  ): Promise<AgentRuntimeInfo | null> {
    const agent = options?.ensure
      ? await sessionService.ensureAgentSession(sessionId)
      : sessionService.getAgentSession(sessionId)
    return (await agent?.getRuntimeInfo()) ?? null
  }

  // ─── 消息操作 ─────────────────────────────────

  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    return await messageService.listBySession(sessionId)
  }

  async clearMessages(sessionId: string): Promise<void> {
    // 先关停写者再删文件：还在跑的 run 会往刚删掉的会话树里接着写
    await sessionService.invalidateAgent(sessionId)
    messageService.clear(sessionId)
  }

  /**
   * 回退到某条消息之前：entry 树上把 leaf 移到它的父节点（历史保留，可再切回）。
   *
   * **顺序是关键**：先把旧运行时彻底关停并解绑，再动叶子。反过来（旧实现）等于在一个
   * 还在写的 run 脚下抽走叶子 —— 它接下来的消息会挂到回退后的分支上，和新 run 交叉，
   * 把 tool_use/tool_result 的配对写坏，之后每一发请求都被 provider 打回。
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

    if (runtimeId === 'ssh') {
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

  listTools(sessionId?: string): Array<{
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
      const session = sessionDao.findById(sessionId)
      const project = session?.projectId ? projectDao.pick(session.projectId, ['path']) : null
      projectPath = project?.path
    }
    // 默认勾选 = 这条会话根 Agent 档案的白名单：档案由会话形态推导（项目 work / 无项目 chat /
    // 笔记本 notebook / bot 会话 bot，子会话可能被父级钉成 coding），含用户 ~/.shuvix/agents/<name>.md
    // 覆盖 —— 覆盖后会话真的按它创建，UI 的默认勾选就该跟着走。没有会话回落 work
    const profileName = sessionId
      ? sessionService.resolveAgentProfileName(sessionId)
      : WORK_PROFILE_NAME
    const profile = agentService.getProfile(profileName)
    const defaultProfileTools = profile?.tools ?? []
    // 档案声明的 mcp:/skill: 项对这条会话恒生效（createAgent 的名单归一），选择器据此画成已勾、锁住；
    // 值是档案显示名，悬停时说「谁声明的」—— 要去掉只能覆盖那份档案，会话里取消不了
    const declared = new Set(defaultProfileTools)
    const declaredBy = (name: string): string | undefined =>
      declared.has(name) ? profile?.displayName || profileName : undefined
    /** 内置工具（从注册表读取，system 分组不在 UI 中展示） */
    const builtinTools = getBuiltinToolEntries()
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

    /** MCP 工具 */
    const mcpTools = mcpService.getAllToolInfos().map((info) => ({
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
