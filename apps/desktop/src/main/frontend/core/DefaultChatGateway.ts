import type { ChatGateway } from './ChatGateway'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import type { AgentInitResult, AgentRuntimeInfo, ThinkingLevel } from '../../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { sessionService } from '../../services/sessionService'
import { botService } from '../../services/botService'
import type { AgentSession } from '../../services/agentSession'
import '../../tools/allTools'
import { getBuiltinToolEntries } from '../../services/toolRegistry'
import { messageService } from '../../services/messageService'
import {
  appendActiveToolsChange,
  appendModelChange,
  appendThinkingLevelChange
} from '../../services/sessionStorage'
import { respondToUserInput } from '../../services/userInputBroker'
import { sshManager } from '../../services/sshManager'
import { dbManager } from '../../services/dbManager'
import { mcpService } from '../../services/mcpService'
import { skillService } from '../../services/skillService'
import type { ChatMessage, InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { sessionDao } from '../../dao/sessionDao'
import { projectDao } from '../../dao/projectDao'
import { DEFAULT_PROFILE_NAME } from '@shuvix/agent-runtime'
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
  ): Promise<void> {
    // 聊天会话没有根 Agent：消息交给成员各自的管线。分流必须在 ensureAgentSession
    // **之前**，也必须是 early-return 式互斥 —— 前端的 user_message 走 addMessage
    // （同 id 已存在则整体 no-op，不是 upsert），两边都跑一点会出双气泡且不被去重
    if (sessionService.isBotSession(sessionId)) {
      await botService.handleUserMessage({ sessionId, text, images, inlineTokens })
      return
    }
    // 首次发送消息时才创建 Agent（打开会话/笔记本不创建）
    const session = await sessionService.ensureAgentSession(sessionId)
    if (!session) {
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
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
    // 并经 HarnessSession 的事件翻译广播 user_message。聊天会话没有那个运行时，
    // 由上面分流出去的 botService 走同一顺序自己落（先 append 取 id 再广播）。
    await session.prompt(promptText, images, display)
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
    // 聊天会话恒无根 Agent —— 引导/追加/下一轮对它没有意义，安静退出。
    // 报「Agent 未初始化」是把一个正常形态说成故障（这三个按钮的隐藏归 A2）
    if (sessionService.isBotSession(sessionId)) return
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
    if (sessionService.isBotSession(sessionId)) await botService.abortSession(sessionId)
    return { success: true }
  }

  // ─── 交互响应 ─────────────────────────────────

  respondToInput(_sessionId: string, requestId: string, response: InputResponse): void {
    // broker 按 requestId 找归属（有根会话 / 聊天会话各自认领）；sessionId 参数仅作日志。
    // 用它来选参与方等于把前端以为的归属当成真相
    respondToUserInput(requestId, response)
  }

  // ─── 运行时调整 ────────────────────────────────

  /**
   * 以下三个 setter 是运行配置的**唯一写入口**（数据库已无对应列）。
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

  async setEnabledTools(sessionId: string, tools: string[]): Promise<void> {
    const agent = sessionService.getAgentSession(sessionId)
    if (agent) await agent.setEnabledTools(tools)
    else await appendActiveToolsChange(sessionId, tools)
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
    // 先关停写者再删文件：还在跑的 run 会往刚删掉的会话树里接着写。
    // 两条写者路径并列停：有根会话是 AgentSession，聊天会话是 botService 的树写锁
    // （对另一形态各自是 no-op，无脑并列安全）
    await sessionService.invalidateAgent(sessionId)
    await botService.abortSession(sessionId)
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
    await botService.abortSession(sessionId)
    await messageService.applyRollback(sessionId, target.targetId)
  }

  // ─── 运行时资源 ──────────────────────────────────

  getRuntimeStatuses(sessionId: string): Record<string, RuntimeStatus> {
    const result: Record<string, RuntimeStatus> = {}

    const ssh = sshManager.getConnectionInfo(sessionId)
    if (ssh) {
      result['ssh'] = {
        label: `${ssh.username}@${ssh.host}`,
        icon: 'Terminal',
        color: '#38bdf8'
      }
    }

    const db = dbManager.getConnectionInfo(sessionId)
    if (db) {
      result['db'] = {
        label: `${db.dbType} ${db.database}`,
        icon: 'Database',
        color: '#f59e0b',
        description: db.host
      }
    }

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
      if (!sshManager.getConnectionInfo(sessionId)) return { success: false }
      await sshManager.disconnect(sessionId)
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
  }> {
    // 解析项目路径（用于发现项目级 skills）
    let projectPath: string | undefined
    if (sessionId) {
      const session = sessionDao.findById(sessionId)
      const project = session?.projectId ? projectDao.pick(session.projectId, ['path']) : null
      projectPath = project?.path
    }
    // 新会话的默认工具集 = default 档案的白名单（含用户 ~/.shuvix/agents/default.md 覆盖 ——
    // 覆盖后新会话真的按它创建，UI 的默认勾选就该跟着走）
    const defaultProfileTools = agentService.getProfile(DEFAULT_PROFILE_NAME)?.tools ?? []
    /** 内置工具（从注册表读取，system 分组不在 UI 中展示） */
    const builtinTools = getBuiltinToolEntries()
      .filter((e) => e.group !== 'system' && !e.hidden)
      .map((e) => ({
        name: e.name,
        label: e.getLabel(),
        hint: e.getHint(),
        group: e.group,
        // wire 契约保留：defaultEnabled 由 default 档案清单派生（注册表字段已退役）
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
      isBuiltin: info.isBuiltin
    }))
    /** 已启用 Skill（含项目级 .claude/skills/） */
    const skillItems = skillService.findEnabled(projectPath).map((s) => ({
      name: `skill:${s.name}`,
      label: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
      group: '__skills__'
    }))
    return [...merged, ...mcpTools, ...skillItems]
  }
}

/** 全局单例 */
export const chatGateway = new DefaultChatGateway()
