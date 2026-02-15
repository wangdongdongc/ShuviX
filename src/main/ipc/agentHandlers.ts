import { ipcMain } from 'electron'
import { agentService } from '../services/agent'
import type { AgentInitParams, AgentPromptParams, AgentSetModelParams } from '../types'

/**
 * Agent 相关 IPC 处理器
 * 所有操作均通过 sessionId 指定目标 Agent
 */
export function registerAgentHandlers(): void {
  /** 初始化指定 session 的 Agent */
  ipcMain.handle('agent:init', (_event, params: AgentInitParams) => {
    agentService.createAgent(
      params.sessionId,
      params.provider,
      params.model,
      params.systemPrompt,
      params.apiKey,
      params.baseUrl
    )

    // 如果有历史消息，恢复到 Agent 状态
    if (params.messages && params.messages.length > 0) {
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

  /** 向指定 session 发送消息 */
  ipcMain.handle('agent:prompt', async (_event, params: AgentPromptParams) => {
    await agentService.prompt(params.sessionId, params.text)
    return { success: true }
  })

  /** 中止指定 session 的生成 */
  ipcMain.handle('agent:abort', (_event, sessionId: string) => {
    agentService.abort(sessionId)
    return { success: true }
  })

  /** 切换指定 session 的模型 */
  ipcMain.handle('agent:setModel', (_event, params: AgentSetModelParams) => {
    agentService.setModel(params.sessionId, params.provider, params.model, params.baseUrl)
    return { success: true }
  })
}
