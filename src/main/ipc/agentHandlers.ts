import { ipcMain } from 'electron'
import { agentService } from '../services/agent'
import type { AgentInitParams, AgentSetModelParams } from '../types'

/**
 * Agent 相关 IPC 处理器
 * 负责 Agent 初始化、消息发送、中止、模型切换
 */
export function registerAgentHandlers(): void {
  /** 初始化 Agent（切换会话时调用） */
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
        agentService.getMessages().push(msg as any)
      }
    }

    return { success: true }
  })

  /** 发送消息 */
  ipcMain.handle('agent:prompt', async (_event, text: string) => {
    await agentService.prompt(text)
    return { success: true }
  })

  /** 中止生成 */
  ipcMain.handle('agent:abort', () => {
    agentService.abort()
    return { success: true }
  })

  /** 切换模型 */
  ipcMain.handle('agent:setModel', (_event, params: AgentSetModelParams) => {
    agentService.setModel(params.provider, params.model, params.baseUrl)
    return { success: true }
  })
}
