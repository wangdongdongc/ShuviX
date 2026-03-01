import { ipcMain } from 'electron'
import { chatGateway, operationContext, createElectronContext } from '../frontend'
import type {
  AgentInitParams,
  AgentPromptParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams
} from '../types'

/**
 * Agent 相关 IPC 处理器
 * 所有操作均通过 sessionId 指定目标 Agent，委托给 ChatGateway
 */
export function registerAgentHandlers(): void {
  /** 初始化指定 session 的 Agent（后端自行查询所有所需信息） */
  ipcMain.handle('agent:init', (_event, params: AgentInitParams) =>
    operationContext.run(createElectronContext(params.sessionId), () =>
      chatGateway.initAgent(params.sessionId)
    )
  )

  /** 向指定 session 发送消息（支持附带图片） */
  ipcMain.handle('agent:prompt', (_event, params: AgentPromptParams) =>
    operationContext.run(createElectronContext(params.sessionId), async () => {
      await chatGateway.prompt(params.sessionId, params.text, params.images)
      return { success: true }
    })
  )

  /** 中止指定 session 的生成（若已有部分内容，后端统一落库并返回） */
  ipcMain.handle('agent:abort', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () =>
      chatGateway.abort(sessionId)
    )
  )

  /** 切换指定 session 的模型 */
  ipcMain.handle('agent:setModel', (_event, params: AgentSetModelParams) =>
    operationContext.run(createElectronContext(params.sessionId), () => {
      chatGateway.setModel(
        params.sessionId,
        params.provider,
        params.model,
        params.baseUrl,
        params.apiProtocol
      )
      return { success: true }
    })
  )

  /** 设置指定 session 的思考深度 */
  ipcMain.handle('agent:setThinkingLevel', (_event, params: AgentSetThinkingLevelParams) =>
    operationContext.run(createElectronContext(params.sessionId), () => {
      chatGateway.setThinkingLevel(params.sessionId, params.level)
      return { success: true }
    })
  )

  /** 响应工具审批请求（沙箱模式下 bash 命令需用户确认） */
  ipcMain.handle(
    'agent:approveToolCall',
    (_event, params: { toolCallId: string; approved: boolean; reason?: string }) =>
      operationContext.run(createElectronContext(), () => {
        chatGateway.approveToolCall(params.toolCallId, params.approved, params.reason)
        return { success: true }
      })
  )

  /** 响应 ask 工具的用户选择 */
  ipcMain.handle(
    'agent:respondToAsk',
    (_event, params: { toolCallId: string; selections: string[] }) =>
      operationContext.run(createElectronContext(), () => {
        chatGateway.respondToAsk(params.toolCallId, params.selections)
        return { success: true }
      })
  )

  /** 响应 SSH 凭据输入（凭据不经过大模型，直接传给 sshManager） */
  ipcMain.handle(
    'agent:respondToSshCredentials',
    (
      _event,
      params: {
        toolCallId: string
        credentials: {
          host: string
          port: number
          username: string
          password?: string
          privateKey?: string
          passphrase?: string
        } | null
      }
    ) =>
      operationContext.run(createElectronContext(), () => {
        chatGateway.respondToSshCredentials(params.toolCallId, params.credentials)
        return { success: true }
      })
  )

  /** 动态更新指定 session 的启用工具集 */
  ipcMain.handle(
    'agent:setEnabledTools',
    (_event, params: { sessionId: string; tools: string[] }) =>
      operationContext.run(createElectronContext(params.sessionId), () => {
        chatGateway.setEnabledTools(params.sessionId, params.tools)
        return { success: true }
      })
  )

  /** 获取所有可用工具列表（名称 + 标签 + 可选分组） */
  ipcMain.handle('tools:list', () =>
    operationContext.run(createElectronContext(), () =>
      chatGateway.listTools()
    )
  )
}
