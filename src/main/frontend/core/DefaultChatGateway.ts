import type { ChatGateway } from './ChatGateway'
import type { RuntimeStatus } from './types'
import type { AgentInitResult, MessageAddParams, Message, ThinkingLevel } from '../../types'
import type { InputResponse } from '../../../shared/types/inputRequest'
import { sessionService } from '../../services/sessionService'
import '../../tools/allTools'
import { getBuiltinToolEntries } from '../../tools/registry'
import { messageService } from '../../services/messageService'
import { dockerManager } from '../../services/dockerManager'
import { sshManager } from '../../services/sshManager'
import { dbManager } from '../../services/dbManager'
import { mcpService } from '../../services/mcpService'
import { skillService } from '../../services/skillService'
import { pluginRegistry } from '../../services/pluginRegistry'
import { subAgentRegistry } from '../../subagent'
import type { InlineToken } from '../../../shared/types/chatMessage'
import { resolveTokensForAgent } from '../../../shared/utils/inlineTokens'
import { sessionDao } from '../../dao/sessionDao'
import { projectDao } from '../../dao/projectDao'
import { chatFrontendRegistry } from './ChatFrontendRegistry'

/**
 * ChatGateway 默认实现 — 聚合 Service 层，提供统一的会话级操作入口
 */
export class DefaultChatGateway implements ChatGateway {
  // ─── Agent 对话 ──────────────────────────────

  startChat(sessionId: string): AgentInitResult {
    return sessionService.initAgent(sessionId)
  }

  async prompt(
    sessionId: string,
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>,
    inlineTokens?: Record<string, InlineToken>
  ): Promise<void> {
    const session = sessionService.getAgentSession(sessionId)
    if (!session) {
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }

    // ─── 内联 Token 处理（由前端完成展开，后端直接使用） ───
    const promptText = inlineTokens ? resolveTokensForAgent(text, inlineTokens) : text

    // 首次发言前按当前配置懒注入项目指令文件
    // 必须发生在 addUserText 之前，确保指令消息在时间戳和广播顺序上都早于用户消息
    session.ensureInstructionsInjected()

    // 统一持久化用户消息并通知所有前端
    const userImages =
      images && images.length > 0
        ? images.map((img) => ({
            mimeType: img.mimeType,
            preview: `data:${img.mimeType};base64,${img.data}`
          }))
        : undefined
    const userMsg = messageService.addUserText({
      sessionId,
      content: text,
      images: userImages,
      inlineTokens: inlineTokens
    })
    chatFrontendRegistry.broadcast({
      type: 'user_message',
      sessionId,
      message: JSON.stringify(userMsg)
    })
    // 发送展开后的 prompt 给 Agent
    await session.prompt(promptText, images)
  }

  steer(sessionId: string, text: string): void {
    const session = sessionService.getAgentSession(sessionId)
    if (!session) {
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }
    // 只入队；持久化和广播交给 agentEventHandler 在 message_end 事件中处理，
    // 确保 steer 消息在 event 流中的位置与 step/tool 消息自然衔接。
    session.steer(text)
  }

  abort(sessionId: string): { success: boolean; savedMessage?: Message } {
    const savedMessage = sessionService.getAgentSession(sessionId)?.abort() || null
    return { success: true, savedMessage: savedMessage || undefined }
  }

  // ─── 交互响应 ─────────────────────────────────

  respondToInput(_sessionId: string, requestId: string, response: InputResponse): void {
    // sessionService 在内部遍历所有 session 找到归属;sessionId 参数仅作日志/校验
    sessionService.respondToInput(requestId, response)
  }

  // ─── 运行时调整 ────────────────────────────────

