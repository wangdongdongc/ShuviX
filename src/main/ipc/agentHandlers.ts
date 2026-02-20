import { ipcMain } from 'electron'
import { agentService } from '../services/agent'
import type { AgentInitParams, AgentInitResult, AgentPromptParams, AgentSetModelParams, AgentSetThinkingLevelParams } from '../types'

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
}
