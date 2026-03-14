import type { ChatGateway } from './ChatGateway'
import type { AgentInitResult, MessageAddParams, Message, ThinkingLevel } from '../../types'
import type { SshCredentialPayload } from '../../tools/types'
import { sessionService } from '../../services/sessionService'
import { ALL_TOOL_NAMES } from '../../utils/tools'
import { subAgentRegistry } from '../../subagent'
import { messageService } from '../../services/messageService'
import { dockerManager } from '../../services/dockerManager'
import { sshManager } from '../../services/sshManager'
import { pythonWorkerManager } from '../../services/pythonWorkerManager'
import { sqlWorkerManager } from '../../services/sqlWorkerManager'
import { mcpService } from '../../services/mcpService'
import { skillService } from '../../services/skillService'
import { chatFrontendRegistry } from './ChatFrontendRegistry'
import { operationLogService } from '../../services/operationLogService'
import { t } from '../../i18n'

/**
 * ChatGateway 默认实现 — 聚合 Service 层，提供统一的会话级操作入口
 */
export class DefaultChatGateway implements ChatGateway {
  // ─── Agent 对话 ──────────────────────────────

  startChat(sessionId: string): AgentInitResult {
    const result = sessionService.initAgent(sessionId)
    operationLogService.log('startChat', '')
    return result
  }

  async prompt(
    sessionId: string,
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  ): Promise<void> {
    const textPreview = text.length > 80 ? text.slice(0, 80) + '...' : text
    operationLogService.log('prompt', textPreview)
    const session = sessionService.getAgentSession(sessionId)
    if (!session) {
      chatFrontendRegistry.broadcast({ type: 'error', sessionId, error: 'Agent 未初始化' })
      return
    }
    // 统一持久化用户消息并通知所有前端
    const userImages =
      images && images.length > 0
        ? images.map((img) => ({
            mimeType: img.mimeType,
            preview: `data:${img.mimeType};base64,${img.data}`
          }))
        : undefined
    const userMsg = messageService.addUserText({ sessionId, content: text, images: userImages })
    chatFrontendRegistry.broadcast({
      type: 'user_message',
      sessionId,
      message: JSON.stringify(userMsg)
    })
    await session.prompt(text, images)
  }

  abort(sessionId: string): { success: boolean; savedMessage?: Message } {
    const savedMessage = sessionService.getAgentSession(sessionId)?.abort() || null
    operationLogService.log('abort', '')
    return { success: true, savedMessage: savedMessage || undefined }
  }

  // ─── 交互响应 ─────────────────────────────────

  approveToolCall(toolCallId: string, approved: boolean, reason?: string): void {
    sessionService.approveToolCall(toolCallId, approved, reason)
    operationLogService.log(
      'approveToolCall',
      `${approved ? 'approved' : 'rejected'}${reason ? `: ${reason}` : ''}`
    )
  }

  respondToAsk(toolCallId: string, selections: string[]): void {
    sessionService.respondToAsk(toolCallId, selections)
  }