  setModel(
    sessionId: string,
    provider: string,
    model: string,
    baseUrl?: string,
    apiProtocol?: string
  ): void {
    sessionService.getAgentSession(sessionId)?.setModel(provider, model, baseUrl, apiProtocol)
  }

  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    sessionService.getAgentSession(sessionId)?.setThinkingLevel(level)
  }

  setEnabledTools(sessionId: string, tools: string[]): void {
    sessionService.getAgentSession(sessionId)?.setEnabledTools(tools)
  }

  // ─── 消息操作 ─────────────────────────────────

  listMessages(sessionId: string): Message[] {
    return messageService.listBySession(sessionId)
  }

  addMessage(params: MessageAddParams): Message {
    return messageService.add(params)
  }

  clearMessages(sessionId: string): void {
    messageService.clear(sessionId)
  }

  rollbackMessage(sessionId: string, messageId: string): void {
    messageService.rollbackToMessage(sessionId, messageId)
    sessionService.invalidateAgent(sessionId)
  }

  deleteFromMessage(sessionId: string, messageId: string): void {
    messageService.deleteFromMessage(sessionId, messageId)
    sessionService.invalidateAgent(sessionId)
  }

  // ─── 运行时资源 ──────────────────────────────────

  getRuntimeStatuses(sessionId: string): Record<string, RuntimeStatus> {
    const result: Record<string, RuntimeStatus> = {}

    const docker = dockerManager.getContainerInfo(sessionId)
    if (docker) {
      result['docker'] = {
        label: docker.image,
        icon: 'Container',
        color: '#10b981',
        description: docker.containerId.slice(0, 12)
      }
    }

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

    const pluginRuntimes = pluginRegistry.getRuntimeStatuses(sessionId)
    for (const [runtimeId, info] of Object.entries(pluginRuntimes)) {
      result[runtimeId] = info
    }

    // ACP sessions are event-driven only (no central status store)

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

    if (runtimeId === 'docker') {
      const containerId = await dockerManager.destroyContainer(sessionId)
      if (containerId) broadcastDestroy()
      return { success: !!containerId }
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
    if (runtimeId.startsWith('acp:')) {
      subAgentRegistry.get(runtimeId.slice(4))?.destroy(sessionId)
      broadcastDestroy()
      return { success: true }
    }
    // Plugin runtimes
    pluginRegistry.dispatchEvent({ type: 'runtime:destroy', sessionId, runtimeId })
    return { success: true }
  }

  // ─── 工具发现 ──────────────────────────────────

  listTools(sessionId?: string): Array<{
    name: string
    label: string
    hint?: string
    group?: string
    defaultEnabled?: boolean
    serverStatus?: string
  }> {
    // 解析项目路径（用于发现项目级 skills）
    let projectPath: string | undefined
    if (sessionId) {
      const session = sessionDao.findById(sessionId)
      const project = session?.projectId ? projectDao.pick(session.projectId, ['path']) : null
      projectPath = project?.path
    }
    /** 内置工具（从注册表读取，system 分组不在 UI 中展示） */
    const builtinTools = getBuiltinToolEntries()
      .filter((e) => e.group !== 'system' && !e.hidden)
      .map((e) => ({
        name: e.name,
        label: e.getLabel(),
        hint: e.getHint(),
        group: e.group,
        defaultEnabled: e.defaultEnabled
      }))
    /** 插件工具（按 defaultEnabled 分为两组，分别插入通用工具组不同位置） */
    const allPluginTools = pluginRegistry.getActivatedEntries().flatMap(({ contribution }) =>
      (contribution.tools ?? []).map((tool) => ({
        name: tool.name,
        label: tool.label,
        hint: tool.hint ?? tool.description.split('\n')[0],
        group: 'general' as const,
        defaultEnabled: tool.defaultEnabled !== false
      }))
    )
    const pluginDefaultOn = allPluginTools.filter((t) => t.defaultEnabled)
    const pluginDefaultOff = allPluginTools.filter((t) => !t.defaultEnabled)

    // 将默认启用的插件工具插入到 general 组 defaultEnabled=true 之后、defaultEnabled=false 之前
    let insertIdx = 0
    for (let i = builtinTools.length - 1; i >= 0; i--) {
      if (builtinTools[i].group === 'general' && builtinTools[i].defaultEnabled) {
        insertIdx = i + 1
        break
      }
    }
    const merged = [
      ...builtinTools.slice(0, insertIdx),
      ...pluginDefaultOn,
      ...builtinTools.slice(insertIdx),
      ...pluginDefaultOff
    ]

    /** MCP 工具 */
    const mcpTools = mcpService.getAllToolInfos().map((info) => ({
      name: info.name,
      label: info.label,
      group: info.group,
      serverStatus: info.serverStatus
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
