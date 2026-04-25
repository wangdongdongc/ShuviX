import { ipcMain } from 'electron'
import { chatGateway, operationContext, createElectronContext } from '../frontend'
import { getBuiltinToolPresentations } from '../services/toolRegistry'
import { subAgentManager } from '../subagent/SubAgentManager'
import type {
  AgentInitParams,
  AgentPromptParams,
  AgentSteerParams,
  AgentSetModelParams,
  AgentSetThinkingLevelParams
} from '../types'
import type { InputResponse } from '../../shared/types/inputRequest'

/**
 * Agent 相关 IPC 处理器
 * 所有操作均通过 sessionId 指定目标 Agent，委托给 ChatGateway
 */
export function registerAgentHandlers(): void {
  /** 开启对话（后端自行查询所有所需信息） */
  ipcMain.handle('agent:init', (_event, params: AgentInitParams) =>
    operationContext.run(createElectronContext(params.sessionId), () =>
      chatGateway.startChat(params.sessionId)
    )
  )

  /** 向指定 session 发送消息（支持附带图片） */
  ipcMain.handle('agent:prompt', (_event, params: AgentPromptParams) =>
    operationContext.run(createElectronContext(params.sessionId), async () => {
      await chatGateway.prompt(params.sessionId, params.text, params.images, params.inlineTokens)
      return { success: true }
    })
  )

  /** 向运行中的 Agent 发送 steer 消息（引导/纠正方向） */
  ipcMain.handle('agent:steer', (_event, params: AgentSteerParams) =>
    operationContext.run(createElectronContext(params.sessionId), () => {
      chatGateway.steer(params.sessionId, params.text)
      return { success: true }
    })
  )

  /** 中止指定 session 的生成（若已有部分内容，后端统一落库并返回） */
  ipcMain.handle('agent:abort', (_event, sessionId: string) =>
    operationContext.run(createElectronContext(sessionId), () => chatGateway.abort(sessionId))
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

  /**
   * 统一的"用户输入响应"入口。
   * 命令审批 / 选择题 / SSH 凭证 / 用户取消都通过该方法路由,
   * 后端根据 InputResponse.kind 分发给对应的工具挂起 Promise。
   */
  ipcMain.handle(
    'agent:respondToInput',
    (_event, params: { sessionId: string; requestId: string; response: InputResponse }) =>
      operationContext.run(createElectronContext(params.sessionId), () => {
        chatGateway.respondToInput(params.sessionId, params.requestId, params.response)
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

  /** 获取所有可用工具列表（名称 + 标签 + 可选分组，传 sessionId 时包含项目级 skills） */
  ipcMain.handle('tools:list', (_event, sessionId?: string) =>
    operationContext.run(createElectronContext(sessionId), () => chatGateway.listTools(sessionId))
  )

  /** 获取所有工具的 UI 渲染配置（图标、摘要字段、表单项等） */
  ipcMain.handle('tools:presentations', () => getBuiltinToolPresentations())

  /**
   * 销毁指定的临时子会话（用户点关闭按钮触发）。
   * 中止子 Agent 并从 transientSessionRegistry 移除。
   */
  ipcMain.handle('subSession:destroy', (_event, subSessionId: string) => {
    subAgentManager.destroy(subSessionId)
    return { success: true }
  })
}
