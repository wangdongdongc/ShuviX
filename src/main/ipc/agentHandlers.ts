import { ipcMain } from 'electron'
import { agentService, dbMessagesToAgentMessages } from '../services/agent'
import { sessionDao } from '../dao/sessionDao'
import { providerDao } from '../dao/providerDao'
import { projectDao } from '../dao/projectDao'
import { settingsDao } from '../dao/settingsDao'
import { messageDao } from '../dao/messageDao'
import type { AgentInitParams, AgentInitResult, AgentPromptParams, AgentSetModelParams, AgentSetThinkingLevelParams, ModelCapabilities } from '../types'

/**
 * Agent 相关 IPC 处理器
 * 所有操作均通过 sessionId 指定目标 Agent
 */
export function registerAgentHandlers(): void {
  /** 初始化指定 session 的 Agent（后端自行查询所有所需信息） */
  ipcMain.handle('agent:init', (_event, params: AgentInitParams): AgentInitResult => {
    const { sessionId } = params

    // 查询会话信息
    const session = sessionDao.findById(sessionId)
    if (!session) {
      return { success: false, provider: '', model: '', capabilities: {}, modelMetadata: '' }
    }

    const provider = session.provider || ''
    const model = session.model || ''

    // 查询提供商信息
    const providerInfo = providerDao.findById(provider)

    // 查询项目信息
    const project = session.projectId ? projectDao.findById(session.projectId) : undefined

    // 合并 system prompt：全局 + 项目级
    const globalPrompt = settingsDao.findByKey('systemPrompt') || ''
    let mergedPrompt = globalPrompt
    if (project?.systemPrompt) {
      mergedPrompt = `${globalPrompt}\n\n${project.systemPrompt}`
    }

    // 查询模型能力
    const modelRow = providerDao.findModelsByProvider(provider).find((m) => m.modelId === model)
    const capabilities: ModelCapabilities = modelRow?.capabilities ? JSON.parse(modelRow.capabilities) : {}

    // 创建 Agent（已存在且配置不变时跳过）
    const created = agentService.createAgent(
      sessionId,
      provider,
      model,
      mergedPrompt,
      project?.path || undefined,
      project ? project.dockerEnabled === 1 : false,
      project?.dockerImage || undefined,
      providerInfo?.apiKey || undefined,
      providerInfo?.baseUrl || undefined,
      (providerInfo as any)?.apiProtocol || undefined
    )

    // 仅新建 Agent 时恢复历史消息（正确处理 tool_call / tool_result / 图片等类型）
    if (created) {
      const msgs = messageDao.findBySessionId(sessionId)
      if (msgs.length > 0) {
        const agentMessages = dbMessagesToAgentMessages(msgs)
        for (const msg of agentMessages) {
          agentService.getMessages(sessionId).push(msg)
        }
      }
    }

    return {
      success: true,
      provider,
      model,
      capabilities,
      modelMetadata: session.modelMetadata || ''
    }
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
