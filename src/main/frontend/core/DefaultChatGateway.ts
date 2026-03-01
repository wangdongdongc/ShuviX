import type { ChatGateway } from './ChatGateway'
import type { AgentInitResult, MessageAddParams, Message, ThinkingLevel } from '../../types'
import type { SshCredentialPayload } from '../../tools/types'
import { agentService, ALL_TOOL_NAMES } from '../../services/agent'
import { messageService } from '../../services/messageService'
import { dockerManager } from '../../services/dockerManager'
import { sshManager } from '../../services/sshManager'
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

  initAgent(sessionId: string): AgentInitResult {
    const result = agentService.createAgent(sessionId)
    operationLogService.log('initAgent', '')
    return result
  }

  async prompt(
    sessionId: string,
    text: string,
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  ): Promise<void> {
    const preview = text.length > 80 ? text.slice(0, 80) + '...' : text
    operationLogService.log('prompt', preview)
    await agentService.prompt(sessionId, text, images)
  }

  abort(sessionId: string): { success: boolean; savedMessage?: Message } {
    const savedMessage = agentService.abort(sessionId)
    operationLogService.log('abort', '')
    return { success: true, savedMessage: savedMessage || undefined }
  }

  // ─── 交互响应 ─────────────────────────────────

  approveToolCall(toolCallId: string, approved: boolean, reason?: string): void {
    agentService.approveToolCall(toolCallId, approved, reason)
    operationLogService.log(
      'approveToolCall',
      `${approved ? 'approved' : 'rejected'}${reason ? `: ${reason}` : ''}`
    )
  }

  respondToAsk(toolCallId: string, selections: string[]): void {
    agentService.respondToAsk(toolCallId, selections)
  }

  respondToSshCredentials(toolCallId: string, credentials: SshCredentialPayload | null): void {
    agentService.respondToSshCredentials(toolCallId, credentials)
  }

  // ─── 运行时调整 ────────────────────────────────

  setModel(
    sessionId: string,
    provider: string,
    model: string,
    baseUrl?: string,
    apiProtocol?: string
  ): void {
    agentService.setModel(sessionId, provider, model, baseUrl, apiProtocol)
    operationLogService.log('setModel', `${provider} / ${model}`)
  }

  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    agentService.setThinkingLevel(sessionId, level)
    operationLogService.log('setThinkingLevel', level)
  }

  setEnabledTools(sessionId: string, tools: string[]): void {
    agentService.setEnabledTools(sessionId, tools)
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
    agentService.invalidateAgent(sessionId)
  }

  deleteFromMessage(sessionId: string, messageId: string): void {
    messageService.deleteFromMessage(sessionId, messageId)
    agentService.invalidateAgent(sessionId)
  }

  // ─── 资源操作 ──────────────────────────────────

  getDockerStatus(sessionId: string): { containerId: string; image: string } | null {
    return dockerManager.getContainerInfo(sessionId)
  }

  async destroyDocker(sessionId: string): Promise<{ success: boolean }> {
    const containerId = await dockerManager.destroyContainer(sessionId)
    if (containerId) {
      const msg = messageService.add({
        sessionId,
        role: 'system_notify',
        type: 'docker_event',
        content: 'container_destroyed',
        metadata: JSON.stringify({ containerId: containerId.slice(0, 12), reason: 'manual' })
      })
      chatFrontendRegistry.broadcast({ type: 'docker_event', sessionId, messageId: msg.id })
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
    const msg = messageService.add({
      sessionId,
      role: 'system_notify',
      type: 'ssh_event',
      content: 'ssh_disconnected',
      metadata: JSON.stringify({
        host: info.host,
        port: String(info.port),
        username: info.username,
        reason: 'manual'
      })
    })
    chatFrontendRegistry.broadcast({ type: 'ssh_event', sessionId, messageId: msg.id })
    operationLogService.log('disconnectSsh', info.host)
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
      'shuvix-project': t('tool.shuvixProjectLabel'),
      'shuvix-setting': t('tool.shuvixSettingLabel')
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
      'shuvix-project': t('tool.shuvixProjectHint'),
      'shuvix-setting': t('tool.shuvixSettingHint')
    }
    const builtinTools = ALL_TOOL_NAMES.map((name) => ({
      name,
      label: labelMap[name] || name,
      hint: hintMap[name],
      group: undefined as string | undefined
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