  respondToSshCredentials(toolCallId: string, credentials: SshCredentialPayload | null): void {
    sessionService.respondToSshCredentials(toolCallId, credentials)
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
    operationLogService.log('setModel', `${provider} / ${model}`)
  }

  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    sessionService.getAgentSession(sessionId)?.setThinkingLevel(level)
    operationLogService.log('setThinkingLevel', level)
  }

  setEnabledTools(sessionId: string, tools: string[]): void {
    sessionService.getAgentSession(sessionId)?.setEnabledTools(tools)
    const preview = tools.slice(0, 5).join(', ') + (tools.length > 5 ? '...' : '')
    operationLogService.log('setEnabledTools', preview)
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

  // ─── 资源操作 ──────────────────────────────────

  getDockerStatus(sessionId: string): { containerId: string; image: string } | null {
    return dockerManager.getContainerInfo(sessionId)
  }

  async destroyDocker(sessionId: string): Promise<{ success: boolean }> {
    const containerId = await dockerManager.destroyContainer(sessionId)
    if (containerId) {
      chatFrontendRegistry.broadcast({
        type: 'docker_event',
        sessionId,
        action: 'container_destroyed',
        containerId: containerId.slice(0, 12),
        reason: 'manual'
      })
      operationLogService.log('destroyDocker', containerId.slice(0, 12))
    }
    return { success: !!containerId }
  }

  getSshStatus(sessionId: string): { host: string; port: number; username: string } | null {
    return sshManager.getConnectionInfo(sessionId)
  }

  async disconnectSsh(sessionId: string): Promise<{ success: boolean }> {
    const info = sshManager.getConnectionInfo(sessionId)
    if (!info) return { success: false }
    await sshManager.disconnect(sessionId)
    chatFrontendRegistry.broadcast({
      type: 'ssh_event',
      sessionId,
      action: 'ssh_disconnected',
      host: info.host,
      port: info.port,
      username: info.username
    })
    operationLogService.log('disconnectSsh', info.host)
    return { success: true }
  }

  getPythonStatus(sessionId: string): { ready: boolean } | null {
    return pythonWorkerManager.isActive(sessionId) ? { ready: true } : null
  }

  destroyPython(sessionId: string): { success: boolean } {
    const active = pythonWorkerManager.isActive(sessionId)
    if (!active) return { success: false }
    pythonWorkerManager.terminate(sessionId)
    chatFrontendRegistry.broadcast({
      type: 'python_event',
      sessionId,
      action: 'runtime_destroyed'
    })
    operationLogService.log('destroyPython', sessionId)
    return { success: true }
  }

  getSqlStatus(sessionId: string): { ready: boolean } | null {
    return sqlWorkerManager.isActive(sessionId) ? { ready: true } : null
  }

  destroySql(sessionId: string): { success: boolean } {
    const active = sqlWorkerManager.isActive(sessionId)
    if (!active) return { success: false }
    sqlWorkerManager.terminate(sessionId)
    chatFrontendRegistry.broadcast({
      type: 'sql_event',
      sessionId,
      action: 'runtime_destroyed'
    })
    operationLogService.log('destroySql', sessionId)
    return { success: true }
  }

  // ─── 工具发现 ──────────────────────────────────

  listTools(): Array<{
    name: string
    label: string
    hint?: string
    group?: string
    serverStatus?: string
  }> {
    /** 内置工具 */
    const labelMap: Record<string, string> = {
      bash: t('tool.bashLabel'),
      read: t('tool.readLabel'),
      write: t('tool.writeLabel'),
      edit: t('tool.editLabel'),
      ask: t('tool.askLabel'),
      ls: t('tool.lsLabel'),
      grep: t('tool.grepLabel'),
      glob: t('tool.globLabel'),
      ssh: t('tool.sshLabel'),
      python: t('tool.pythonLabel'),
      sql: t('tool.sqlLabel'),
      'shuvix-project': t('tool.shuvixProjectLabel'),
      'shuvix-setting': t('tool.shuvixSettingLabel'),
      explore: t('tool.exploreLabel'),
      'claude-code': t('tool.claudeCodeLabel')
    }
    const hintMap: Record<string, string> = {
      bash: t('tool.bashHint'),
      read: t('tool.readHint'),
      write: t('tool.writeHint'),
      edit: t('tool.editHint'),
      ask: t('tool.askHint'),
      ls: t('tool.lsHint'),
      grep: t('tool.grepHint'),
      glob: t('tool.globHint'),
      ssh: t('tool.sshHint'),
      python: t('tool.pythonHint'),
      sql: t('tool.sqlHint'),
      'shuvix-project': t('tool.shuvixProjectHint'),
      'shuvix-setting': t('tool.shuvixSettingHint'),
      explore: t('tool.exploreHint'),
      'claude-code': t('tool.claudeCodeHint')
    }
    const builtinTools = ALL_TOOL_NAMES.map((name) => ({
      name,
      label: labelMap[name] || name,
      hint: hintMap[name],
      group: subAgentRegistry.isSubAgent(name)
        ? '__subagents__'
        : (undefined as string | undefined)
    }))
    /** MCP 工具 */
    const mcpTools = mcpService.getAllToolInfos().map((info) => ({
      name: info.name,
      label: info.label,
      group: info.group,
      serverStatus: info.serverStatus
    }))
    /** 已启用 Skill */
    const skillItems = skillService.findEnabled().map((s) => ({
      name: `skill:${s.name}`,
      label: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
      group: '__skills__'
    }))
    return [...builtinTools, ...mcpTools, ...skillItems]
  }
}

/** 全局单例 */
export const chatGateway = new DefaultChatGateway()
