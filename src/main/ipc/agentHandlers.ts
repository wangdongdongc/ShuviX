import { ipcMain } from 'electron'
import { agentService, ALL_TOOL_NAMES } from '../services/agent'
import type { AgentInitParams, AgentInitResult, AgentPromptParams, AgentSetModelParams, AgentSetThinkingLevelParams } from '../types'
import { t } from '../i18n'
import { mcpService } from '../services/mcpService'
import { skillService } from '../services/skillService'

/**
 * Agent 相关 IPC 处理器
 * 所有操作均通过 sessionId 指定目标 Agent
 */
export function registerAgentHandlers(): void {
  /** 初始化指定 session 的 Agent（后端自行查询所有所需信息） */
  ipcMain.handle('agent:init', (_event, params: AgentInitParams): AgentInitResult => {
    return agentService.createAgent(params.sessionId)
  })

  /** 向指定 session 发送消息（支持附带图片） */
  ipcMain.handle('agent:prompt', async (_event, params: AgentPromptParams) => {
    await agentService.prompt(params.sessionId, params.text, params.images)
    return { success: true }
  })

  /** 中止指定 session 的生成 */
  ipcMain.handle('agent:abort', (_event, sessionId: string) => {
    agentService.abort(sessionId)
    return { success: true }
  })

  /** 切换指定 session 的模型 */
  ipcMain.handle('agent:setModel', (_event, params: AgentSetModelParams) => {
    agentService.setModel(params.sessionId, params.provider, params.model, params.baseUrl, params.apiProtocol)
    return { success: true }
  })

  /** 设置指定 session 的思考深度 */
  ipcMain.handle('agent:setThinkingLevel', (_event, params: AgentSetThinkingLevelParams) => {
    agentService.setThinkingLevel(params.sessionId, params.level)
    return { success: true }
  })

  /** 响应工具审批请求（沙箱模式下 bash 命令需用户确认） */
  ipcMain.handle('agent:approveToolCall', (_event, params: { toolCallId: string; approved: boolean; reason?: string }) => {
    agentService.approveToolCall(params.toolCallId, params.approved, params.reason)
    return { success: true }
  })

  /** 响应 ask 工具的用户选择 */
  ipcMain.handle('agent:respondToAsk', (_event, params: { toolCallId: string; selections: string[] }) => {
    agentService.respondToAsk(params.toolCallId, params.selections)
    return { success: true }
  })

  /** 动态更新指定 session 的启用工具集 */
  ipcMain.handle('agent:setEnabledTools', (_event, params: { sessionId: string; tools: string[] }) => {
    agentService.setEnabledTools(params.sessionId, params.tools)
    return { success: true }
  })

  /** 获取所有可用工具列表（名称 + 标签 + 可选分组） */
  ipcMain.handle('tools:list', () => {
    /** 内置工具 */
    const labelMap: Record<string, string> = {
      bash: t('tool.bashLabel'),
      read: t('tool.readLabel'),
      write: t('tool.writeLabel'),
      edit: t('tool.editLabel'),
      ask: t('tool.askLabel'),
      'shuvix-project': t('tool.shuvixProjectLabel'),
      'shuvix-setting': t('tool.shuvixSettingLabel')
    }
    const builtinTools = ALL_TOOL_NAMES.map((name) => ({
      name,
      label: labelMap[name] || name,
      group: undefined as string | undefined
    }))
    /** MCP 工具（带 group / serverStatus 字段用于 UI 分组和状态展示） */
    const mcpTools = mcpService.getAllToolInfos().map((info) => ({
      name: info.name,
      label: info.label,
      group: info.group,
      serverStatus: info.serverStatus
    }))
    /** 已安装 Skill（使用 skill: 前缀，__skills__ 分组） */
    const skillItems = skillService.findAll().map((s) => ({
      name: `skill:${s.name}`,
      label: s.description.length > 60 ? s.description.slice(0, 57) + '...' : s.description,
      group: '__skills__'
    }))
    return [...builtinTools, ...mcpTools, ...skillItems]
  })
}
