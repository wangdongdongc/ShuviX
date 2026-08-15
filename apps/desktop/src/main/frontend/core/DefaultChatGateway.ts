import type { ChatGateway } from './ChatGateway'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'
import type { AgentInitResult, AgentRuntimeInfo, Message, ThinkingLevel } from '../../types'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { sessionService } from '../../services/sessionService'
import '../../tools/allTools'
import { getBuiltinToolEntries } from '../../services/toolRegistry'
import { messageService } from '../../services/messageService'
import {
  appendActiveToolsChange,
  appendModelChange,
  appendThinkingLevelChange
} from '../../services/sessionStorage'
import { sshManager } from '../../services/sshManager'
import { dbManager } from '../../services/dbManager'
import { mcpService } from '../../services/mcpService'
import { skillService } from '../../services/skillService'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { sessionDao } from '../../dao/sessionDao'
import { projectDao } from '../../dao/projectDao'
import { agentManager } from '../../agents/AgentManager'
import { DEFAULT_PROFILE_NAME, runNotebookTask } from '@shuvix/agent-runtime'
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

    // 用户消息不再由网关落库：harness 在 message_end 把它作为 entry 追加，
    // 并经 HarnessSession 的事件翻译广播 user_message —— 单一写入点，无重复。
    await session.prompt(promptText, images, display)
  }

  /**
   * 笔记本会话发送：不走主会话，每次开启独立子智能体（fire-and-forget）。
   * 当前笔记本内容作为一条独立 user message 注入子代理上下文（在 text 之前）。
   * 进展经 sub_session_* / 流式事件呈现在右侧 Sub-agent 面板。
   */
  async notebookPrompt(
    sessionId: string,
    text: string,
    _images?: Array<{ type: 'image'; data: string; mimeType: string }>,
    inlineTokens?: Record<string, InlineToken>
  ): Promise<void> {
    const params = await sessionService.buildNotebookRunParams(sessionId)
    if (!params) {
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }
    // 信封组装 + fire-and-forget 派发由共享内核完成；此处仅供数据 + 错误落点。
    // inlineTokens（slash 命令 / skill）原样下传：内核解析为发给子代理的真实指令，并随 register 广播供面板渲染标签。
    runNotebookTask(agentManager, { sessionId, text, inlineTokens, ...params }, (error) =>
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error })
    )
  }

  steer(sessionId: string, text: string): void {
    const session = sessionService.getAgentSession(sessionId)
    if (!session) {
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }
    // 只入队；落盘与广播交给 harness 在 message_end 事件中处理。
    void session.steer(text)
  }

  async abort(sessionId: string): Promise<{ success: boolean; savedMessage?: Message }> {
    // harness 会把带 stopReason='aborted' 的部分消息正常落成 entry，
    // 不再需要网关回传「抢救出来的半条消息」。
    await sessionService.getAgentSession(sessionId)?.abort()
    return { success: true }
  }

  // ─── 交互响应 ─────────────────────────────────

  respondToInput(_sessionId: string, requestId: string, response: InputResponse): void {
    // sessionService 在内部遍历所有 session 找到归属;sessionId 参数仅作日志/校验
    sessionService.respondToInput(requestId, response)
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
   * ensure=true 走懒创建路径（会话面板 Agent 页「打开即建」）—— 构造运行时不请求 LLM。
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

  async listMessages(sessionId: string): Promise<Message[]> {
    return (await messageService.listBySession(sessionId)) as unknown as Message[]
  }

  clearMessages(sessionId: string): void {
    messageService.clear(sessionId)
    sessionService.invalidateAgent(sessionId)
  }

  /** 回退到某条消息之前：entry 树上把 leaf 移到它的父节点（历史保留，可再切回） */
  async rollbackMessage(sessionId: string, messageId: string): Promise<void> {
    await messageService.rollbackToMessage(sessionId, messageId)
    sessionService.invalidateAgent(sessionId)
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
