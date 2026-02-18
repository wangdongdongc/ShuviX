import { ipcMain } from 'electron'
import { agentService } from '../services/agent'
import type { AgentInitParams, AgentPromptParams, AgentSetModelParams, AgentSetThinkingLevelParams } from '../types'

/**
 * Agent 相关 IPC 处理器
 * 所有操作均通过 sessionId 指定目标 Agent
 */
export function registerAgentHandlers(): void {
  /** 初始化指定 session 的 Agent */
  ipcMain.handle('agent:init', (_event, params: AgentInitParams) => {
    const created = agentService.createAgent(
      params.sessionId,
      params.provider,
      params.model,
      params.systemPrompt,
      params.workingDirectory,
      params.dockerEnabled,
      params.dockerImage,
      params.apiKey,
      params.baseUrl,
      params.apiProtocol
    )

    // 仅新建 Agent 时恢复历史消息，避免切换回已有会话时重复追加
    if (created && params.messages && params.messages.length > 0) {
      const agentMessages = params.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: [{ type: 'text' as const, text: m.content }],
        timestamp: Date.now()
      }))
      for (const msg of agentMessages) {
        agentService.getMessages(params.sessionId).push(msg as any)
      }
    }

    return { success: true }
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
